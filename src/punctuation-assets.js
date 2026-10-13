const EXPECTED = {
  model: { name: 'model.zh-compact.int8.onnx', bytes: 7637864, sha256: '807302f35c81326bd2a0e3f0b1b99077dbd270a9776d22d0b2080bdd6b9c0dae' },
  tokens: { name: 'tokens.json', bytes: 97004, sha256: 'cb7369ce808e03f9a3b6c3ce3eae16fc2e4dd2aed2ffc49c2b9f108a642c0140' },
};
export const PUNCTUATION_CACHE = 'tingxie-punctuation-v1';

export function validatePunctuationManifest(manifest) {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const asset = manifest?.[key];
    if (!asset || asset.name !== expected.name || !Number.isSafeInteger(asset.bytes)
      || asset.bytes !== expected.bytes || !/^[a-f0-9]{64}$/u.test(asset.sha256)
      || asset.sha256 !== expected.sha256) throw new Error('标点模型目录不匹配，请刷新页面重试。');
  }
  return manifest;
}

async function readVerified(response, asset) {
  if (!response?.ok || /(?:text\/html|application\/xhtml)/iu.test(response.headers.get('content-type') || '')) throw new Error(`标点模型下载失败：HTTP ${response?.status || 0}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.bytes) throw new Error('标点模型大小校验失败。');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== asset.sha256) throw new Error('标点模型内容校验失败。');
  return bytes;
}

export async function loadPunctuationAsset(baseUrl, asset) {
  const expected = Object.values(EXPECTED).find(item => item.name === asset?.name);
  if (!expected || asset.bytes !== expected.bytes || asset.sha256 !== expected.sha256) throw new Error('标点模型资源地址无效。');
  const url = new URL(asset.name, baseUrl).href;
  let cache;
  try { cache = await (globalThis.caches || globalThis.self?.caches)?.open(PUNCTUATION_CACHE); } catch { /* Storage denial must not block local inference. */ }
  if (cache) {
    try {
      const response = await cache.match(url);
      if (response) return await readVerified(response, asset);
    } catch { await cache.delete(url).catch(() => {}); }
  }
  const response = await fetch(url, { cache: 'reload' });
  const bytes = await readVerified(response, asset);
  if (cache) await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}
