#!/usr/bin/env python3
"""Prepare paired local inputs without loading any expected transcript.
Usage: prepare-downmix-diagnostic.py PRIVATE_VIDEO OUTPUT_DIRECTORY
All media stays in OUTPUT_DIRECTORY, which must be outside the repository.
This uses ffmpeg, not browser decoding. It is a bounded development diagnostic.
"""
import sys,json,hashlib,subprocess
from pathlib import Path
import numpy as np
video=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
repo=Path(__file__).resolve().parents[2]
if out==repo or repo in out.parents:raise ValueError('Keep private media outside the repository')
out.mkdir(parents=True,exist_ok=True)
for name,extra in [('original',['-ac','1']),('browser-mix',['-af','pan=mono|c0=0.5*c0+0.5*c1'])]:
    subprocess.run(['ffmpeg','-v','error','-i',str(video),'-vn',*extra,'-ar','16000','-f','f32le','-y',str(out/(name+'.f32'))],check=True)
x=np.fromfile(out/'browser-mix.f32',dtype='<f4');bounds=[0];sr=16000
while len(x)-bounds[-1]>8*sr:
    start=bounds[-1];positions=range(start+6*sr,start+8*sr-640+1,640)
    end=min(positions,key=lambda i:(np.mean(x[i:i+640].astype(float)**2),-i))+320
    bounds.append(end)
bounds.append(len(x))
for i,(s,e) in enumerate(zip(bounds,bounds[1:])):(out/f'short-{i}.f32').write_bytes(x[s:e].tobytes())
plan={'method':'one fixed alternative; complete nonoverlapping windows <=8s, quietest 40ms in 6-8s, ties later; no reference or OCR supplied','offsets':bounds,'sample_rate':sr,'source_sha256':hashlib.sha256((out/'browser-mix.f32').read_bytes()).hexdigest()}
(out/'experiment-plan.json').write_text(json.dumps(plan,indent=2))
print(json.dumps(plan))
