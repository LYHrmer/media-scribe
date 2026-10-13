import { createOcrEngine } from './video-ocr-engine.js';

let enginePromise;
let currentKey;
let busy = false;
async function getEngine(id, config) {
  if (config || !enginePromise) {
    const baseUrl = new URL(config?.assetBaseUrl || `${import.meta.env.BASE_URL}models-ocr/`, self.location.origin);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !baseUrl.pathname.endsWith('/') || (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && baseUrl.origin === self.location.origin))) throw new Error('字幕模型下载入口无效。');
    const precision = config?.precision || 'standard';
    if (!['standard', 'enhanced'].includes(precision)) throw new Error('不支持的字幕识别精度。');
    const key = `${baseUrl.href}|${precision}`;
    if (currentKey !== key && enginePromise) {
      await (await enginePromise).dispose();
      enginePromise = undefined;
    }
    currentKey = key;
    if (!enginePromise) {
      enginePromise = createOcrEngine({
        baseUrl: baseUrl.href,
        precision,
        runtimeUrl: new URL(`${import.meta.env.BASE_URL}vendor/ort/`, self.location.origin).href,
        onProgress: progress => self.postMessage({ type: 'progress', id, ...progress }),
      }).catch(error => { enginePromise = undefined; throw error; });
    }
  }
  return enginePromise;
}
self.addEventListener('message', async ({ data }) => {
  const { id, type } = data || {};
  if (type !== 'initialize' && type !== 'recognize') return;
  if (busy) { self.postMessage({ type: 'error', id, message: '上一张视频画面仍在识别，请稍候。' }); return; }
  busy = true;
  try {
    const engine = await getEngine(id, type === 'initialize' ? data.config || {} : undefined);
    const result = type === 'initialize' ? { ready: true, model: engine.model }
      : await engine.recognize({ data: new Uint8ClampedArray(data.pixels), width: data.width, height: data.height }, data.options);
    self.postMessage({ type: 'result', id, result });
  } catch (error) {
    self.postMessage({ type: 'error', id, message: error.message || '视频字幕识别失败。' });
  } finally { busy = false; }
});
