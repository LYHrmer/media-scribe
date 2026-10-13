import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';

// Runs the built browser Worker and actual OpenCV/ONNX WASM kernels in a
// DedicatedWorker-like VM. It does not emulate browser video decoding or UI.
// Local RGBA test pixels are supplied separately, never committed or uploaded.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!flag?.startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --flag value pairs. See docs/OCR_VALIDATION.md.');
  args.set(flag.slice(2), process.argv[i + 1]);
}
for (const flag of args.keys()) if (!['worker', 'assets', 'runtime', 'frames', 'precision', 'output'].includes(flag)) throw new Error(`Unknown option: --${flag}`);
if (!args.has('frames')) throw new Error('--frames must point to a manifest of local RGBA pixel files. See docs/OCR_VALIDATION.md.');
const modelDir = path.resolve(args.get('assets') || path.join(projectRoot, 'public/models-ocr'));
const runtimeDir = path.resolve(args.get('runtime') || path.join(projectRoot, 'public/vendor/ort'));
const manifestPath = path.resolve(args.get('frames'));
const precision = args.get('precision') || 'standard';
if (!['standard', 'enhanced'].includes(precision)) throw new Error('Invalid --precision.');
let workerPath;
if (args.has('worker')) workerPath = path.resolve(args.get('worker'));
else {
  const assetsDir = path.join(projectRoot, 'dist/assets');
  const names = (await fs.readdir(assetsDir)).filter(name => /^video-ocr\.worker-.*\.js$/.test(name));
  if (names.length !== 1) throw new Error('Expected one built OCR Worker. Run npm run build or pass --worker.');
  workerPath = path.join(assetsDir, names[0]);
}
const frames = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (!Array.isArray(frames) || !frames.length) throw new Error('Frame manifest must be a nonempty array.');
const originalSource = await fs.readFile(workerPath, 'utf8');
const runtimePattern = /new URL\(\s*(["'])([^"']*vendor\/ort\/)\1\s*,\s*self\.location\.origin\s*\)\.href/g;
const runtimeMatches = [...originalSource.matchAll(runtimePattern)];
if (runtimeMatches.length !== 1) throw new Error('Worker runtime-base layout changed. Review the WASM helper transport remap before running this benchmark.');
const workerSource = originalSource.replace(runtimePattern, JSON.stringify(pathToFileURL(runtimeDir + path.sep).href));
const origin = 'https://ocr-test.invalid';
const modelBase = origin + '/models-ocr/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = new Map();
const memoryCache = {
  match: async key => cache.get(String(key))?.clone(),
  put: async (key, response) => cache.set(String(key), response.clone()),
  delete: async key => cache.delete(String(key)),
};
const fetched = [];
const allowed = new Set(['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ch_PP-OCRv4_rec_server.onnx', 'ch_ppocr_mobile_v2.0_cls_infer.onnx', 'ppocr_keys_v1.txt']);
async function assetFetch(request, options) {
  const uri = String(request.url || request);
  if ((options?.method || request.method || 'GET') !== 'GET') throw new Error('Unexpected upload request.');
  // OpenCV embeds its own WASM as a data URL; it is not an external request.
  if (uri.startsWith('data:')) return fetch(uri);
  if (!uri.startsWith(modelBase)) throw new Error('Unexpected model network destination.');
  const name = decodeURIComponent(new URL(uri).pathname.slice('/models-ocr/'.length));
  if (!allowed.has(name)) throw new Error('Unexpected model asset name.');
  fetched.push(uri);
  try { return new Response(await fs.readFile(path.join(modelDir, name)), { status: 200 }); }
  catch (error) { if (error.code === 'ENOENT') return new Response('not found', { status: 404 }); throw error; }
}
let listener;
let resultResolve;
const events = [];
const self = {
  constructor: { name: 'DedicatedWorkerGlobalScope' },
  location: { origin, href: origin + '/' },
  caches: { open: async () => memoryCache },
  addEventListener: (type, fn) => { if (type === 'message') listener = fn; },
  postMessage: event => {
    events.push(event);
    if (event.type === 'result' || event.type === 'error') resultResolve?.(event);
  },
};
const context = vm.createContext({
  self, location: self.location, crypto: webcrypto, navigator: { hardwareConcurrency: 1 }, console,
  fetch: assetFetch, Response, Request, Headers, URL, Blob, TextEncoder, TextDecoder,
  WebAssembly, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval, performance, ReadableStream,
  Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
  importScripts: () => { throw new Error('Unexpected importScripts call.'); },
});
const module = new vm.SourceTextModule(workerSource, {
  context, identifier: pathToFileURL(workerPath).href,
  initializeImportMeta: meta => { meta.url = pathToFileURL(workerPath).href; },
  importModuleDynamically: async (specifier, referencing) => import(new URL(specifier, referencing.identifier).href),
});
await module.link(name => { throw new Error(`Unexpected static Worker import: ${name}`); });
await module.evaluate();
async function send(data) {
  const result = new Promise(resolve => { resultResolve = resolve; });
  await listener({ data });
  const event = await result;
  if (event.type === 'error') throw new Error(event.message);
  return event.result;
}
const initializedAt = performance.now();
const initialization = await send({ type: 'initialize', id: 1, config: { precision, assetBaseUrl: modelBase } });
const initializationMs = performance.now() - initializedAt;
const results = [];
for (const [index, frame] of frames.entries()) {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || !frame.rgba || !frame.name) throw new Error('Each frame requires name, rgba, width and height.');
  const pixelPath = path.resolve(path.dirname(manifestPath), frame.rgba);
  const bytes = await fs.readFile(pixelPath);
  if (bytes.length !== frame.width * frame.height * 4) throw new Error(`Invalid RGBA pixel length: ${frame.name}`);
  const pixels = new Uint8ClampedArray(bytes);
  const startedAt = performance.now();
  const result = await send({ type: 'recognize', id: index + 2, pixels: pixels.buffer, width: frame.width, height: frame.height, options: frame.options || {} });
  const elapsedMs = performance.now() - startedAt;
  results.push({ name: frame.name, pixelSha256: sha256(bytes), elapsedMs, result });
  console.log(JSON.stringify({ name: frame.name, elapsedMs: Math.round(elapsedMs), texts: result.texts.map(({ text, confidence, rotated180 }) => ({ text, confidence, rotated180 })) }));
}
const report = {
  worker: { name: path.basename(workerPath), sha256: sha256(originalSource) },
  wasm: { sha256: sha256(await fs.readFile(path.join(runtimeDir, 'ort-wasm-simd-threaded.wasm'))) },
  initialization, initializationMs, fetched, results,
  scope: 'Actual built browser Worker and OpenCV/ONNX WASM kernels; simulated HTTPS model transport and Cache API; WASM helper URL mapped to local file transport. Browser media decoding, UI, mobile memory and network access are not validated.',
};
if (args.has('output')) await fs.writeFile(path.resolve(args.get('output')), JSON.stringify(report, null, 2) + '\n');
console.log(report.scope);
