import { mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
const from = path.resolve('node_modules/onnxruntime-web/dist');
const to = path.resolve('public/vendor/ort');
await mkdir(to, { recursive: true });
// CPU-only inference explicitly uses the standard runtime. Remove previous
// copies so old JSEP/WebGPU assets do not inflate the static deployment.
for (const name of await readdir(to)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(name) && !/^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(name)) {
    await rm(path.join(to, name));
  }
}
let count = 0;
for (const name of await readdir(from)) {
  if (/^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(name)) {
    await copyFile(path.join(from, name), path.join(to, name));
    count++;
  }
}
if (count !== 2) throw new Error('未找到 ONNX 浏览器运行库，请重新安装依赖。');
for (const [folder, filename] of [
  ['onnxruntime-web', 'LICENSE'],
  ['onnxruntime-web', 'ThirdPartyNotices.txt'],
  ['@huggingface/transformers', 'LICENSE'],
]) {
  const source = path.resolve('node_modules', folder, filename);
  try { await copyFile(source, path.join(to, folder.replaceAll('/', '-') + '-' + filename)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(`Prepared ${count} ONNX browser runtime files`);
