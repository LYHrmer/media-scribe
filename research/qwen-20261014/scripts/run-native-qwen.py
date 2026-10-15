#!/usr/bin/env python3
"""Reference-free, pinned Qwen3-ASR INT8 native CPU benchmark. Never a web test."""
import argparse
import datetime as dt
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import sys
import time

ALLOWED_CASE_KEYS = {'id', 'language', 'pcm_path', 'pcm_sha256', 'sample_rate', 'audio_seconds', 'split'}

def sha256(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()

def memory():
    status = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        if line.startswith(('VmRSS:', 'VmHWM:')):
            k, v = line.split(':', 1)
            status[k + '_kib'] = int(v.strip().split()[0])
    status['rusage_maxrss_kib'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    status['cgroup_bytes'] = int(Path('/sys/fs/cgroup/memory.current').read_text())
    return status

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)

def load_cases(path):
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, dict):
        if set(raw) != {'cases'}:
            raise ValueError('Manifest object must contain only cases; remove reference-bearing metadata')
        raw = raw['cases']
    if not isinstance(raw, list) or not raw:
        raise ValueError('Expected a nonempty case list')
    ids = set()
    for case in raw:
        unknown = set(case) - ALLOWED_CASE_KEYS
        if unknown:
            raise ValueError(f'Unexpected fields, inference manifest must exclude references: {sorted(unknown)}')
        for key in ['id', 'language', 'pcm_path', 'pcm_sha256']:
            if not isinstance(case.get(key), str) or not case[key]:
                raise ValueError(f'Missing nonempty {key}')
        if case['id'] in ids:
            raise ValueError('Duplicate case ID')
        ids.add(case['id'])
        if int(case.get('sample_rate', 16000)) != 16000:
            raise ValueError('This runner accepts only frozen 16 kHz float32le PCM')
        if sha256(case['pcm_path']) != case['pcm_sha256']:
            raise ValueError(f'PCM hash mismatch: {case["id"]}')
        if Path(case['pcm_path']).stat().st_size % 4:
            raise ValueError('Invalid float32 PCM byte length')
    return raw

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--num-threads', type=int, default=2)
    parser.add_argument('--max-total-len', type=int, default=512)
    parser.add_argument('--max-new-tokens', type=int, default=256)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    cases = load_cases(args.cases)
    root = Path(args.model_dir)
    provenance = json.loads((root / 'download-manifest.json').read_text())
    if provenance.get('verified') is not True or len(provenance.get('files', [])) != 6:
        raise ValueError('Model download manifest incomplete')
    for entry in provenance['files']:
        path = root / entry['path']
        if path.stat().st_size != entry['bytes'] or sha256(path) != entry['sha256']:
            raise ValueError('Model SHA/size mismatch: ' + entry['path'])
    if args.verify_only:
        print(json.dumps({'verified': True, 'cases': len(cases), 'model_files': 6}))
        return

    import numpy as np
    import sherpa_onnx
    if sherpa_onnx.__version__ != '1.13.8':
        raise ValueError('Expected pinned sherpa-onnx 1.13.8')
    settings = dict(num_threads=args.num_threads, sample_rate=16000, feature_dim=128,
                    provider='cpu', decoding_method='greedy_search', debug=False,
                    max_total_len=args.max_total_len, max_new_tokens=args.max_new_tokens,
                    temperature=1e-6, top_p=0.8, seed=42, hotwords='')
    output = {
        'schema_version': 1,
        'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'status': 'running',
        'model': provenance,
        'runtime': {'sherpa_onnx': sherpa_onnx.__version__, 'git_sha1': sherpa_onnx.git_sha1,
                    'git_date': sherpa_onnx.git_date, 'onnxruntime': sherpa_onnx.onnxruntime_version,
                    'python': sys.version, 'numpy': np.__version__,
                    'native_cpu_not_browser': True},
        'settings': settings,
        'inference_isolation': {'reference_fields_rejected': True, 'media_uploaded': False,
                                'references_used_only_by_separate_scorer': True, 'hotwords': ''},
        'runner_sha256': sha256(__file__),
        'input_manifest_sha256': sha256(args.cases),
        'cases': [],
    }
    for name in ['git_sha1', 'git_date', 'onnxruntime']:
        if callable(output['runtime'][name]):
            output['runtime'][name] = output['runtime'][name]()
    atomic_json(args.output, output)
    started = time.perf_counter()
    recognizer = sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
        conv_frontend=str(root / 'conv_frontend.onnx'), encoder=str(root / 'encoder.int8.onnx'),
        decoder=str(root / 'decoder.int8.onnx'), tokenizer=str(root / 'tokenizer'), **settings)
    output['load_seconds'] = time.perf_counter() - started
    output['memory_after_load'] = memory()
    atomic_json(args.output, output)
    languages = {'chinese': 'Chinese', 'zh': 'Chinese', 'english': 'English', 'en': 'English', 'auto': ''}
    for case in cases:
        started = time.perf_counter()
        record = {'id': case['id'], 'language': case['language'], 'pcm_sha256': case['pcm_sha256']}
        try:
            pcm = np.fromfile(case['pcm_path'], dtype='<f4')
            if not np.isfinite(pcm).all() or len(pcm) == 0:
                raise ValueError('PCM must be finite and nonempty')
            record['audio_seconds'] = len(pcm) / 16000
            if 'audio_seconds' in case and abs(record['audio_seconds'] - case['audio_seconds']) > 1 / 16000:
                raise ValueError('Audio duration does not match frozen manifest')
            lang = languages[case['language'].lower()]
            stream = recognizer.create_stream()
            if lang:
                stream.set_option('language', lang)
            stream.accept_waveform(16000, pcm)
            recognizer.decode_stream(stream)
            result = stream.result
            record.update(status='complete', text=result.text, tokens=list(result.tokens),
                          timestamps=list(result.timestamps), decode_seconds=time.perf_counter() - started,
                          memory_after_decode=memory())
            record['generation_at_requested_limit'] = len(record['tokens']) >= args.max_new_tokens
            record['timestamp_note'] = 'Native returned values only; no forced aligner loaded.'
            del result, stream, pcm
        except Exception as exc:
            record.update(status='error', error=repr(exc), elapsed_seconds=time.perf_counter() - started)
        output['cases'].append(record)
        atomic_json(args.output, output)
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if record['status'] != 'complete':
            output['status'] = 'failed'
            atomic_json(args.output, output)
            return 1
    output['status'] = 'complete'
    atomic_json(args.output, output)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
