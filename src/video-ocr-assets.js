// PP-OCRv4 mobile weights converted by RapidOCR. These hashes match the
// upstream RapidOCR model manifest; the alphabet is embedded in the rec model.
export const OCR_ASSETS = Object.freeze([
  { name: 'ch_PP-OCRv4_det_infer.onnx', bytes: 4745517, sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9' },
  { name: 'ch_PP-OCRv4_rec_infer.onnx', bytes: 10857958, sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b' },
  { name: 'ch_ppocr_mobile_v2.0_cls_infer.onnx', bytes: 585532, sha256: 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c' },
  { name: 'ppocr_keys_v1.txt', bytes: 26249, sha256: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7' },
]);
export const OCR_ENHANCED_ASSET = Object.freeze({
  name: 'ch_PP-OCRv4_rec_server.onnx', bytes: 90530732,
  sha256: '6a2676219be9907c7fc9cf61ebaa843bf2898777def567925b78886fcd90c07a',
});
export function getOcrAssets(precision = 'standard') {
  if (!['standard', 'enhanced'].includes(precision)) throw new Error('不支持的字幕识别精度。');
  return precision === 'enhanced' ? OCR_ASSETS.map(asset => asset.name === 'ch_PP-OCRv4_rec_infer.onnx' ? OCR_ENHANCED_ASSET : asset) : OCR_ASSETS;
}

export async function loadOcrAsset(asset, baseUrl, progress = () => {}) {
  const url = new URL(asset.name, baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === self.location.origin)) {
    throw new Error('字幕识别模型需要安全的 HTTPS 下载入口。');
  }
  let cache;
  try { cache = await self.caches?.open('tingxie-ppocr-v4-verified-v1'); } catch { /* Optional cache. */ }
  const verify = async response => {
    if (!response.ok) throw new Error(`字幕模型下载失败（HTTP ${response.status}）。`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== asset.bytes) throw new Error(`字幕模型 ${asset.name} 不完整，请刷新后重试。`);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256) throw new Error(`字幕模型 ${asset.name} 校验失败，请刷新后重试。`);
    return buffer;
  };
  let cached;
  try { cached = await cache?.match(url.href); } catch { /* Retry without cache. */ }
  if (cached) {
    try { return await verify(cached); }
    catch { try { await cache.delete(url.href); } catch { /* Retry from network. */ } }
  }
  progress({ phase: 'download', asset: asset.name, loaded: 0, total: asset.bytes });
  const response = await fetch(url, { method: 'GET' });
  const copy = response.clone();
  const buffer = await verify(response);
  try { await cache?.put(url.href, copy); } catch { /* Full/private caches must not break OCR. */ }
  progress({ phase: 'download', asset: asset.name, loaded: asset.bytes, total: asset.bytes });
  return buffer;
}
