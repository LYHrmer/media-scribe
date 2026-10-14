#!/usr/bin/env node
// Executes the shipped Vite worker, not src/transcriber.worker.js.
// References and saved expectations stay in this runner, outside the worker VM.
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import { scoreTranscript } from './score-transcripts.mjs';

const [rootArg, manifestArg, outputArg] = process.argv.slice(2);
if (!rootArg || !manifestArg || !outputArg) throw Error('Usage: REPO MANIFEST OUTPUT');
const root = await fs.realpath(path.resolve(rootArg));
const manifestPath = path.resolve(manifestArg), outputPath = path.resolve(outputArg);
const modelAssetRoot = process.env.BENCHMARK_MODEL_ASSET_ROOT
  ? path.resolve(process.env.BENCHMARK_MODEL_ASSET_ROOT) : path.join(root, 'public');
const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const model = process.env.BENCHMARK_MODEL || 'Xenova/whisper-small';
const decoding = process.env.BENCHMARK_DECODING || 'timestamps';
if (!['timestamps', 'text'].includes(decoding)) throw Error('BENCHMARK_DECODING must be timestamps or text');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => JSON.parse(JSON.stringify(value, (_key, item) => {
  if (typeof item !== 'bigint') return item;
  const number = Number(item);
  if (!Number.isSafeInteger(number)) throw Error('Unsafe diagnostic token ID');
  return number;
}));
async function optionalEvidence(variable) {
  if (!process.env[variable]) return null;
  const filename = path.resolve(process.env[variable]);
  const bytes = await fs.readFile(filename);
  return { file: filename, sha256: digest(bytes), data: JSON.parse(bytes) };
}
const rawEvidence = await optionalEvidence('BENCHMARK_RAW_DIAGNOSTICS');
const expectedReplay = await optionalEvidence('BENCHMARK_EXPECTED_REPLAY');

const siteOrigin = 'https://test.local', modelBase = siteOrigin + '/models-v2/';
const fetched = [], fetchedModelAssets = {}, cache = new Map();
const memoryCache = {
  match: async key => cache.get(String(key.url || key))?.clone(),
  put: async (key, response) => cache.set(String(key.url || key), response.clone()),
};
// Same GET-only virtual model transport and real production SHA part loader as
// run-production-wasm.mjs. No reference or expectation is passed into the VM.
async function assetFetch(request, options) {
  const uri = String(request.url || request);
  if ((options?.method || request.method || 'GET') !== 'GET') throw Error('Unexpected media upload method');
  fetched.push(uri);
  let filename;
  if (uri.startsWith(modelBase)) filename = path.join(modelAssetRoot, decodeURIComponent(new URL(uri).pathname));
  else if (uri.startsWith('file:')) filename = new URL(uri);
  else throw Error('Unexpected network resource: ' + uri);
  try {
    const bytes = await fs.readFile(filename);
    if (uri.startsWith(modelBase) && uri.endsWith('.onnx.manifest.json')) {
      try {
        const m = JSON.parse(bytes.toString('utf8'));
        fetchedModelAssets[uri.slice(modelBase.length)] = { bytes: m.bytes, sha256: m.sha256, parts: m.parts?.length };
      } catch {}
    }
    return new Response(bytes, { status: 200, headers: {
      'Content-Length': String(bytes.length),
      'Content-Type': String(filename).endsWith('.json') ? 'application/json' : 'application/octet-stream',
    } });
  } catch { return new Response('not found', { status: 404 }); }
}

const self = {
  constructor: { name: 'DedicatedWorkerGlobalScope' },
  location: { origin: siteOrigin, href: siteOrigin + '/' },
  caches: { open: async () => memoryCache },
};
let listener, resolveResult, rejectResult, currentCase = null, lastEvents = [], decodeEvents = [];
self.addEventListener = (type, fn) => { if (type === 'message') listener = fn; };
self.postMessage = event => {
  lastEvents.push(event);
  if (event.type === 'status') console.log(event.id, event.message);
  if (event.type === 'result') resolveResult(event);
  if (event.type === 'error') rejectResult(Error(event.message));
};
const context = vm.createContext({
  self, location: self.location, crypto: webcrypto, navigator: { hardwareConcurrency: 1 },
  console, fetch: assetFetch, caches: self.caches, Response, Request, Headers, URL, Blob,
  TextEncoder, TextDecoder, WebAssembly, atob, btoa, setTimeout, clearTimeout,
  setInterval, clearInterval, performance, ReadableStream, Float32Array, Float64Array,
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
});
const assetsRoot = path.join(root, 'dist/assets'), assets = await fs.readdir(assetsRoot);
function singleAsset(pattern) {
  const matches = assets.filter(name => pattern.test(name));
  if (matches.length !== 1) throw Error('Expected exactly one compiled asset matching ' + pattern);
  return path.join(assetsRoot, matches[0]);
}
const workerPath = singleAsset(/^transcriber\.worker-.*\.js$/);
const libraryPath = singleAsset(/^transformers\.web-.*\.js$/);
const workerUrl = pathToFileURL(workerPath).href, libraryUrl = pathToFileURL(libraryPath).href;
const ortUrl = pathToFileURL(path.join(root, 'public/vendor/ort/ort-wasm-simd-threaded.mjs')).href;
const imports = [];
let library, detachObserver;
function observeDecoder(namespace) {
  const prototype = namespace.WhisperTokenizer?.prototype;
  if (typeof prototype?._decode_asr !== 'function') throw Error('Compiled library lacks WhisperTokenizer._decode_asr');
  const descriptor = Object.getOwnPropertyDescriptor(prototype, '_decode_asr');
  const original = prototype._decode_asr;
  // Instrument only this isolated VM. The compiled production helper can wrap
  // each tokenizer instance normally; this observer sees its forwarded args.
  prototype._decode_asr = function (...args) {
    const event = { case_id: currentCase, call_index: decodeEvents.length };
    decodeEvents.push(event);
    try {
      event.sequences = Array.from(args[0], (sequence, sequence_index) => ({
        sequence_index,
        tokens: normalize(sequence.tokens),
        token_types: Array.from(sequence.tokens, token => typeof token),
        stride: normalize(sequence.stride),
      }));
      event.options = normalize(args[1]);
    } catch (error) { event.observation_error = String(error.message || error); }
    let returned;
    try { returned = original.apply(this, args); }
    catch (error) { event.decoder_error = String(error.message || error); throw error; }
    try { event.returned_output = normalize(returned); }
    catch (error) { event.observation_error = String(error.message || error); }
    return returned;
  };
  detachObserver = () => Object.defineProperty(prototype, '_decode_asr', descriptor);
}
async function loadLibrary() {
  if (library) return library;
  library = new vm.SourceTextModule(await fs.readFile(libraryPath, 'utf8'), {
    context, identifier: libraryUrl,
    initializeImportMeta: meta => { meta.url = libraryUrl; },
    importModuleDynamically: dynamicImport,
  });
  await library.link(name => { throw Error('Unexpected library static import ' + name); });
  await library.evaluate();
  observeDecoder(library.namespace);
  return library;
}
async function dynamicImport(specifier, referencing) {
  const target = new URL(specifier, referencing.identifier).href;
  imports.push({ from: referencing.identifier, specifier, target });
  if (referencing.identifier === workerUrl && target === libraryUrl) return loadLibrary();
  if (referencing.identifier === libraryUrl && target === ortUrl) return import(target);
  throw Error('Unexpected compiled dynamic import: ' + specifier + ' from ' + referencing.identifier);
}
const compiledBytes = await fs.readFile(workerPath);
let compiledSource = compiledBytes.toString('utf8');
// Only the browser->Node WASM helper location changes. Every compiled helper,
// import, model policy, generation setting, and decode call remains in bundle.
const remapExpression = /new URL\(\s*(["'])([^"']*vendor\/ort\/)\1\s*,\s*self\.location\.origin\s*\)\.href/gu;
const remaps = Array.from(compiledSource.matchAll(remapExpression));
if (remaps.length !== 1) throw Error('Verified compiled WASM remap must match exactly once');
compiledSource = compiledSource.replace(remapExpression,
  JSON.stringify(pathToFileURL(path.join(root, 'public/vendor/ort/')).href));
const worker = new vm.SourceTextModule(compiledSource, {
  context, identifier: workerUrl,
  initializeImportMeta: meta => { meta.url = workerUrl; },
  importModuleDynamically: dynamicImport,
});
await worker.link(name => { throw Error('Unexpected compiled worker static import ' + name); });
await worker.evaluate();
if (typeof listener !== 'function') throw Error('Compiled worker did not register a message listener');
if (process.env.BENCHMARK_INITIALIZE_ONLY === '1') {
  await loadLibrary();
  detachObserver();
  if (fetched.length) throw Error('Initialization-only check unexpectedly fetched assets');
  console.log(JSON.stringify({ inference_run: false, worker: workerPath,
    compiled_worker_sha256: digest(compiledBytes), library: libraryPath,
    transformers_version: library.namespace.env.version, listener_registered: true,
    decoder_observer_installed_and_restored: true, asset_gets: fetched.length }));
  process.exit(0);
}

function compareEvidence(testCase, output, events) {
  const comparison = {};
  const rawCase = rawEvidence?.data.cases.find(item => item.id === testCase.id);
  if (rawEvidence) {
    const available = rawCase?.pcm_sha256 === testCase.pcm_sha256;
    comparison.raw_tokens = available ? {
      status: 'compared', passed: isDeepStrictEqual(
        events.map(e => e.sequences?.map(s => ({ tokens: s.tokens, token_types: s.token_types }))),
        rawCase.events.map(e => e.sequences?.map(s => ({ tokens: s.tokens, token_types: s.token_types })))),
    } : { status: 'unavailable', passed: null };
    comparison.decoder_options = available ? {
      status: 'compared', passed: isDeepStrictEqual(events.map(e => e.options), rawCase.events.map(e => e.options)),
    } : { status: 'unavailable', passed: null };
    if (available) comparison.changed_stride_windows = events.reduce((count, event, index) => count
      + (event.sequences || []).filter((sequence, window) => !isDeepStrictEqual(sequence.stride,
        rawCase.events[index]?.sequences[window]?.stride)).length, 0);
  }
  const expected = expectedReplay?.data.cases.find(item => item.id === testCase.id);
  if (expectedReplay) {
    const available = expected?.pcm_sha256 === testCase.pcm_sha256;
    comparison.worker_output = available ? {
      status: 'compared', passed: isDeepStrictEqual(normalize(output), expected.candidate_output),
    } : { status: 'unavailable', passed: null };
    comparison.decoder_output = available ? {
      status: 'compared', passed: isDeepStrictEqual(events.map(e => e.returned_output), expected.events.map(e => e.candidate)),
    } : { status: 'unavailable', passed: null };
    comparison.decoder_stride = available ? {
      status: 'compared', passed: isDeepStrictEqual(events.map(e => e.sequences?.map(s => s.stride)),
        expected.events.map(e => e.decoder_received_stride)),
    } : { status: 'unavailable', passed: null };
  }
  return comparison;
}
const results = {
  schema_version: 1, app_version: packageInfo.version,
  transformers_version: packageInfo.dependencies?.['@huggingface/transformers'],
  created_at: new Date().toISOString(), model, decoding,
  engine: 'Actual compiled Vite worker and compiled Transformers.js browser bundle + actual ONNX WebAssembly; one reused pipeline',
  runtime: {
    wasm_sha256: digest(await fs.readFile(path.join(root, 'public/vendor/ort/ort-wasm-simd-threaded.wasm'))),
    compiled_worker: path.basename(workerPath), compiled_worker_sha256: digest(compiledBytes),
    browser_bundle_sha256: digest(await fs.readFile(libraryPath)),
    num_threads: 1, host: os.platform() + ' ' + os.arch(), node: process.version,
  },
  experiment_note: process.env.BENCHMARK_EXPERIMENT_NOTE || null,
  transport: 'Virtual same-origin model GET + SHA-256 checked compiled production part loader; memory Cache API; only WASM helper URL remapped to file: import.',
  limitations: [
    'Not an actual Huawei/Chrome run; browser decoder, UI and hardware timing not verified.',
    'Reference text and saved output expectations are consumed only after inference, never by worker.',
    'Decoder observer is confined to this VM; original arguments/receiver/return value are preserved.',
    'Small non-independent set is a diagnostic regression suite, not a general accuracy estimate.',
    'Vendor reference punctuation may have multiple equally valid alternatives.',
  ], cases: [],
};
const diagnostics = {
  schema_version: 1, compiled_worker_sha256: digest(compiledBytes), model, decoding,
  observation_scope: 'Arguments received by the actual original decoder AFTER compiled production instance wrapper; no args/returns rewritten by observer.',
  raw_evidence: rawEvidence && { file: rawEvidence.file, sha256: rawEvidence.sha256 },
  expected_replay: expectedReplay && { file: expectedReplay.file, sha256: expectedReplay.sha256 }, cases: [],
};
async function save() {
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2));
  await fs.writeFile(outputPath + '.diagnostics.json', JSON.stringify(diagnostics, null, 2));
}
await save();
try {
  for (const testCase of manifest.cases) {
    const bytes = await fs.readFile(path.resolve(path.dirname(manifestPath), testCase.pcm_path));
    if (digest(bytes) !== testCase.pcm_sha256) throw Error('PCM hash mismatch ' + testCase.id);
    const audio = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    currentCase = testCase.id; lastEvents = []; decodeEvents = [];
    const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const started = performance.now(), before = fetched.length;
    console.log('START', testCase.id, testCase.duration_seconds);
    let output, error;
    try {
      await listener({ data: { type: 'transcribe', id: testCase.id, audio, model, language: testCase.language, decoding } });
      output = await resultPromise;
    } catch (e) { error = String(e.message || e); }
    results.model_assets = { ...fetchedModelAssets };
    const { pcm_path, ...publicCase } = testCase;
    const item = { ...publicCase, seconds_elapsed: (performance.now() - started) / 1000,
      additional_asset_gets: fetched.length - before,
      ...(error ? { error } : { output, score: scoreTranscript(testCase.reference, output.text, testCase.language) }) };
    results.cases.push(item);
    const comparison = error ? {} : compareEvidence(testCase, output, decodeEvents);
    diagnostics.cases.push({ id: testCase.id, pcm_sha256: testCase.pcm_sha256,
      observation_complete: decodeEvents.length > 0 && decodeEvents.every(e => !e.observation_error && !e.decoder_error),
      comparison, events: decodeEvents });
    await save();
    console.log('DONE', testCase.id, JSON.stringify({ text: output?.text, error, score: item.score,
      seconds: item.seconds_elapsed, comparison }));
  }
} finally { detachObserver?.(); currentCase = null; }
results.completed_at = new Date().toISOString(); results.total_asset_gets = fetched.length;
results.runtime.dynamic_imports = imports;
diagnostics.completed_at = results.completed_at;
diagnostics.all_observations_complete = diagnostics.cases.every(c => c.observation_complete);
diagnostics.all_available_comparisons_passed = diagnostics.cases.every(c =>
  Object.values(c.comparison).every(value => value?.passed !== false));
if (fetched.some(uri => uri.startsWith('https://huggingface.co/'))) throw Error('Unexpected external model request');
await save();
if (results.cases.some(c => c.error) || !diagnostics.all_observations_complete
  || !diagnostics.all_available_comparisons_passed) process.exitCode = 1;
console.log('COMPLETE', outputPath);
