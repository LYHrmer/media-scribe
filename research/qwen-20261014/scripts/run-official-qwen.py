#!/usr/bin/env python3
"""Reference-free official HF Qwen3-ASR benchmark; CPU research, not browser evidence.

Use --resume to retain completed cases and retry recorded failures. A lightweight
supervisor survives a killed model worker and persists the exit status. No CER is
computed here. No model execution occurs with --help.
"""
import argparse
import datetime as dt
import gc
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import traceback

CASE_KEYS = {"id", "language", "pcm_path", "pcm_sha256", "sample_rate", "audio_seconds", "split"}
LANGUAGES = {"chinese": "Chinese", "zh": "Chinese", "english": "English", "en": "English"}
GENERATION = {"do_sample": False, "max_new_tokens": 512}
OFFLINE = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
           "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "CUDA_VISIBLE_DEVICES": "",
           "TOKENIZERS_PARALLELISM": "false"}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("w") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def memory():
    result = {"rusage_maxrss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith(("VmRSS:", "VmHWM:")):
            key, value = line.split(":", 1)
            result[key + "_kib"] = int(value.strip().split()[0])
    path = Path("/sys/fs/cgroup/memory.current")
    if path.exists():
        result["cgroup_current_bytes"] = int(path.read_text())
    return result


def oom_events():
    path = Path("/sys/fs/cgroup/memory.events")
    return dict((key, int(value)) for key, value in
                (line.split() for line in path.read_text().splitlines())) if path.exists() else {}


def failure(exc):
    message = str(exc)
    resource_failure = isinstance(exc, MemoryError) or any(term in message.lower() for term in
        ("out of memory", "can't allocate memory", "cannot allocate memory", "not enough memory"))
    return {"type": type(exc).__name__, "message": message,
            "category": "resource_failure" if resource_failure else "runtime_failure",
            "traceback": traceback.format_exc()}


def load_cases(path):
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, dict):
        if set(raw) != {"cases"}:
            raise ValueError("Inference manifest must contain only 'cases', no reference-bearing metadata")
        raw = raw["cases"]
    if not isinstance(raw, list) or not raw:
        raise ValueError("Expected nonempty case list")
    seen = set()
    for case in raw:
        if not isinstance(case, dict) or set(case) != CASE_KEYS:
            raise ValueError("Every inference case must contain exactly the seven whitelisted fields")
        for key in ("id", "language", "pcm_path", "pcm_sha256", "split"):
            if not isinstance(case[key], str) or not case[key]:
                raise ValueError(f"Expected nonempty {key}")
        if case["id"] in seen:
            raise ValueError("Duplicate case ID")
        seen.add(case["id"])
        if case["language"].lower() not in LANGUAGES or case["sample_rate"] != 16000:
            raise ValueError("Only specified Chinese/English and frozen 16000 Hz PCM are accepted")
        if not isinstance(case["audio_seconds"], (int, float)) or case["audio_seconds"] <= 0:
            raise ValueError("Invalid frozen duration")
        path = Path(case["pcm_path"])
        if path.suffix != ".f32" or not path.is_absolute() or path.stat().st_size % 4:
            raise ValueError("Expected absolute float32le .f32 PCM path")
        if sha256(path) != case["pcm_sha256"]:
            raise ValueError("PCM SHA256 mismatch: " + case["id"])
        if abs(path.stat().st_size / 4 / 16000 - case["audio_seconds"]) > 1 / 16000:
            raise ValueError("Frozen PCM duration mismatch: " + case["id"])
    return raw


def verified_assets(root, protocol):
    manifest = json.loads((root / "verified-assets.json").read_text())
    candidates = {item["name"]: item for item in protocol["candidates"]}
    expected = candidates.get("official-" + root.name)
    if expected is None or manifest["revision"] != expected["revision"]:
        raise ValueError("Model revision/directory does not match frozen protocol")
    if manifest["repository"] != "Qwen/" + root.name or expected["dtype"] != "bfloat16":
        raise ValueError("Unexpected official model repository or dtype")
    if list(root.glob("*.partial")):
        raise ValueError("Unfinished model download present")
    names = set()
    for entry in manifest["files"]:
        name = entry["name"]
        if Path(name).name != name or name in names:
            raise ValueError("Unsafe or duplicate asset filename")
        names.add(name)
        path = root / name
        if path.stat().st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
            raise ValueError("Model asset verification failed: " + name)
    if not {"config.json", "generation_config.json", "tokenizer_config.json"} <= names or not any(
            name.endswith(".safetensors") for name in names):
        raise ValueError("Incomplete model assets")
    # Prevent the loader from silently using unverified configuration/weights.
    permitted_extra = {"source-metadata.json", "verified-assets.json"}
    if {p.name for p in root.iterdir() if p.is_file()} - names - permitted_extra:
        raise ValueError("Unverified files present in model directory")
    return manifest


def deny_network(event, args):
    if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.sendto"}:
        raise RuntimeError("Network disabled in model worker: " + event)


def run_worker(args):
    os.environ.update(OFFLINE)
    sys.addaudithook(deny_network)
    output = json.loads(Path(args.output).read_text())
    try:
        protocol = json.loads(Path(args.protocol).read_text())
        settings = protocol["official_decoding"]
        if (settings["do_sample"] is not False or settings["max_new_tokens"] != 512 or
                settings["batch_size"] != 1 or settings["context_or_hotwords"] is not None):
            raise ValueError("Frozen protocol no longer matches this runner")
        cases = load_cases(args.cases)
        assets = verified_assets(Path(args.model_dir), protocol)
        if "model" in output and output["model"] != assets:
            raise ValueError("Verified asset manifest changed since earlier attempts; use a new result file")
        output["model"] = assets
        atomic_json(args.output, output)
        import numpy as np
        import torch
        import transformers
        from packaging.version import Version
        from transformers import AutoProcessor, AutoModelForMultimodalLM
        if Version(transformers.__version__) < Version("5.13.0"):
            raise ValueError("Native Qwen3 ASR requires transformers >= 5.13.0")
        torch.set_num_threads(args.num_threads)
        torch.set_num_interop_threads(1)
        output["runtime"] = {"python": sys.version, "torch": torch.__version__,
            "transformers": transformers.__version__, "numpy": np.__version__,
            "cpu_threads": torch.get_num_threads(), "interop_threads": torch.get_num_interop_threads(),
            "native_cpu_not_browser": True}
        output["phase"] = "loading_model"
        atomic_json(args.output, output)
        started = time.perf_counter()
        processor = AutoProcessor.from_pretrained(args.model_dir, local_files_only=True, trust_remote_code=False)
        model = AutoModelForMultimodalLM.from_pretrained(args.model_dir, dtype=torch.bfloat16,
            local_files_only=True, trust_remote_code=False).to("cpu").eval()
        output["load_seconds"] = time.perf_counter() - started
        output["memory_after_load"] = memory()
        output["actual_model_class"] = type(model).__name__
        output["actual_processor_class"] = type(processor).__name__
        output["generation_config"] = model.generation_config.to_dict()
        output["model_config"] = model.config.to_dict()
        parameter_dtypes = {}
        for parameter in model.parameters():
            key = str(parameter.dtype)
            parameter_dtypes[key] = parameter_dtypes.get(key, 0) + parameter.numel()
            if parameter.device.type != "cpu":
                raise ValueError("Unexpected non-CPU parameter")
        output["parameter_counts_by_dtype"] = parameter_dtypes
        output["phase"] = "inference"
        atomic_json(args.output, output)
        eos = model.generation_config.eos_token_id
        eos_ids = [eos] if isinstance(eos, int) else list(eos or [])
        for case in cases:
            record = next(item for item in output["cases"] if item["id"] == case["id"])
            if record["status"] == "complete":
                continue
            if record["status"] != "pending":
                output["retry_history"].append(dict(record))
            record.clear()
            record.update({k: v for k, v in case.items() if k != "pcm_path"})
            record.update(status="running", started_at=now(), memory_before=memory())
            atomic_json(args.output, output)
            started = time.perf_counter()
            pcm = inputs = output_ids = generated_ids = None
            try:
                if sha256(case["pcm_path"]) != case["pcm_sha256"]:
                    raise ValueError("PCM changed since manifest validation")
                pcm = np.fromfile(case["pcm_path"], dtype="<f4")
                if not len(pcm) or not np.isfinite(pcm).all():
                    raise ValueError("PCM must be finite and nonempty")
                prep_started = time.perf_counter()
                inputs = processor.apply_transcription_request(audio=pcm,
                    language=LANGUAGES[case["language"].lower()],
                    processor_kwargs={"audio_kwargs": {"sampling_rate": 16000}})
                record["input_tensor_shapes"] = {k: list(v.shape) for k, v in inputs.items()
                                                 if hasattr(v, "shape")}
                record["input_token_count"] = int(inputs["input_ids"].shape[-1])
                record["input_ids"] = inputs["input_ids"].tolist()
                record["mask_lengths"] = {k: v.to(dtype=torch.int64).sum(dim=-1).tolist()
                    for k, v in inputs.items() if "mask" in k and isinstance(v, torch.Tensor)}
                record["audio_feature_lengths"] = {k: list(v.shape) for k, v in inputs.items()
                    if ("audio" in k or "feature" in k) and hasattr(v, "shape")}
                inputs = inputs.to("cpu", torch.bfloat16)
                record["preprocess_seconds"] = time.perf_counter() - prep_started
                # Persist lengths before generation so a killed worker remains diagnosable.
                atomic_json(args.output, output)
                generation_started = time.perf_counter()
                with torch.inference_mode():
                    output_ids = model.generate(**inputs, **GENERATION)
                record["generate_seconds"] = time.perf_counter() - generation_started
                generated_ids = output_ids[:, record["input_token_count"]:]
                token_ids = generated_ids[0].tolist()
                record.update(generated_ids=token_ids, output_ids=output_ids.tolist(),
                    generated_token_count=len(token_ids), eos_token_ids=eos_ids,
                    eos_seen=any(token in eos_ids for token in token_ids),
                    last_token_is_eos=bool(token_ids and token_ids[-1] in eos_ids),
                    generation_at_requested_limit=len(token_ids) >= 512)
                record["truncated"] = record["generation_at_requested_limit"] and not record["eos_seen"]
                record["raw_text"] = processor.decode(generated_ids, clean_up_tokenization_spaces=False)[0]
                record["raw_text_with_special_tokens"] = processor.tokenizer.decode(
                    token_ids, skip_special_tokens=False, clean_up_tokenization_spaces=False)
                record["parsed"] = processor.decode(generated_ids, return_format="parsed")[0]
                record["official_processed_text"] = processor.decode(
                    generated_ids, return_format="transcription_only")[0]
                # The language tag is already in the input prefill. Generated tokens
                # are the transcript itself. The official parsed/decode helper also
                # applies repetition repair; retain that as a diagnostic, not truth.
                record["text"] = processor.tokenizer.decode(
                    token_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False)
                record["official_processing_changed_text"] = record["official_processed_text"] != record["text"]
                record["text_policy"] = "Generated tokens only, special tokens removed; no repetition repair or tokenizer space cleanup. Official processed text is diagnostic only."
                record["status"] = "complete"
            except Exception as exc:
                record.update(status="error", error=failure(exc))
            finally:
                record["elapsed_seconds"] = time.perf_counter() - started
                record["memory_after"] = memory()
                record["finished_at"] = now()
                atomic_json(args.output, output)
                print(json.dumps({k: record[k] for k in ("id", "status", "elapsed_seconds")}), flush=True)
                del pcm, inputs, output_ids, generated_ids
                gc.collect()
        output["status"] = "complete" if all(c["status"] == "complete" for c in output["cases"]) else "failed"
        output["completed_at"] = now()
        output["phase"] = "finished"
        atomic_json(args.output, output)
        return 0 if output["status"] == "complete" else 1
    except BaseException as exc:
        output.update(status="failed", failure=failure(exc), failed_at=now())
        atomic_json(args.output, output)
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--protocol", default=str(Path(__file__).resolve().parent.parent / "protocol-frozen.json"))
    parser.add_argument("--num-threads", type=int, default=2)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.num_threads < 1:
        parser.error("num-threads must be positive")
    if args.worker:
        return run_worker(args)
    # Supervisor has no torch/model imports and records abrupt worker termination.
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    import fcntl
    lock = output_path.with_name(output_path.name + ".lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    fingerprint = {"runner_sha256": sha256(__file__), "input_manifest_sha256": sha256(args.cases),
                   "protocol_sha256": sha256(args.protocol), "model_directory": str(Path(args.model_dir).resolve()),
                   "num_threads": args.num_threads}
    if output_path.exists():
        if not args.resume:
            parser.error("Output exists; choose a new output or explicitly --resume")
        output = json.loads(output_path.read_text())
        if output["fingerprint"] != fingerprint:
            parser.error("Resume fingerprint mismatch; use a new result file")
        if output["status"] == "complete":
            print("Already complete; no model loaded", flush=True)
            return 0
        output["run_history"].append({k: output[k] for k in
            ("status", "failure", "worker_returncode", "failed_at", "completed_at") if k in output})
        for key in ("failure", "worker_returncode", "failed_at", "completed_at"):
            output.pop(key, None)
        output.update(status="running", phase="resuming", resumed_at=now())
    else:
        output = {"schema_version": 1, "created_at": now(), "status": "running", "phase": "validating",
                  "fingerprint": fingerprint, "settings": {**GENERATION, "batch_size": 1,
                  "device": "cpu", "dtype": "bfloat16", "sampling_rate": 16000, "prompt": None},
                  "inference_isolation": {"reference_fields_rejected": True, "network_disabled": True,
                  "trust_remote_code": False, "local_files_only": True, "score_computed": False},
                  "cases": [], "retry_history": [], "run_history": []}
        atomic_json(output_path, output)
        try:
            cases = load_cases(args.cases)
            output["cases"] = [{**{k: v for k, v in c.items() if k != "pcm_path"}, "status": "pending"} for c in cases]
        except Exception as exc:
            output.update(status="failed", failure=failure(exc), failed_at=now())
            atomic_json(output_path, output)
            return 1
    atomic_json(output_path, output)
    before = oom_events()
    child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"],
                             env={**os.environ, **OFFLINE})
    try:
        code = child.wait()
    except KeyboardInterrupt:
        child.terminate()
        try:
            code = child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
    output = json.loads(output_path.read_text())
    after = oom_events()
    output["worker_returncode"] = code
    output["cgroup_memory_events_before"] = before
    output["cgroup_memory_events_after"] = after
    if code != 0 and output["status"] == "running":
        oom_observed = after.get("oom_kill", 0) > before.get("oom_kill", 0)
        error = {"category": "resource_failure" if oom_observed else "process_failure",
                 "message": "Model worker exited without finalizing", "returncode": code,
                 "signal": -code if code < 0 else None,
                 "cgroup_oom_kill_observed": oom_observed,
                 "note": "Cgroup counter is shared; SIGKILL alone does not establish OOM. No CER assigned."}
        output.update(status="failed", failure=error, failed_at=now())
        for case in output["cases"]:
            if case["status"] == "running":
                case.update(status="error", error=error, finished_at=now())
    if code == 0 and output["status"] != "complete":
        output.update(status="failed", failure={"category": "protocol_failure", "message": "Worker exit 0 without complete results"})
    atomic_json(output_path, output)
    print("COMPLETE" if output["status"] == "complete" else "FAILED", flush=True)
    return 0 if output["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
