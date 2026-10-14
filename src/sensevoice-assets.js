// Official SenseVoice Small int8 and the matching sherpa-onnx WASM build.
// Only model/runtime GETs leave this worker; audio never does.
export const SENSEVOICE_MODEL = 'FunAudioLLM/SenseVoiceSmall';
export const SENSEVOICE_ASSETS = Object.freeze({
  model: { name: 'sensevoice.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  tokens: { name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  wasm: { name: 'sherpa.wasm', bytes: 11722172, sha256: 'e4dead1d159c531282e635069fa9e028175dee71f3f90908186994655425b3ce' },
});

const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const MAX_PART = 16 * 1024 * 1024;

export function validateSenseManifest(manifest, asset) {
  if (!manifest || manifest.version !== 1 || manifest.bytes !== asset.bytes || manifest.sha256 !== asset.sha256
    || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 32) throw new Error('中文模型清单无效，请刷新重试。');
  let total = 0;
  for (const [i, p] of manifest.parts.entries()) {
    if (p.file !== `${asset.name}.part-${i}.gz.bin` || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_PART
      || !Number.isSafeInteger(p.compressedBytes) || p.compressedBytes < 1 || p.compressedBytes > MAX_PART + 65536
      || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('中文模型分片无效，请刷新重试。');
    total += p.bytes;
  }
  if (total !== asset.bytes) throw new Error('中文模型分片不完整，请刷新重试。');
  return manifest;
}

export async function loadSenseAsset(baseUrl, asset, progress = () => {}) {
  const location = globalThis.location || self.location;
  const base = new URL(baseUrl, location.href);
  if (base.origin !== location.origin || !['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('中文模型必须由当前网页提供。');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (!Object.values(SENSEVOICE_ASSETS).includes(asset)) throw new Error('中文模型选项无效。');
  if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器暂不支持模型解压，请选择「通用高精度」或更新浏览器。');
  let cache;
  try { cache = await globalThis.caches?.open('tingxie-sensevoice-verified-v1'); } catch { /* Optional. */ }
  async function get(name, verify) {
    const url = new URL(name, base).href;
    let saved;
    try { saved = await cache?.match(url); } catch { /* Fetch. */ }
    if (saved) {
      try { return await verify(saved); } catch { try { await cache.delete(url); } catch { /* Fetch. */ } }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok || response.type === 'opaqueredirect' || (response.url && new URL(response.url).origin !== base.origin)) throw new Error(`中文模型下载失败（HTTP ${response.status}），请重试。`);
      if (/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('中文模型下载成了网页，请检查网址后重试。');
      const copy = response.clone();
      const value = await verify(response);
      try { await cache?.put(url, copy); } catch { /* Cache quota must not block transcription. */ }
      return value;
    } finally { clearTimeout(timeout); }
  }
  const manifest = await get(`${asset.name}.manifest.json`, async response => {
    const text = await response.text();
    if (text.length > 65536) throw new Error('中文模型清单过大。');
    return validateSenseManifest(JSON.parse(text), asset);
  });
  const output = new Uint8Array(asset.bytes);
  const total = manifest.parts.reduce((n, p) => n + p.compressedBytes, 0);
  let offset = 0, loaded = 0;
  for (const part of manifest.parts) {
    progress({ file: asset.name, loaded, total, progress: 100 * loaded / total, status: 'progress' });
    const compressed = await get(part.file, async response => {
      const b = await response.arrayBuffer();
      if (b.byteLength !== part.compressedBytes || await digest(b) !== part.sha256) throw new Error('中文模型分片校验失败，请重试。');
      return b;
    });
    // Decompress one bounded part at a time. Do not assemble a second model copy.
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    let produced = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (produced + value.length > part.bytes) throw new Error('中文模型解压长度无效。');
        output.set(value, offset + produced); produced += value.length;
      }
      if (produced !== part.bytes) throw new Error('中文模型解压不完整。');
    } catch (error) {
      await reader.cancel().catch(() => {});
      for (const name of [`${asset.name}.manifest.json`, part.file]) {
        try { await cache?.delete(new URL(name, base).href); } catch { /* Retry clean bytes. */ }
      }
      throw error;
    }
    finally { reader.releaseLock(); }
    offset += produced; loaded += part.compressedBytes;
  }
  if (await digest(output) !== asset.sha256) {
    // A structurally valid but inconsistent manifest must not poison retries.
    for (const name of [`${asset.name}.manifest.json`, ...manifest.parts.map(p => p.file)]) {
      try { await cache?.delete(new URL(name, base).href); } catch { /* Best effort. */ }
    }
    throw new Error('中文模型整体校验失败，请重试。');
  }
  progress({ file: asset.name, loaded, total, progress: 100, status: 'done' });
  return output;
}
