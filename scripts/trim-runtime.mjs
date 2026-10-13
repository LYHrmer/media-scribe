import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Transformers' dependency emits a default WASM URL asset. The production
// worker always supplies explicit standard .mjs/.wasm paths in vendor/ort/;
// no default runtime asset is needed. Keep a single tested runtime copy.
const assets = path.resolve('dist/assets');
for (const name of await readdir(assets)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(name)) await rm(path.join(assets, name));
}
let bytes = 0;
async function count(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const info = await stat(file);
    if (info.isDirectory()) await count(file);
    else bytes += info.size;
  }
}
await count(path.resolve('dist'));
const limitMiB = process.env.VITE_COMPACT_BUILD === '1' || process.env.STATIC_HOST_LIMIT_MIB === '256' ? 256 : 1024;
if (bytes > limitMiB * 1024 * 1024 - 64 * 1024) {
  throw new Error(`Static build exceeds the ${limitMiB} MiB hosting limit: ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
}
console.log(`Static build: ${(bytes / 1024 / 1024).toFixed(1)} MiB; one standard WASM runtime`);
