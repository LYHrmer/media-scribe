// Silero VAD, MIT. Pinned to the official model at revision below.
export const VAD_ASSET = Object.freeze({
  name: 'silero-vad-1e261b03.onnx',
  bytes: 2327524,
  sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  revision: '1e261b036686cd0017d500ee96acd1c4ba572a9d',
  source: 'https://raw.githubusercontent.com/snakers4/silero-vad/1e261b036686cd0017d500ee96acd1c4ba572a9d/src/silero_vad/data/silero_vad.onnx',
});

export async function loadVadAsset(baseUrl, progress = () => {}) {
  const location = globalThis.location || globalThis.self?.location;
  const base = new URL(baseUrl, location?.href);
  if (base.origin !== location?.origin || !['https:', 'http:'].includes(base.protocol)
    || base.username || base.password || base.search || base.hash) {
    throw new Error('人声检测模型必须由当前网页提供。');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(VAD_ASSET.name, base);
  let cache;
  try { cache = await (globalThis.caches || globalThis.self?.caches)?.open('tingxie-silero-vad-verified-v1'); } catch { /* Optional cache. */ }
  const verify = async response => {
    if (!response.ok) throw new Error(`人声检测模型下载失败（HTTP ${response.status}）。`);
    if (/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('人声检测模型下载成了网页，请重试。');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== VAD_ASSET.bytes) throw new Error('人声检测模型下载不完整，请重试。');
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    if (sha !== VAD_ASSET.sha256) throw new Error('人声检测模型校验失败，请重试。');
    return bytes;
  };
  let cached;
  try { cached = await cache?.match(url.href); } catch { /* Fetch without cache. */ }
  if (cached) {
    try { return await verify(cached); }
    catch { try { await cache.delete(url.href); } catch { /* Fetch clean bytes. */ } }
  }
  progress({ phase: 'download', file: VAD_ASSET.name, loaded: 0, total: VAD_ASSET.bytes });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let response;
  try { response = await fetch(url.href, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal }); }
  catch (error) { clearTimeout(timeout); throw error; }
  if (response.type === 'opaqueredirect' || (response.url && new URL(response.url).origin !== base.origin)) { clearTimeout(timeout); throw new Error('人声检测模型下载被重定向，请重试。'); }
  const copy = response.clone();
  let bytes;
  try { bytes = await verify(response); } finally { clearTimeout(timeout); }
  try { await cache?.put(url.href, copy); } catch { /* Quota/private mode must not break detection. */ }
  progress({ phase: 'download', file: VAD_ASSET.name, loaded: VAD_ASSET.bytes, total: VAD_ASSET.bytes });
  return bytes;
}
