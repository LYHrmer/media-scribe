// Experimental actual Web WASM in a browser-shaped Node VM. Not browser UI QA.
// No reference text is accepted, and no network access is allowed.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function argsOf(values) {
  const args = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i];
    if (['--verify-only', '--help'].includes(key)) args[key.slice(2)] = true;
    else if (['--cases', '--output', '--model-dir', '--runtime-dir', '--max-total-len', '--max-new-tokens', '--repeat'].includes(key)) {
      assert(values[i + 1] && !values[i + 1].startsWith('--'), `Missing value for ${key}`);
      args[key.slice(2)] = values[++i];
    } else throw Error(`Unknown argument ${key}`);
  }
  return args;
}
const args = argsOf(process.argv.slice(2));
if (args.help) {
  console.log('node --experimental-vm-modules run-qwen-web-wasm.mjs --cases REFERENCE_FREE.json --output RESULT.json --model-dir MODEL --runtime-dir RUNTIME [--max-total-len 2048] [--max-new-tokens 512] [--repeat 1] [--verify-only]');
  process.exit(0);
}
for (const name of ['cases', 'output', 'model-dir', 'runtime-dir']) assert(args[name], `Missing --${name}`);
const maxTotalLen = Number(args['max-total-len'] || 2048);
const maxNewTokens = Number(args['max-new-tokens'] || 512);
const repeat = Number(args.repeat || 1);
assert(Number.isInteger(maxTotalLen) && maxTotalLen >= 128 && maxTotalLen <= 4096);
assert(Number.isInteger(maxNewTokens) && maxNewTokens >= 1 && maxNewTokens <= 2048);
assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 4);
const modelRoot = path.resolve(args['model-dir']), runtimeRoot = path.resolve(args['runtime-dir']);
const manifestPath = path.resolve(args.cases), outputPath = path.resolve(args.output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileSha(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
const input = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
assert(Array.isArray(input) || Object.keys(input).length === 1 && Array.isArray(input.cases), 'Input object may contain only cases');
const cases = Array.isArray(input) ? input : input.cases;
assert(cases.length > 0);
const allowedKeys = new Set(['id', 'language', 'pcm_path', 'pcm_sha256', 'sample_rate', 'audio_seconds', 'split']);
const seen = new Set();
for (const c of cases) {
  assert(Object.keys(c).every(k => allowedKeys.has(k)), 'References or unknown case fields are not accepted');
  for (const key of ['id', 'language', 'pcm_path', 'pcm_sha256']) assert(typeof c[key] === 'string' && c[key]);
  assert(!seen.has(c.id)); seen.add(c.id);
  assert((c.sample_rate || 16000) === 16000);
  c.pcm_path = path.resolve(path.dirname(manifestPath), c.pcm_path);
  assert.equal(await fileSha(c.pcm_path), c.pcm_sha256, `PCM hash ${c.id}`);
  assert.equal((await fs.stat(c.pcm_path)).size % 4, 0);
}
const runtime = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'provenance.json'), 'utf8'));
const model = JSON.parse(await fs.readFile(path.join(modelRoot, 'download-manifest.json'), 'utf8'));
assert.equal(runtime.version, '1.13.8');
assert.equal(model.verified, true);
assert.equal(runtime.files.length, 3); assert.equal(model.files.length, 6);
for (const [folder, entries] of [[runtimeRoot, runtime.files], [modelRoot, model.files]]) {
  for (const entry of entries) {
    const filename = path.resolve(folder, entry.file || entry.path);
    assert(filename.startsWith(folder + path.sep));
    assert.equal((await fs.stat(filename)).size, entry.bytes);
    assert.equal(await fileSha(filename), entry.sha256, `Asset hash ${filename}`);
  }
}
if (args['verify-only']) {
  console.log(JSON.stringify({ verified: true, cases: cases.length, model_files: 6, runtime_files: 3, wasm_initialized: false, inference_started: false }));
  process.exit(0);
}

const report = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  status: 'running',
  stage: 'preflight_complete',
  scope: 'Actual official Web WASM and JS API in a browser-shaped Node VM. No native ASR. No browser UI, browser codec, mobile, or network-delivery QA.',
  output_semantics: 'Sherpa engine-returned output, after its built-in processing. Not raw decoder logits or a complete generated token trace. Fixed 1.13.8 includes a low-diversity repetition guard that can drop a 64-token tail.',
  isolation: { references_accepted: false, media_uploaded: false, network_permitted: false, model_input: 'frozen 16kHz float32 PCM only' },
  model, runtime,
  source_sha256: await fileSha(new URL(import.meta.url)),
  input_manifest_sha256: await fileSha(manifestPath),
  settings: { feature_dim: 128, sample_rate: 16000, num_threads: 1, provider: 'cpu', max_total_len: maxTotalLen, max_new_tokens: maxNewTokens, temperature: 1e-6, top_p: 0.8, seed: 42, hotwords: '', repeat },
  cases: [], logs: [], network_attempts: [],
};
async function save() {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath + '.tmp', JSON.stringify(report, null, 2) + '\n');
  await fs.rename(outputPath + '.tmp', outputPath);
}
function capture(kind, values) {
  const message = values.map(String).join(' ');
  if (report.logs.length < 300) report.logs.push({ kind, stage: report.stage, message });
  console.error(`[WebWASM ${kind}] ${message}`);
}
let moduleInstance, recognizer;
// Keep source Buffer ownership explicit until the synchronous model constructor
// finishes. MEMFS canOwn=true shares these ArrayBuffers; it does not copy them.
const mountedModelBuffers = [];
function memory() {
  return { process: process.memoryUsage(), wasm_heap_bytes: moduleInstance?.HEAPU8?.buffer.byteLength ?? null };
}
const origin = 'https://qwen-web-wasm.invalid';
const self = { location: { origin, href: origin + '/worker.mjs' } };
const context = vm.createContext({
  self, location: self.location,
  WorkerGlobalScope: function WorkerGlobalScope() {},
  navigator: { hardwareConcurrency: 1 },
  console: { log: (...x) => capture('log', x), error: (...x) => capture('error', x), warn: (...x) => capture('warn', x) },
  fetch: async request => { report.network_attempts.push(String(request)); throw Error('Unexpected network access'); },
  crypto: webcrypto, WebAssembly, TextEncoder, TextDecoder, URL, DOMException,
  Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
  setTimeout, clearTimeout, performance, atob, btoa,
});
async function sourceModule(filename, suffix) {
  const source = await fs.readFile(path.join(runtimeRoot, filename), 'utf8');
  const m = new vm.SourceTextModule(source + suffix, { context, identifier: origin + '/' + filename });
  await m.link(() => { throw Error('Unexpected static import'); });
  await m.evaluate();
  return m.namespace;
}
try {
  await save();
  report.stage = 'initializing_actual_wasm'; await save();
  const runtimeApi = await sourceModule('sherpa-onnx-wasm-web.js', '\nexport { SherpaOnnx };\n');
  const asrApi = await sourceModule('sherpa-onnx-asr.js', '\nexport { OfflineRecognizer };\n');
  const began = performance.now();
  moduleInstance = await runtimeApi.SherpaOnnx({
    wasmBinary: new Uint8Array(await fs.readFile(path.join(runtimeRoot, 'sherpa-onnx-wasm-web.wasm'))),
    print: (...x) => capture('stdout', x), printErr: (...x) => capture('stderr', x),
    onAbort: reason => capture('abort', [reason]),
    locateFile: name => origin + '/' + name,
  });
  report.actual_runtime = {};
  for (const [key, cName] of [['version', 'SherpaOnnxGetVersionStr'], ['git_sha1', 'SherpaOnnxGetGitSha1'], ['git_date', 'SherpaOnnxGetGitDate'], ['onnxruntime', 'SherpaOnnxGetOnnxruntimeVersionStr']]) {
    report.actual_runtime[key] = moduleInstance.ccall(cName, 'string', [], []);
  }
  assert.equal(report.actual_runtime.version, '1.13.8');
  report.initialization_seconds = (performance.now() - began) / 1000;
  report.memory_after_runtime = memory();
  report.stage = 'mounting_verified_model'; await save();
  moduleInstance.FS.mkdir('/tokenizer');
  for (const entry of model.files) {
    const relative = entry.path;
    const sourceBuffer = await fs.readFile(path.join(modelRoot, relative));
    mountedModelBuffers.push(sourceBuffer);
    const bytes = new Uint8Array(sourceBuffer.buffer, sourceBuffer.byteOffset, sourceBuffer.byteLength);
    assert.equal(hash(bytes), entry.sha256);
    moduleInstance.FS.createDataFile(path.posix.dirname('/' + relative), path.posix.basename(relative), bytes, true, false, true);
  }
  report.memory_before_recognizer = memory();
  report.stage = 'creating_qwen_recognizer'; await save();
  const loadStarted = performance.now();
  recognizer = new asrApi.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: {
      qwen3Asr: { convFrontend: '/conv_frontend.onnx', encoder: '/encoder.int8.onnx', decoder: '/decoder.int8.onnx', tokenizer: '/tokenizer', maxTotalLen, maxNewTokens, temperature: 1e-6, topP: 0.8, seed: 42, hotwords: '' },
      numThreads: 1, provider: 'cpu', debug: 0,
      // Exact 1.13.8 offline JS API defaults. Its line 1558 passes tokens
      // directly to stringToUTF8, although the preceding length check defaults
      // to ''. Qwen uses its tokenizer directory, so this field must be ''.
      // The first smoke report (web-qwen-zh-clean-smoke.json) preserves that
      // pre-C-API TypeError; it was not an ASR or memory-limit result.
      tokens: '', modelType: '', modelingUnit: '', bpeVocab: '', teleSpeechCtc: '',
    },
    // These equal the same wrapper's initSherpaOnnxOfflineRecognizerConfig
    // fallbacks; unused model families retain its own empty configurations.
    lmConfig: { model: '', scale: 1.0 },
    hr: { dictDir: '', lexicon: '', ruleFsts: '' },
    decodingMethod: 'greedy_search', maxActivePaths: 4,
    hotwordsFile: '', hotwordsScore: 1.5, ruleFsts: '', ruleFars: '', blankPenalty: 0,
  }, moduleInstance);
  assert(recognizer.handle, 'Actual Qwen recognizer did not initialize');
  report.model_load_seconds = (performance.now() - loadStarted) / 1000;
  for (const entry of model.files) moduleInstance.FS.unlink('/' + entry.path);
  mountedModelBuffers.length = 0;
  report.memory_after_model = memory();
  report.stage = 'recognizer_ready'; await save();
  const languages = { chinese: 'Chinese', zh: 'Chinese', english: 'English', en: 'English', auto: '' };
  for (let pass = 1; pass <= repeat; pass++) {
    for (const c of cases) {
      report.stage = `decoding:${c.id}:${pass}`; await save();
      const raw = await fs.readFile(c.pcm_path);
      assert.equal(hash(raw), c.pcm_sha256);
      const pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      assert(pcm.length && pcm.every(Number.isFinite));
      if (c.audio_seconds !== undefined) assert(Math.abs(pcm.length / 16000 - c.audio_seconds) <= 1 / 16000);
      const language = languages[c.language.toLowerCase()]; assert(language !== undefined);
      const stream = recognizer.createStream();
      const started = performance.now(), logStart = report.logs.length;
      let row;
      try {
        if (language) stream.setOption('language', language);
        stream.acceptWaveform(16000, pcm);
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        row = { id: c.id, pass, status: 'complete', pcm_sha256: c.pcm_sha256, audio_seconds: pcm.length / 16000,
          language: c.language, result, text: result.text, decode_seconds: (performance.now() - started) / 1000,
          result_provenance: 'engine-returned after built-in Sherpa processing; not a complete generation trace',
          memory_after_decode: memory(), logs: report.logs.slice(logStart) };
      } finally { stream.free(); }
      report.cases.push(row); await save();
      console.log(JSON.stringify(row));
    }
  }
  assert.equal(report.network_attempts.length, 0);
  report.status = 'complete'; report.stage = 'complete';
  report.memory_before_free = memory();
} catch (error) {
  report.status = 'failed';
  report.error = { name: error?.name, message: String(error?.message || error), stack: error?.stack };
  report.memory_at_failure = memory();
  process.exitCode = 1;
} finally {
  if (recognizer?.handle) {
    try { recognizer.free(); } catch (error) { report.cleanup_error = String(error); }
  }
  await save();
}
