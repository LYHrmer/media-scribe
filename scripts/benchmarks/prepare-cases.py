#!/usr/bin/env python3
"""Prepare private local evaluation PCM. No model or inference runs here."""
from pathlib import Path
import argparse,hashlib,json,math,random,subprocess,array
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--media-root',type=Path,required=True,help='Directory with zh.wav, jfk.wav (or jfk.f32), and qwen-test-wavs/{fast1,noise2,f1_noise}.wav plus transcript.txt')
parser.add_argument('--output',type=Path,required=True,help='Private working directory for generated PCM and cases.local.json; keep outside the repository')
parser.add_argument('--user-video',type=Path,help='Optional private video; never copied to the output or repository')
parser.add_argument('--user-reference',help='Known reference for optional video, used only by post-inference scorer')
args=parser.parse_args()
if args.user_video and not args.user_reference:parser.error('--user-video requires --user-reference for correctness scoring')
BASE=args.output.resolve();BASE.mkdir(parents=True,exist_ok=True)
MEDIA=args.media_root.resolve()
QWEN=MEDIA/'qwen-test-wavs'
REFS={line.split(' ',1)[0]:line.split(' ',1)[1] for line in (QWEN/'transcript.txt').read_text().splitlines() if ' ' in line}
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def convert(p):
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-vn','-ar','16000','-ac','1','-f','f32le','pipe:1'])
    values=array.array('f');values.frombytes(raw); return values
cases=[]
def save(id,title,data,reference,language,source,reference_source,kind='independent-real-recording',parent=None,recipe=None):
    p=BASE/'pcm'/f'{id}.f32';p.parent.mkdir(exist_ok=True);p.write_bytes(data.tobytes())
    cases.append(dict(id=id,title=title,pcm_path=f'pcm/{id}.f32',pcm_sha256=sha(p),sample_rate=16000,duration_seconds=len(data)/16000,language=language,reference=reference,source=source,reference_source=reference_source,kind=kind,parent=parent,recipe=recipe,sex_metadata='not_verified'))
zh_path=MEDIA/'zh.wav';zh=convert(zh_path)
zh_ref='开放时间早上9点至下午5点。'
zh_source={'url':'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2','member':'test_wavs/zh.wav','original_sha256':sha(zh_path),'rights':'Public vendor test asset; audio not redistributed in repository.'}
zh_refsource={'url':'https://k2-fsa.github.io/sherpa/onnx/sense-voice/python-api.html','type':'vendor-documentation-example-not-independent-human-gold'}
save('zh-clean','普通中文短句',zh,zh_ref,'chinese',zh_source,zh_refsource)
jfk_path=MEDIA/'jfk.wav'
if jfk_path.exists():jfk=convert(jfk_path)
else:
    jfk_path=MEDIA/'jfk.f32';jfk=array.array('f');jfk.frombytes(jfk_path.read_bytes())
save('en-jfk','英语公开演讲',jfk,'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.','english',{'url':'https://github.com/ggml-org/whisper.cpp/raw/refs/heads/master/samples/jfk.wav','original_sha256':sha(jfk_path),'input_encoding':'WAV' if jfk_path.suffix=='.wav' else 'float32-le-16khz-mono','rights':'US federal public speech; audio not redistributed.'},{'url':'https://www.archives.gov/milestone-documents/president-john-f-kennedys-inaugural-address','type':'US National Archives transcript'},)
for id,title,name,lang in [('zh-fast','中文极快语速','fast1.wav','chinese'),('zh-noisy-digits','中文背景噪声与号码','noise2.wav','chinese'),('en-noisy-dialogue','英语有噪声对话','f1_noise.wav','english')]:
    p=QWEN/name
    save(id,title,convert(p),REFS[name],lang,{'url':f'https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/test_wavs/{name}','original_sha256':sha(p),'rights':'Public vendor test asset; license for sample audio is not separately stated; not redistributed.'},{'url':'https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/blob/main/test_wavs/transcript.txt','type':'vendor-provided-reference-not-independent-human-gold'})
if args.user_video:
    p=args.user_video.resolve()
    save('user-video','用户提供参考的私有视频音轨',convert(p),args.user_reference,'chinese',{'type':'user-upload','sha256':sha(p),'private':True,'rights':'Private user recording; never publish video or PCM.'},{'type':'user-provided-text','given_to_inference':False})
save('zh-low-volume','中文音量降低 26 dB',array.array('f',[v*0.05 for v in zh]),zh_ref,'chinese',zh_source,zh_refsource,'derived-control','zh-clean',{'gain':0.05})
# Deterministic, lyric-free synthesized instrumental bed. This is NOT real music corpus.
rms=(sum(v*v for v in zh)/len(zh))**0.5
music=[]
for i,v in enumerate(zh):
    t=i/16000;beat=0.45+0.35*math.sin(2*math.pi*2*t)**2
    tone=(math.sin(2*math.pi*220*t)+0.7*math.sin(2*math.pi*277.18*t)+0.5*math.sin(2*math.pi*329.63*t))/2.2
    music.append(max(-1,min(1,v+rms*0.6*beat*tone)))
save('zh-instrumental','中文叠加合成无歌词伴奏',array.array('f',music),zh_ref,'chinese',zh_source,zh_refsource,'derived-control','zh-clean',{'instrumental':'sine chord at 220,277.18,329.63 Hz; rhythmic amplitude 2 Hz','amplitude':'0.6 * clean-speech RMS; summed and clipped to [-1,1]'})
silence=array.array('f',[0.0]*(16000*5))
save('silence','纯静音 5 秒',silence,'','chinese',{'type':'generated-deterministic'},{'type':'known-empty-by-construction'},'synthetic-negative-control',recipe={'samples':80000,'value':0})
rng=random.Random(20261013);noise=array.array('f',[rng.uniform(-0.03,0.03) for _ in range(16000*5)])
save('noise','无语音均匀随机噪声 5 秒',noise,'','chinese',{'type':'generated-seeded-noise'},{'type':'known-empty-by-construction'},'synthetic-negative-control',recipe={'rng':'Python random.Random','seed':20261013,'uniform':[-0.03,0.03],'samples':80000})
# Insert a real silence gap only between two complete phrases; preserve both references.
pauses=array.array('f',zh);pauses.extend([0.0]*(16000*3));pauses.extend(zh)
save('zh-with-pause','中文两遍短句中间静音 3 秒',pauses,zh_ref+zh_ref,'chinese',zh_source,zh_refsource,'derived-control','zh-clean',{'sequence':'clean + exactly 3 seconds zero PCM + clean'})
manifest={'schema_version':1,'benchmark_version':'2026-10-13','notes':[f'{len(cases)} cases; 5 public independent recordings plus optional private video; 3 derived speech controls and 2 synthetic negative controls.','Vendor example references are not an independent gold benchmark.','Speaker sex metadata has not been verified; do not claim balanced male/female evaluation.','Video container decoding uses ffmpeg for this VM benchmark, not the browser AudioContext; no OCR runs here.','Do not publish private user media/PCM. Reference text is for post-inference scoring only.'],'cases':cases}
(BASE/'cases.local.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps({'cases':len(cases),'seconds':sum(c['duration_seconds'] for c in cases),'manifest':str(BASE/'cases.local.json')},ensure_ascii=False))
