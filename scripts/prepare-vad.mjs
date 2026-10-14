import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VAD_ASSET } from '../src/vad-assets.js';

// Only model/licensing assets are downloaded at build time; no user media.
const cache = path.resolve(process.env.VAD_MODELS_CACHE_DIR || '.cache/silero-vad');
const output = path.resolve('public/models-vad');
const licenses = path.resolve('public/licenses');
await Promise.all([mkdir(cache, { recursive: true }), mkdir(output, { recursive: true }), mkdir(licenses, { recursive: true })]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function obtain(name, url, expectedBytes, expectedSha) {
  const cached = path.join(cache, name);
  let bytes;
  try { bytes = await readFile(cached); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Silero asset download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length !== expectedBytes || hash(bytes) !== expectedSha) throw new Error(`Silero asset integrity check failed: ${name}`);
  await writeFile(cached + '.tmp', bytes);
  await rename(cached + '.tmp', cached);
  return cached;
}
const model = await obtain(VAD_ASSET.name, VAD_ASSET.source, VAD_ASSET.bytes, VAD_ASSET.sha256);
await copyFile(model, path.join(output, VAD_ASSET.name));
const licenseUrl = `https://raw.githubusercontent.com/snakers4/silero-vad/${VAD_ASSET.revision}/LICENSE`;
const license = await obtain('SileroVAD-MIT.txt', licenseUrl, 1075, '2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b');
await copyFile(license, path.join(licenses, 'SileroVAD-MIT.txt'));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ model: 'Silero VAD', asset: VAD_ASSET, license: 'MIT', licenseUrl }, null, 2) + '\n');
console.log(`Prepared verified Silero VAD (${VAD_ASSET.bytes} bytes, revision ${VAD_ASSET.revision})`);
