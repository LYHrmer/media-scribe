import { readFile, writeFile, mkdir, rename, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OCR_ASSETS, OCR_ENHANCED_ASSET } from '../src/video-ocr-assets.js';

// Exact upstream RapidOCR PP-OCRv4 mobile files. Network access happens while
// building, never for user video frames. Runtime serves these from this site.
const upstream = {
  'ch_PP-OCRv4_det_infer.onnx': 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx',
  'ch_PP-OCRv4_rec_infer.onnx': 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_infer.onnx': 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx',
  'ppocr_keys_v1.txt': 'https://raw.githubusercontent.com/RapidAI/RapidOCR/86ae3f5079df3422c1829cd84baf19bc8a7a9453/python/rapidocr_openvino/ch_ppocr_rec/ppocr_keys_v1.txt',
  'ch_PP-OCRv4_rec_server.onnx': 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_server.onnx',
};
const assets = process.env.OCR_INCLUDE_ENHANCED === '1' ? [...OCR_ASSETS, OCR_ENHANCED_ASSET] : OCR_ASSETS;
const cache = path.resolve(process.env.OCR_MODELS_CACHE_DIR || '.cache/ocr-v4');
const output = path.resolve('public/models-ocr');
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
if (process.env.OCR_INCLUDE_ENHANCED !== '1') await rm(path.join(output, OCR_ENHANCED_ASSET.name), { force: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function verify(bytes, asset) {
  if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error(`OCR asset integrity check failed: ${asset.name}`);
}
for (const asset of assets) {
  const cacheFile = path.join(cache, asset.name);
  let bytes;
  try { bytes = await readFile(cacheFile); verify(bytes, asset); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(upstream[asset.name], { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`OCR asset download failed ${asset.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, asset);
    await writeFile(cacheFile + '.tmp', bytes);
    await rename(cacheFile + '.tmp', cacheFile);
  }
  await copyFile(cacheFile, path.join(output, asset.name));
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ model: 'RapidOCR PP-OCRv4', enhanced: process.env.OCR_INCLUDE_ENHANCED === '1', upstream, assets }, null, 2) + '\n');
// Model weights, dictionary and adapted preprocessing are Apache-2.0.
const licensePath = path.resolve('public/licenses');
await mkdir(licensePath, { recursive: true });
const licenseCache = path.join(cache, 'Apache-2.0.txt');
let license;
try { license = await readFile(licenseCache); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch('https://raw.githubusercontent.com/RapidAI/RapidOCR/86ae3f5079df3422c1829cd84baf19bc8a7a9453/LICENSE', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OCR license download failed: HTTP ${response.status}`);
  license = Buffer.from(await response.arrayBuffer());
  if (!license.toString().includes('Apache License') || !license.toString().includes('Version 2.0')) throw new Error('Unexpected OCR license');
  await writeFile(licenseCache, license);
}
await writeFile(path.join(licensePath, 'RapidOCR-PaddleOCR-Apache-2.0.txt'), license);
await copyFile(path.resolve('node_modules/@techstark/opencv-js/LICENSE'), path.join(licensePath, 'OpenCV-js-Apache-2.0.txt'));
console.log(`Prepared ${assets.length} verified OCR assets (${(assets.reduce((n, asset) => n + asset.bytes, 0) / 1048576).toFixed(1)} MiB)`);
