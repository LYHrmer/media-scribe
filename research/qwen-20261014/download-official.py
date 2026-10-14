import concurrent.futures, hashlib, json, pathlib, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
MODELS = [('Qwen/Qwen3-ASR-0.6B-hf', '7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c'), ('Qwen/Qwen3-ASR-1.7B-hf', 'bcd2b5b7f32b480ab5790554cfa8347f246a14f3')]

def download_model(spec):
    repo, rev = spec
    dest = ROOT / 'models' / repo.split('/')[-1]
    dest.mkdir(parents=True, exist_ok=True)
    metadata = json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/revision/{rev}?blobs=true', timeout=60))
    assert metadata['sha'] == rev
    (dest / 'source-metadata.json').write_text(json.dumps(metadata, indent=2))
    manifest = {'repository': repo, 'revision': rev, 'files': []}
    for item in metadata['siblings']:
        name = item['rfilename']
        if name == '.gitattributes': continue
        assert '/' not in name
        p = dest / name
        expected = item.get('lfs', {}).get('sha256')
        if not p.exists():
            tmp = p.with_suffix(p.suffix + '.partial')
            url = f'https://huggingface.co/{repo}/resolve/{rev}/{name}'
            count = 0; last = time.monotonic()
            with urllib.request.urlopen(url, timeout=60) as response, tmp.open('wb') as out:
                while chunk := response.read(2**20):
                    out.write(chunk); count += len(chunk)
                    if time.monotonic() - last >= 15:
                        print(repo, name, count, '/', item['size'], flush=True); last = time.monotonic()
            assert count == item['size'], (name, count, item['size'])
            tmp.replace(p)
        sha = hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()
        assert p.stat().st_size == item['size']
        if expected: assert sha == expected, name
        manifest['files'].append({'name': name, 'bytes': p.stat().st_size, 'sha256': sha})
        print('VERIFIED', repo, name, p.stat().st_size, flush=True)
    (dest / 'verified-assets.json').write_text(json.dumps(manifest, indent=2))
    print('COMPLETE', repo, flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(download_model, MODELS))
