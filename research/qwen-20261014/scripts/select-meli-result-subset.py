#!/usr/bin/env python3
"""Reference-free scope extraction after a batch ends; preserves all selected text."""
import argparse,hashlib,json
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
for name in ('results','source-input','scope-input','output'):parser.add_argument('--'+name,type=Path,required=True)
args=parser.parse_args()
sha=lambda b:hashlib.sha256(b).hexdigest()
source_bytes=args.results.read_bytes();source=json.loads(source_bytes)
actual_bytes=args.source_input.read_bytes();actual=json.loads(actual_bytes)
scope_bytes=args.scope_input.read_bytes();scope=json.loads(scope_bytes)
assert source['status'] in ('complete','failed'), 'Do not inspect or score an unfinished run'
assert set(actual)==set(scope)=={'cases'}
required={'id','language','pcm_path','pcm_sha256','sample_rate','audio_seconds','split'}
for c in actual['cases']+scope['cases']:assert set(c)==required, 'Reference-bearing or unexpected inference fields'
expected_input_sha=source.get('input_manifest_sha256',source.get('fingerprint',{}).get('input_manifest_sha256'))
assert expected_input_sha==sha(actual_bytes), 'Original input manifest hash mismatch'
actual_by_id={r['id']:r for r in actual['cases']};assert len(actual_by_id)==len(actual['cases'])
source_by_id={r['id']:r for r in source['cases']};assert len(source_by_id)==len(source['cases'])
assert set(source_by_id)<=set(actual_by_id)
if source['status']=='complete':assert set(source_by_id)==set(actual_by_id), 'Complete source batch is missing expected records'
selected=[]
for c in scope['cases']:
 assert c['id'].startswith('meli-') and c['split'] in ('development','holdout')
 assert actual_by_id[c['id']]==c, 'Scope manifest differs from real input manifest'
 if c['id'] not in source_by_id:continue
 row=source_by_id[c['id']]
 assert row['pcm_sha256']==c['pcm_sha256'] and row['language']==c['language']
 assert 'reference' not in row and 'reference_raw' not in row
 selected.append(row)
out={k:v for k,v in source.items() if k not in ('cases','input_manifest_sha256','fingerprint')}
out['cases']=selected
out['subset_provenance']=dict(source_inference_result_sha256=sha(source_bytes),source_input_manifest_sha256=sha(actual_bytes),
 source_fingerprint=source.get('fingerprint'),source_cases=len(source['cases']),expected_source_cases=len(actual['cases']),
 subset_cases=len(selected),expected_subset_cases=len(scope['cases']),subset_input_manifest_sha256=sha(scope_bytes),
 selection='Frozen MELI ID membership only; no score/content/truncation filtering. Keep exact text, statuses, EOS and limit flags. Official processed text remains diagnostic.')
assert args.output.resolve() not in [p.resolve() for p in (args.results,args.source_input,args.scope_input)]
with args.output.open('x') as f:json.dump(out,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps(dict(output=str(args.output),sha256=sha(args.output.read_bytes()),source_status=source['status'],cases=len(selected),truncated=sum(bool(r.get('truncated')) for r in selected))))
