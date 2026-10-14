// Actual Vite VAD Worker + actual WebORT WASM. GET/Cache API are simulated;
// no browser UI, AudioContext or mobile performance claim.
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [distArg,manifestArg,outputArg]=process.argv.slice(2);
if(!manifestArg||!outputArg)throw Error('Usage: node --experimental-vm-modules scripts/verify-vad-wasm.mjs DIST LOCAL_CASE_MANIFEST OUTPUT_JSON');
const dist=path.resolve(distArg),manifestPath=path.resolve(manifestArg),outputPath=path.resolve(outputArg);
const names=(await fs.readdir(path.join(dist,'assets'))).filter(x=>/^vad\.worker-.*\.js$/u.test(x));
if(names.length!==1)throw Error('Expected exactly one built VAD Worker; build the current application first.');
const workerPath=path.join(dist,'assets',names[0]),original=await fs.readFile(workerPath,'utf8');
const pattern=/new URL\(\s*(["'])([^"']*vendor\/ort\/)\1\s*,\s*self\.location\.origin\s*\)\.href/gu;
if([...original.matchAll(pattern)].length!==1)throw Error('Review the WASM helper transport remap: runtime URL layout changed.');
const source=original.replace(pattern,JSON.stringify(pathToFileURL(dist+'/vendor/ort/').href));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const cache=new Map(),gets=[];
const cacheApi={match:async key=>cache.get(String(key))?.clone(),put:async(key,r)=>cache.set(String(key),r.clone()),delete:async key=>cache.delete(String(key))};
const origin='https://vad-test.invalid';
async function assetFetch(request,options){
 const url=new URL(String(request.url||request));
 if((options?.method||request.method||'GET')!=='GET')throw Error('Unexpected upload method.');
 if(url.origin!==origin)throw Error('Unexpected model destination.');
 const offset=url.pathname.indexOf('/models-vad/');
 if(offset<0)throw Error('Unexpected network resource.');
 const relative=url.pathname.slice(offset+1);
 if(relative!=='models-vad/silero-vad-1e261b03.onnx')throw Error('Unexpected model asset name.');
 gets.push(url.href);return new Response(await fs.readFile(path.join(dist,relative)),{status:200,headers:{'content-type':'application/octet-stream'}});
}
async function openWorker(){
 let listener,resolveEvent;
 const self={constructor:{name:'DedicatedWorkerGlobalScope'},location:{origin,href:origin+'/assets/'+names[0]},caches:{open:async()=>cacheApi},addEventListener:(type,fn)=>{if(type==='message')listener=fn;},postMessage:event=>{if(['ready','chunk-ready','result','error'].includes(event.type))resolveEvent?.(event);}};
 const context=vm.createContext({self,location:self.location,caches:self.caches,crypto:webcrypto,console,navigator:{hardwareConcurrency:1},fetch:assetFetch,Response,Request,Headers,URL,Blob,TextEncoder,TextDecoder,WebAssembly,DOMException,atob,btoa,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,performance,ReadableStream,Float32Array,Float64Array,Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,BigInt64Array,BigUint64Array,ArrayBuffer,SharedArrayBuffer,DataView,importScripts(){throw Error('Unexpected importScripts');}});
 const module=new vm.SourceTextModule(source,{context,identifier:pathToFileURL(workerPath).href,initializeImportMeta:meta=>{meta.url=pathToFileURL(workerPath).href;},importModuleDynamically:async(specifier,ref)=>{
  const target=new URL(specifier,ref.identifier);
  if(target.href!==pathToFileURL(dist+'/vendor/ort/ort-wasm-simd-threaded.mjs').href)throw Error('Unexpected dynamic import '+target.href);
  return import(target.href);
 }});
 await module.link(name=>{throw Error('Unexpected static Worker import '+name);});await module.evaluate();
 async function send(data){const pending=new Promise(resolve=>{resolveEvent=resolve;});await listener({data});return pending;}
 let sequence=0;
 return async audio=>{
  const id=++sequence;let result=await send({type:'start',id,sampleCount:audio.length});let chunks=0;
  for(let offset=0;result.type==='ready'||result.type==='chunk-ready';offset+=512000){
   if(offset>=audio.length){result=await send({type:'finish',id});break;}
   const chunk=audio.slice(offset,Math.min(audio.length,offset+512000));chunks++;result=await send({type:'chunk',id,audio:chunk});
  }
  if(result.type==='error')throw Error(result.message);return {chunks,decision:result};
 };
}
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
async function pcm(id){const c=manifest.cases.find(c=>c.id===id);if(!c)throw Error('Missing local case '+id);const bytes=await fs.readFile(path.resolve(path.dirname(manifestPath),c.pcm_path));assert.equal(sha(bytes),c.pcm_sha256);return {audio:new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),sha256:c.pcm_sha256};}
const start=performance.now(),run=await openWorker(),rows=[];
const noise=await pcm('noise'),lyrics=await pcm('user-lyrics'),clean=await pcm('zh-clean');
rows.push({id:'noise',pcm_sha256:noise.sha256,...await run(noise.audio)});assert.equal(rows.at(-1).decision.skipAsr,true);assert.equal(rows.at(-1).decision.analysisComplete,true);
rows.push({id:'user-lyrics',pcm_sha256:lyrics.sha256,...await run(lyrics.audio)});assert.equal(rows.at(-1).decision.skipAsr,false);assert.equal(rows.at(-1).decision.analysisComplete,false);assert.equal(rows.at(-1).decision.maxProbability,null);
const delayed=new Float32Array(16000*33+clean.audio.length);delayed.set(clean.audio,16000*33);
rows.push({id:'silence-33s-plus-clean-derived',recipe:'33 seconds zero PCM + original clean sentence; not an independent recording',duration_seconds:delayed.length/16000,...await run(delayed)});assert.equal(rows.at(-1).decision.skipAsr,false);assert.equal(rows.at(-1).chunks,2);
const longNoise=new Float32Array(noise.audio.length*13);for(let i=0;i<13;i++)longNoise.set(noise.audio,i*noise.audio.length);
rows.push({id:'noise-repeat-13-derived-65s',recipe:'13 exact repetitions of original 5s seeded uniform noise; not an independent negative recording',duration_seconds:65,...await run(longNoise)});assert.equal(rows.at(-1).decision.skipAsr,true);assert.equal(rows.at(-1).decision.analysisComplete,true);assert.equal(rows.at(-1).chunks,3);
const coldGets=gets.length,again=await openWorker();assert.equal((await again(noise.audio)).decision.skipAsr,true);assert.equal(gets.length,coldGets,'second Worker reuses SHA-verified cached model bytes');
const output={schema_version:1,worker:names[0],worker_sha256:sha(original),wasm_sha256:sha(await fs.readFile(dist+'/vendor/ort/ort-wasm-simd-threaded.wasm')),model_sha256:sha(await fs.readFile(dist+'/models-vad/silero-vad-1e261b03.onnx')),source_sha256:Object.fromEntries(await Promise.all(['vad-engine.js','vad-assets.js','vad.worker.js','vad-client.js'].map(async name=>[name,sha(await fs.readFile(path.join(path.dirname(dist),'src',name)))]))),scope:'Actual Vite Worker + actual ONNX WebORT WASM; same-origin GET and Cache API simulated; no UI/decoder/mobile claim',chunk_samples:512000,cases:rows,cache_reuse:true,model_gets:gets.length,elapsed_seconds:(performance.now()-start)/1000};
await fs.writeFile(outputPath,JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
