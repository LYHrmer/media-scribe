#!/usr/bin/env node
// Reproduce: node --experimental-vm-modules run-production-wasm.mjs REPO cases.local.json results.json
// References are kept in the scorer. The worker receives ONLY PCM, model, language, id.
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import os from 'node:os';
import { scoreTranscript } from './score-transcripts.mjs';
const [rootArg,manifestArg,outputArg]=process.argv.slice(2);
if(!rootArg||!manifestArg||!outputArg)throw Error('Usage: REPO MANIFEST OUTPUT');
const root=await fs.realpath(path.resolve(rootArg)), manifestPath=path.resolve(manifestArg), outputPath=path.resolve(outputArg);
const modelAssetRoot=process.env.BENCHMARK_MODEL_ASSET_ROOT?path.resolve(process.env.BENCHMARK_MODEL_ASSET_ROOT):path.join(root,'public');
const sourceRoot=path.join(root,'src');
const packageInfo=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
const model=process.env.BENCHMARK_MODEL||'Xenova/whisper-small';
const decoding=process.env.BENCHMARK_DECODING||'timestamps';
if(!['timestamps','text'].includes(decoding))throw Error('BENCHMARK_DECODING must be timestamps or text');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const siteOrigin='https://test.local';const modelBase=siteOrigin+'/models-v2/';const fetched=[];const fetchedModelAssets={};const cache=new Map();
const memoryCache={match:async key=>cache.get(String(key.url||key))?.clone(),put:async(key,response)=>cache.set(String(key.url||key),response.clone())};
async function assetFetch(request,options){
 const uri=String(request.url||request);
 if((options?.method||request.method||'GET')!=='GET')throw Error('Unexpected media upload method');
 fetched.push(uri);let filename;
 if(uri.startsWith(modelBase)) filename=path.join(modelAssetRoot,decodeURIComponent(new URL(uri).pathname));
 else if(uri.startsWith('file:')) filename=new URL(uri);
 else throw Error('Unexpected network resource: '+uri);
 try{const bytes=await fs.readFile(filename);if(uri.startsWith(modelBase)&&uri.endsWith('.onnx.manifest.json')){try{const m=JSON.parse(bytes.toString('utf8'));fetchedModelAssets[uri.slice(modelBase.length)]={bytes:m.bytes,sha256:m.sha256,parts:m.parts?.length};}catch{}}return new Response(bytes,{status:200,headers:{'Content-Length':String(bytes.length),'Content-Type':String(filename).endsWith('.json')?'application/json':'application/octet-stream'}});}
 catch{return new Response('not found',{status:404});}
}
const self={constructor:{name:'DedicatedWorkerGlobalScope'},location:{origin:siteOrigin,href:siteOrigin+'/'},caches:{open:async()=>memoryCache}};
let listener,resolveResult,rejectResult;let lastEvents=[];
self.addEventListener=(type,fn)=>{if(type==='message')listener=fn;};
self.postMessage=event=>{lastEvents.push(event);if(event.type==='status')console.log(event.id,event.message);if(event.type==='result')resolveResult(event);if(event.type==='error')rejectResult(Error(event.message));};
const context=vm.createContext({self,location:self.location,crypto:webcrypto,navigator:{hardwareConcurrency:1},console,fetch:assetFetch,caches:self.caches,Response,Request,Headers,URL,Blob,TextEncoder,TextDecoder,WebAssembly,atob,btoa,setTimeout,clearTimeout,setInterval,clearInterval,performance,ReadableStream,Float32Array,Float64Array,Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,BigInt64Array,BigUint64Array,ArrayBuffer,SharedArrayBuffer,DataView});
const assets=await fs.readdir(root+'/dist/assets');
const libraryPath=path.join(root,'dist/assets',assets.find(name=>/^transformers\.web-.*\.js$/.test(name))||'MISSING');
let library;
const dynamicImport=async(specifier,referencing)=>{
 if(specifier==='@huggingface/transformers'){
  if(!library){library=new vm.SourceTextModule(await fs.readFile(libraryPath,'utf8'),{context,identifier:pathToFileURL(libraryPath).href,initializeImportMeta:meta=>{meta.url=pathToFileURL(libraryPath).href;},importModuleDynamically:dynamicImport});await library.link(name=>{throw Error('Unexpected static import '+name);});await library.evaluate();}return library;
 }
 const target=new URL(specifier,referencing.identifier);
 if(target.href===pathToFileURL(root+'/public/vendor/ort/ort-wasm-simd-threaded.mjs').href)return import(target.href);
 if(/^\.{1,2}\//.test(specifier)){
  const module=await loadSourceModule(resolveSourceImport(specifier,referencing));
  if(module.status==='unlinked')await module.link(linkSourceImport);
  if(module.status==='linked')await module.evaluate();
  return module;
 }
 throw Error('Unexpected dynamic import: '+specifier);
};
const sourceModuleCache=new Map();const sourceHashCache={};
function resolveSourceImport(specifier,referencing){
 if(!/^\.{1,2}\//.test(specifier)||!specifier.endsWith('.js')||/[?#]/.test(specifier))throw Error('Unsupported production helper import '+specifier);
 const filename=path.resolve(path.dirname(fileURLToPath(referencing.identifier)),specifier);
 if(!filename.startsWith(sourceRoot+path.sep))throw Error('Helper import escapes src: '+specifier);
 return filename;
}
const linkSourceImport=(specifier,referencing)=>loadSourceModule(resolveSourceImport(specifier,referencing));
async function loadSourceModule(filename){
 filename=await fs.realpath(filename);
 if(!filename.startsWith(await fs.realpath(sourceRoot)+path.sep))throw Error('Production helper resolves outside src');
 if(sourceModuleCache.has(filename))return sourceModuleCache.get(filename);
 const loading=(async()=>{
  let source=await fs.readFile(filename,'utf8');sourceHashCache[path.relative(sourceRoot,filename)]=digest(source);
  if(filename===workerPath){
   const replacement='new URL(`${import.meta.env.BASE_URL}vendor/ort/`, self.location.origin).href';
   if(!source.includes(replacement))throw Error('Verified WASM helper remap expression no longer matches');
   source=source.replace(replacement,JSON.stringify(pathToFileURL(root+'/public/vendor/ort/').href));
  }
  return new vm.SourceTextModule(source,{context,identifier:pathToFileURL(filename).href,initializeImportMeta:meta=>{meta.url=pathToFileURL(filename).href;meta.env={BASE_URL:'/'};},importModuleDynamically:dynamicImport});
 })();
 sourceModuleCache.set(filename,loading);
 try{return await loading;}catch(error){sourceModuleCache.delete(filename);throw error;}
}
const workerPath=path.join(sourceRoot,'transcriber.worker.js');
const worker=await loadSourceModule(workerPath);await worker.link(linkSourceImport);await worker.evaluate();
const sourceFiles={...sourceHashCache};
const results={schema_version:1,app_version:packageInfo.version,transformers_version:packageInfo.dependencies?.['@huggingface/transformers'],created_at:new Date().toISOString(),model,engine:'Current production source worker and built Transformers.js browser bundle + actual ONNX WebAssembly; one reused pipeline',runtime:{wasm_sha256:digest(await fs.readFile(root+'/public/vendor/ort/ort-wasm-simd-threaded.wasm')),browser_bundle_sha256:digest(await fs.readFile(libraryPath)),source_sha256:sourceFiles,num_threads:1,host:os.platform()+' '+os.arch(),node:process.version},experiment_note:process.env.BENCHMARK_EXPERIMENT_NOTE||null,transport:'Virtual same-origin model GET + SHA-256 checked production part loader; memory Cache API; only WASM helper URL remapped to file: import.',limitations:['Not an actual Huawei/Chrome run; browser decoder, UI and hardware timing not verified.','Reference text is only consumed by scorer after inference, never by worker.','Small non-independent set is a diagnostic regression suite, not a general accuracy estimate.','Vendor reference punctuation may have multiple equally valid alternatives.'],cases:[]};
results.decoding=decoding;
await fs.writeFile(outputPath,JSON.stringify(results,null,2));
for(const testCase of manifest.cases){
 const bytes=await fs.readFile(path.resolve(path.dirname(manifestPath),testCase.pcm_path));
 if(digest(bytes)!==testCase.pcm_sha256)throw Error('PCM hash mismatch '+testCase.id);
 const audio=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);lastEvents=[];
 const resultPromise=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});const started=performance.now(),before=fetched.length;
 console.log('START',testCase.id,testCase.duration_seconds);
 let output,error;try{await listener({data:{type:'transcribe',id:testCase.id,audio,model,language:testCase.language,decoding}});output=await resultPromise;}catch(e){error=String(e.message||e);}
 results.model_assets={...fetchedModelAssets};results.runtime.source_sha256={...sourceHashCache};
 const {pcm_path,...publicCase}=testCase;
 const item={...publicCase,seconds_elapsed:(performance.now()-started)/1000,additional_asset_gets:fetched.length-before,...(error?{error}:{output,score:scoreTranscript(testCase.reference,output.text,testCase.language)})};results.cases.push(item);await fs.writeFile(outputPath,JSON.stringify(results,null,2));console.log('DONE',testCase.id,JSON.stringify({text:output?.text,error,score:item.score,seconds:item.seconds_elapsed}));
}
results.completed_at=new Date().toISOString();results.total_asset_gets=fetched.length;if(fetched.some(uri=>uri.startsWith('https://huggingface.co/')))throw Error('Unexpected external model request');await fs.writeFile(outputPath,JSON.stringify(results,null,2));console.log('COMPLETE',outputPath);
