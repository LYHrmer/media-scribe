// Build-time only: publish model/config assets on the same site as the app.
// User browsers never need Hugging Face connectivity and never upload media.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MODEL_IDS = ['Xenova/whisper-tiny', 'Xenova/whisper-small'];
export const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
export const PART_BYTES = 16 * 1024 * 1024;

export function getModelFiles(modelId) {
  if (!MODEL_IDS.includes(modelId)) throw new Error(`Unsupported model: ${modelId}`);
  return modelId === 'Xenova/whisper-small'
    ? MODEL_FILES.map(filename => filename.replace('_quantized.onnx', '_q4f16.onnx'))
    : [...MODEL_FILES];
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function ensureSource(cacheDir, modelId, filename, fetchImpl) {
  const destination = path.join(cacheDir, modelId, filename);
  try { await access(destination); return destination; } catch { /* Download only missing files. */ }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.download`;
  try {
    console.log(`Downloading ${modelId}/${filename}`);
    const response = await fetchImpl(`https://huggingface.co/${modelId}/resolve/main/${filename}`, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body || /text\/html/i.test(response.headers.get('content-type') || '')) {
      throw new Error(`Official model download failed: ${modelId}/${filename} (${response.status})`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function splitOnnx(source, destination) {
  const file = await open(source, 'r');
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size < 1024 || size > 512 * 1024 * 1024) {
      throw new Error(`Invalid ONNX file length: ${source}`);
    }
    const modelHash = createHash('sha256');
    const parts = [];
    for (let offset = 0; offset < size; offset += PART_BYTES) {
      const length = Math.min(PART_BYTES, size - offset);
      const bytes = Buffer.allocUnsafe(length);
      let consumed = 0;
      while (consumed < length) {
        const { bytesRead } = await file.read(bytes, consumed, length - consumed, offset + consumed);
        if (!bytesRead) throw new Error(`Truncated ONNX cache file: ${source}`);
        consumed += bytesRead;
      }
      if (!offset && /^\s*(?:<!doctype\s+html|<html\b)/i.test(bytes.subarray(0, 128).toString())) {
        throw new Error(`ONNX cache file contains HTML: ${source}`);
      }
      const filename = `${path.basename(destination)}.part-${parts.length}.bin`;
      await writeFile(path.join(path.dirname(destination), filename), bytes);
      modelHash.update(bytes);
      parts.push({ file: filename, bytes: length, sha256: sha256(bytes) });
    }
    const manifest = { version: 1, bytes: size, sha256: modelHash.digest('hex'), parts };
    await writeFile(`${destination}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally { await file.close(); }
}

export async function prepareModelAssets({
  cacheDir = process.env.MODELS_CACHE_DIR || path.join(PROJECT_ROOT, '.cache/models'),
  publicDir = path.join(PROJECT_ROOT, 'public/models-v2'),
  modelIds = process.env.VITE_COMPACT_BUILD === '1' ? ['Xenova/whisper-tiny'] : MODEL_IDS,
  fetchImpl = globalThis.fetch,
} = {}) {
  await mkdir(publicDir, { recursive: true });
  // Base belonged to an earlier release. Remove it so public deployments do
  // not retain an unused model. Each selected target is atomically rebuilt.
  await rm(path.join(publicDir, 'Xenova/whisper-base'), { recursive: true, force: true });
  for (const id of MODEL_IDS.filter(id => !modelIds.includes(id))) {
    await rm(path.join(publicDir, id), { recursive: true, force: true });
  }
  const results = [];
  for (const modelId of modelIds) {
    const files = getModelFiles(modelId);
    const sources = new Map();
    for (const filename of files) sources.set(filename, await ensureSource(cacheDir, modelId, filename, fetchImpl));
    const temporary = path.join(publicDir, `.prepare-${randomUUID()}`);
    const destination = path.join(publicDir, modelId);
    const modelManifests = {};
    try {
      await mkdir(path.join(temporary, 'onnx'), { recursive: true });
      for (const filename of files) {
        const source = sources.get(filename);
        const target = path.join(temporary, filename);
        if (filename.endsWith('.json')) {
          const json = JSON.parse(await readFile(source, 'utf8'));
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`Invalid JSON model file: ${source}`);
          await copyFile(source, target);
        } else {
          modelManifests[filename] = await splitOnnx(source, target);
        }
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await rename(temporary, destination);
      results.push({ modelId, manifests: modelManifests });
      const bytes = Object.values(modelManifests).reduce((total, manifest) => total + manifest.bytes, 0);
      console.log(`Prepared ${modelId}: ${(bytes / 1024 / 1024).toFixed(1)} MiB, all assets <= 16 MiB`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareModelAssets();
}
