#!/usr/bin/env python3
"""Acquire the pinned official Web runtime. Never initializes WASM or runs ASR."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = "1.13.8"
ARCHIVE_URL = "https://pub.dev/api/archives/sherpa_onnx_web-1.13.8.tar.gz"
ARCHIVE_BYTES = 4351745
ARCHIVE_SHA256 = "e25a3813eb080636280b23dd4b0098252902675158b66dceda1efba061adf5d7"
FILES = [
    {"file": "sherpa-onnx-wasm-web.js", "bytes": 93039,
     "sha256": "28f909145d93018c90c181035a008880ceaa94a72b66603dc7bb7c619714c23c"},
    {"file": "sherpa-onnx-wasm-web.wasm", "bytes": 15133855,
     "sha256": "e0d84744c39a28121f7738a161a21612788f4e8f07879a7224e74919e9831573"},
    {"file": "sherpa-onnx-asr.js", "bytes": 53867,
     "sha256": "d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178"},
]
PROVENANCE = {
    "archive_url": ARCHIVE_URL,
    "archive_bytes": ARCHIVE_BYTES,
    "archive_sha256": ARCHIVE_SHA256,
    "version": VERSION,
    "files": FILES,
    "wasm_memory": {
        "initial_bytes": 536870912,
        "maximum_bytes": 2147483648,
        "shared": False,
        "evidence": "Parsed actual WASM section 5 limits and matched runtime JS getHeapMax.",
    },
    # Asset acquisition state, not a claim about separate experiment reports.
    "status": "prepared_only_no_WASM_initialization_no_inference",
}


def check_file(filename, expected_bytes, expected_hash):
    if filename.stat().st_size != expected_bytes:
        raise ValueError(f"Unexpected size: {filename}")
    with filename.open("rb") as handle:
        actual = hashlib.file_digest(handle, "sha256").hexdigest()
    if actual != expected_hash:
        raise ValueError(f"SHA-256 mismatch: {filename}")


def verify_output(root):
    for item in FILES:
        check_file(root / item["file"], item["bytes"], item["sha256"])
    if json.loads((root / "provenance.json").read_text()) != PROVENANCE:
        raise ValueError("provenance.json differs from the pinned acquisition manifest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path,
                        default=Path(__file__).resolve().parent.parent / "web-runtime")
    parser.add_argument("--archive", type=Path,
                        help="Use a local archive instead of downloading; same hash required")
    parser.add_argument("--verify-only", action="store_true",
                        help="Read-only local verification, no network or file changes")
    args = parser.parse_args()
    root = args.output_dir.resolve()
    if args.verify_only:
        verify_output(root)
        print(json.dumps({"verified": True, "version": VERSION, "files": 3,
                          "network_used": False, "wasm_initialized": False,
                          "inference_started": False}))
        return
    root.mkdir(parents=True, exist_ok=True)
    # Extract exact allowlisted regular members only; never use extractall().
    with tempfile.TemporaryDirectory(prefix=".qwen-runtime-", dir=root) as temp:
        temp = Path(temp)
        archive = args.archive.resolve() if args.archive else temp / "runtime.tar.gz"
        if not args.archive:
            request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "qwen-research-reproducer/1"})
            with urllib.request.urlopen(request, timeout=60) as source, archive.open("wb") as target:
                total = 0
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > ARCHIVE_BYTES:
                        raise ValueError("Archive exceeded its pinned size")
                    target.write(chunk)
        check_file(archive, ARCHIVE_BYTES, ARCHIVE_SHA256)
        with tarfile.open(archive, "r:gz") as package:
            members = package.getmembers()
            for item in FILES:
                matches = [member for member in members if member.name == "assets/" + item["file"]]
                if len(matches) != 1 or not matches[0].isfile() or matches[0].size != item["bytes"]:
                    raise ValueError(f"Invalid archive member: {item['file']}")
                destination = temp / item["file"]
                with package.extractfile(matches[0]) as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                check_file(destination, item["bytes"], item["sha256"])
        # Only publish the complete verified set. These are unmodified bytes.
        for item in FILES:
            (temp / item["file"]).replace(root / item["file"])
        manifest = temp / "provenance.json"
        manifest.write_text(json.dumps(PROVENANCE, indent=2) + "\n")
        manifest.replace(root / "provenance.json")
    verify_output(root)
    print(json.dumps({"verified": True, "version": VERSION, "files": 3,
                      "output_dir": str(root), "archive_url": ARCHIVE_URL,
                      "wasm_initialized": False, "inference_started": False}))


if __name__ == "__main__":
    main()
