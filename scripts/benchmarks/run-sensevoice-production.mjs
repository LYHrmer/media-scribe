// Real compiled application workers and WASM. Only HTTP/Cache/worker transport
// are simulated. References are read by the scorer after each inference.
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { scoreTranscript } from './score-transcripts.mjs';
import { needsPunctuation, punctuationSegments } from '../../src/punctuation-text.js';

const [distArg, manifestArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw Error('Usage: node --experimental-vm-modules scripts/benchmarks/run-sensevoice-production.mjs DIST LOCAL_CASE_MANIFEST OUTPUT');
const dist = path.resolve(distArg), manifestPath = path.resolve(manifestArg);
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const origin = 'https://sensevoice-test.invalid', cache = new Map(), requests = [];
const sha = b => createHash('sha256').update(b).digest('hex');
const fingerprints = {};
const cacheApi = {
  match: async key => cache.get(String(key))?.clone(),
  put: async (key, response) => cache.set(String(key), response.clone()),
  delete: async key => cache.delete(String(key)),
};
async function assetFetch(request, options) {
  const url = new URL(String(request.url || request));
  assert.equal(options?.method || request.method || 'GET', 'GET', 'never upload audio');
  assert.equal(url.origin, origin);
  assert.match(url.pathname, /^\/(?:[^/]+\/)?models-(?:sensevoice|vad|punctuation)\/[a-zA-Z0-9_.-]+$/);
  const relative = url.pathname.slice(url.pathname.indexOf('/models-') + 1);
  requests.push(relative);
  return new Response(await fs.readFile(path.join(dist, relative)), { headers: { 'content-type': relative.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
}
async function openWorker(kind) {
  const name = (await fs.readdir(path.join(dist, 'assets'))).find(n => n.startsWith(kind + '.worker-') && n.endsWith('.js'));
  if (!name) throw Error('Missing compiled worker ' + kind);
  const filename = path.join(dist, 'assets', name), original = await fs.readFile(filename, 'utf8');
  fingerprints[name] = sha(original);
  const pattern = /new URL\(\s*(["'])([^"']*vendor\/ort\/)\1\s*,\s*self\.location\.origin\s*\)\.href/gu;
  const source = original.replace(pattern, JSON.stringify(pathToFileURL(dist + '/vendor/ort/').href));
  let listener, last;
  const self = { constructor: { name: 'DedicatedWorkerGlobalScope' }, location: { origin, href: origin + '/assets/' + name }, addEventListener: (t, f) => { if (t === 'message') listener = f; }, postMessage: data => { if (['result', 'error', 'ready', 'chunk-ready'].includes(data.type)) last = data; } };
  const context = vm.createContext({ self, location: self.location, caches: { open: async () => cacheApi }, crypto: webcrypto, console,
    navigator: { hardwareConcurrency: 1 }, fetch: assetFetch, Response, Request, Headers, URL, Blob, TextEncoder, TextDecoder,
    WebAssembly, DOMException, atob, btoa, AbortController, AbortSignal, setTimeout, clearTimeout, performance, ReadableStream, DecompressionStream,
    Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
    importScripts() { throw Error('Unexpected importScripts'); },
  });
  const modules = new Map();
  async function dynamicImport(specifier, ref) {
    const url = new URL(specifier, ref.identifier);
    if (url.href === pathToFileURL(dist + '/vendor/ort/ort-wasm-simd-threaded.mjs').href) return import(url.href);
    assert.equal(url.origin, origin);
    assert.match(url.pathname, /\/models-sensevoice\/(?:runtime|asr)\.mjs$/);
    if (modules.has(url.href)) return modules.get(url.href);
    const name = path.basename(url.pathname), text = await fs.readFile(path.join(dist, 'models-sensevoice', name), 'utf8');
    fingerprints['models-sensevoice/' + name] = sha(text);
    const mod = new vm.SourceTextModule(text, { context, identifier: url.href }); modules.set(url.href, mod);
    await mod.link(() => { throw Error('Unexpected runtime import'); }); await mod.evaluate(); return mod;
  }
  const mod = new vm.SourceTextModule(source, { context, identifier: origin + '/assets/' + name, importModuleDynamically: dynamicImport });
  await mod.link(() => { throw Error('Unexpected static worker import'); }); await mod.evaluate();
  return async data => { last = null; await listener({ data }); if (!last) throw Error('No result from worker ' + kind); if (last.type === 'error') throw Error(last.message); return last; };
}
const vad = await openWorker('vad'), punctuation = await openWorker('punctuation');
let asr = await openWorker('sensevoice');
const rows = [], decoding = process.env.BENCHMARK_DECODING || 'timestamps';
let sequence = 0;
async function run(c) {
  const raw = await fs.readFile(path.resolve(path.dirname(manifestPath), c.pcm_path)); assert.equal(sha(raw), c.pcm_sha256);
  const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), id = ++sequence;
  const start = performance.now();
  let check = await vad({ type: 'start', id, sampleCount: audio.length });
  for (let offset = 0; ['ready', 'chunk-ready'].includes(check.type); offset += 512000) {
    check = offset >= audio.length ? await vad({ type: 'finish', id }) : await vad({ type: 'chunk', id, audio: audio.slice(offset, offset + 512000) });
  }
  let result = { text: '', segments: [], duration: audio.length / 16000, speechCheck: check };
  if (!check.skipAsr) {
    result = { ...await asr({ type: 'transcribe', id, audio, model: 'FunAudioLLM/SenseVoiceSmall', language: c.language, decoding }), speechCheck: check };
    if (needsPunctuation(result.text)) {
      const output = await punctuation({ type: 'punctuate', id, text: result.text });
      result = { ...result, rawText: result.rawText ?? result.text, text: output.text, segments: punctuationSegments(result.text, output.text, result.segments) ?? result.segments };
    }
  }
  // No reference is passed to any worker, model, or segmenter.
  const row = { id: c.id, pcm_sha256: c.pcm_sha256, reference: c.reference, language: c.language, result, score: scoreTranscript(c.reference, result.text, c.language), seconds: (performance.now() - start) / 1000, process_rss_mib: process.memoryUsage().rss / 1024 / 1024 };
  rows.push(row);
  console.log(JSON.stringify({ id: c.id, text: result.text, cer: row.score.cer, digit_equivalent_cer: row.score.digit_equivalent_cer, wer: row.score.wer, deferred: check.skipAsr, seconds: row.seconds }));
  return row;
}
for (const c of manifest.cases) {
  if (process.env.CASES && !process.env.CASES.split(',').includes(c.id)) continue;
  await run(c);
}
const coldGets = requests.length;
if (!process.env.SKIP_CACHE_CHECK) {
  asr = await openWorker('sensevoice');
  await run(manifest.cases.find(c => c.id === 'zh-clean'));
  assert.equal(requests.length, coldGets, 'a new worker reuses SHA-verified compressed cache');
}
const output = { scope: 'Actual compiled Vite ASR + VAD + punctuation workers and real WASM; only HTTP, Cache API and worker transport simulated. No browser UI or phone QA claim.', decoding,
  model_sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  runtime_sha256: 'e4dead1d159c531282e635069fa9e028175dee71f3f90908186994655425b3ce', fingerprints, requests, cache_reuse: !process.env.SKIP_CACHE_CHECK, cases: rows };
await fs.writeFile(path.resolve(outputArg), JSON.stringify(output, null, 2) + '\n');
