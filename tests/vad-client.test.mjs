import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSpeechPresence } from '../src/vad-client.js';

test('force, short and unknown bypass do not construct or download a VAD worker', async () => {
  const old = globalThis.Worker; let starts = 0;
  globalThis.Worker = class { constructor() { starts++; throw new Error('Must not start'); } };
  try {
    assert.equal((await evaluateSpeechPresence(new Float32Array(40000), { forceSpeech: true })).reject, false);
    assert.equal((await evaluateSpeechPresence(new Float32Array(31999))).reject, false);
    assert.equal((await evaluateSpeechPresence(new Float32Array(40000), { contentMode: 'unknown' })).reject, false);
    assert.equal(starts, 0);
  } finally { globalThis.Worker = old; }
});
test('32-second chunks transfer only copies and preserve original PCM for ASR', async () => {
  const old = globalThis.Worker;const sent=[];let terminated=0;
  globalThis.Worker = class {
    postMessage(message, transfers) {
      if(message.type==='start') queueMicrotask(()=>this.onmessage({data:{type:'ready',id:message.id}}));
      else if(message.type==='chunk') { sent.push({length:message.audio.length,buffer:message.audio.buffer,transfer:transfers?.[0]});queueMicrotask(()=>this.onmessage({data:{type:'chunk-ready',id:message.id}})); }
      else queueMicrotask(()=>this.onmessage({data:{type:'result',id:message.id,skipAsr:true,maxProbability:.02,analysisComplete:true,reason:'low-voice-candidate'}}));
    }
    terminate(){terminated++;}
  };
  const samples=new Float32Array(16000*65);samples[0]=.125;samples[samples.length-1]=.375;
  try {
    const output=await evaluateSpeechPresence(samples);
    assert.equal(output.reject,true);assert.equal(output.analysisComplete,true);
    assert.deepEqual(sent.map(x=>x.length),[512000,512000,16000]);
    assert.ok(sent.every(x=>x.buffer!==samples.buffer&&x.transfer===x.buffer));
    assert.equal(samples.buffer.byteLength,16000*65*4);assert.equal(samples[0],.125);assert.equal(samples.at(-1),.375);assert.equal(terminated,1);
  } finally {globalThis.Worker=old;}
});
test('abort terminates a stalled worker and does not detach original PCM', async () => {
  const old=globalThis.Worker;let terminated=0;
  globalThis.Worker=class {postMessage(){}terminate(){terminated++;}};
  const controller=new AbortController(),samples=new Float32Array(40000);
  try {const pending=evaluateSpeechPresence(samples,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(terminated,1);assert.equal(samples.buffer.byteLength,160000);}
  finally{globalThis.Worker=old;}
});
test('worker startup error permits original ASR instead of claiming no voice', async () => {
  const old=globalThis.Worker;globalThis.Worker=class {constructor(){throw new Error('unsupported');}};
  try{const output=await evaluateSpeechPresence(new Float32Array(40000));assert.equal(output.reject,false);assert.equal(output.reason,'vad-unavailable');}
  finally{globalThis.Worker=old;}
});

test('worker message deserialization errors settle instead of hanging preflight', async () => {
  const old=globalThis.Worker;let terminated=0;
  globalThis.Worker=class {postMessage(){queueMicrotask(()=>this.onmessageerror());}terminate(){terminated++;}};
  try{const output=await evaluateSpeechPresence(new Float32Array(40000));assert.equal(output.reject,false);assert.equal(output.reason,'vad-unavailable');assert.equal(terminated,1);}
  finally{globalThis.Worker=old;}
});
