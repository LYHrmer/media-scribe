#!/usr/bin/env python3
"""Download the pinned, unchanged Sherpa 0.6B INT8 artifact; verify every byte."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent / 'models' / 'qwen3-asr-0.6B-int8'
REPO = 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25'
REVISION = '68818b2313fe77bd06f6a7c5068ff3ef59d02b8a'
FILES = {
    'conv_frontend.onnx': (44148281, 'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e'),
    'encoder.int8.onnx': (182491662, '60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9'),
    'decoder.int8.onnx': (755914231, '4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771'),
    'tokenizer/vocab.json': (2776833, 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'),
    'tokenizer/merges.txt': (1671853, '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5'),
    'tokenizer/tokenizer_config.json': (12487, '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c'),
}

def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def download(item):
    name, (size, sha) = item
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    url = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}'
    if target.exists() and target.stat().st_size == size and digest(target) == sha:
        return {'path': name, 'bytes': size, 'sha256': sha, 'url': url, 'reused': True}
    partial = target.with_suffix(target.suffix + '.partial')
    for attempt in range(3):
        try:
            start = partial.stat().st_size if partial.exists() else 0
            request = urllib.request.Request(url, headers={'Range': f'bytes={start}-'} if start else {})
            with urllib.request.urlopen(request, timeout=90) as response:
                append = start and response.status == 206
                if append and not response.headers.get('Content-Range', '').startswith(f'bytes {start}-'):
                    raise ValueError('Invalid Content-Range')
                with partial.open('ab' if append else 'wb') as out:
                    while block := response.read(1024 * 1024):
                        out.write(block)
            if partial.stat().st_size != size:
                raise ValueError(f'{name}: size {partial.stat().st_size} != {size}')
            if digest(partial) != sha:
                raise ValueError(f'{name}: SHA256 mismatch')
            partial.replace(target)
            print(json.dumps({'downloaded': name, 'bytes': size, 'sha256': sha}), flush=True)
            return {'path': name, 'bytes': size, 'sha256': sha, 'url': url, 'reused': False}
        except Exception as exc:
            print(json.dumps({'retry': name, 'attempt': attempt + 1, 'error': str(exc)}), flush=True)
            if attempt == 2:
                raise
            time.sleep(1)

ROOT.mkdir(parents=True, exist_ok=True)
manifest = {'model': 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25', 'repository': REPO, 'revision': REVISION,
            'official_release_url': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
            'note': 'HF mirror file hashes match previously verified official Sherpa release files; not unquantized Qwen accuracy.',
            'files': []}
(ROOT / 'download-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for result in pool.map(download, FILES.items()):
        manifest['files'].append(result)
        (ROOT / 'download-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
manifest['verified'] = True
manifest['total_bytes'] = sum(item['bytes'] for item in manifest['files'])
(ROOT / 'download-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'complete': True, 'total_bytes': manifest['total_bytes']}), flush=True)
