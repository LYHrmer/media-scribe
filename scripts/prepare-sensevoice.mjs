// Lossless transport compression only. Model parameters, vocabulary, feature
// extractor and decoder stay identical to the verified official WASM build.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { SENSEVOICE_ASSETS } from '../src/sensevoice-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = process.env.SENSEVOICE_CACHE_DIR || path.join(root, '.cache/sensevoice');
const output = path.join(root, 'public/models-sensevoice');
const modelBase = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/';
const runtimeBase = 'https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/resolve/9d5fc71d88ab1222ed1af2274fb194592af48455/';
const sha = data => createHash('sha256').update(data).digest('hex');
const sources = {
  model: { ...SENSEVOICE_ASSETS.model, url: modelBase + 'model.int8.onnx' },
  tokens: { ...SENSEVOICE_ASSETS.tokens, url: modelBase + 'tokens.txt' },
  wasm: { ...SENSEVOICE_ASSETS.wasm, url: runtimeBase + 'sherpa-onnx-wasm-main-vad-asr.wasm' },
  runtime: { name: 'runtime-original.js', bytes: 95308, sha256: '8a7f50a3e4e5930749e8aff9ad98f03753b87490e7796c576947611439dae9d0', url: runtimeBase + 'sherpa-onnx-wasm-main-vad-asr.js' },
  api: { name: 'api-original.js', bytes: 47391, sha256: '6297ed7520e0b4569486cd89be89045146728605418254fec4172194abc36c8d', url: runtimeBase + 'sherpa-onnx-asr.js' },
};
await mkdir(cache, { recursive: true });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function get(asset) {
  const filename = path.join(cache, asset.name);
  let bytes;
  try { bytes = await readFile(filename); } catch { /* Download. */ }
  if (bytes?.length === asset.bytes && sha(bytes) === asset.sha256) return bytes;
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) throw new Error(`SenseVoice asset download failed: ${asset.name} HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.bytes || sha(bytes) !== asset.sha256) throw new Error(`SenseVoice source integrity failed: ${asset.name}`);
  await writeFile(filename + '.download', bytes); await rename(filename + '.download', filename);
  return bytes;
}
let total = 0;
for (const key of ['model', 'tokens', 'wasm']) {
  const asset = sources[key], bytes = await get(asset), parts = [];
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024 * 1024) {
    const part = bytes.subarray(offset, offset + 16 * 1024 * 1024);
    const compressed = gzipSync(part, { level: 6 });
    // .bin avoids static hosts treating the stored gzip bytes as a transport
    // Content-Encoding and decompressing them before our integrity check.
    const file = `${asset.name}.part-${parts.length}.gz.bin`;
    await writeFile(path.join(output, file), compressed);
    total += compressed.length;
    parts.push({ file, bytes: part.length, compressedBytes: compressed.length, sha256: sha(compressed) });
  }
  await writeFile(path.join(output, `${asset.name}.manifest.json`), JSON.stringify({ version: 1, bytes: asset.bytes, sha256: asset.sha256, parts }, null, 2) + '\n');
}
// Drop the demonstration's eager 368 MB Zipformer package loader. The actual
// runtime is unchanged, receives verified wasmBinary, and is scoped per worker.
const original = (await get(sources.runtime)).toString();
const start = original.indexOf('var moduleOverrides=');
if (start < 4000 || start > 7000 || original.indexOf('var moduleOverrides=', start + 1) !== -1) throw new Error('Unexpected sherpa runtime wrapper');
await writeFile(path.join(output, 'runtime.mjs'), `// sherpa-onnx, Apache-2.0. Only demo preload and module wrapper changed.\nexport default function createModule(options) {\nreturn new Promise((resolve, reject) => {\nvar Module = { ...options, onRuntimeInitialized: () => resolve(Module), onAbort: reason => reject(new Error(String(reason))) };\n${original.slice(start)}\n});\n}\n`);
await writeFile(path.join(output, 'asr.mjs'), (await get(sources.api)).toString() + '\nexport { OfflineRecognizer };\n');
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ sources, changes: ['Demo data preloader replaced by verified same-origin loader.', 'ES module wrapper added; original feature extraction, model and decoder unchanged.', 'Gzip transport compression is lossless.'] }, null, 2) + '\n');
await rm(path.join(output, 'model.onnx'), { force: true });
console.log(`Prepared verified SenseVoice + sherpa WASM: ${(total / 1024 / 1024).toFixed(1)} MiB compressed; weights unchanged`);
