import { createPunctuationEngine } from './punctuation-engine.js';

let enginePromise;
let busy = false;
self.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'punctuate') return;
  const { id, text } = data;
  if (busy) { self.postMessage({ type: 'error', id, message: '上一段文字仍在处理标点。' }); return; }
  busy = true;
  try {
    if (typeof text !== 'string' || text.length > 200000) throw new Error('文字过长，已保留原始标点。');
    if (!enginePromise) enginePromise = createPunctuationEngine({
      baseUrl: new URL(`${import.meta.env.BASE_URL}models-punctuation/`, self.location.origin).href,
      runtimeUrl: new URL(`${import.meta.env.BASE_URL}vendor/ort/`, self.location.origin).href,
      onProgress: progress => self.postMessage({ type: 'progress', ...progress }),
    }).catch(error => { enginePromise = undefined; throw error; });
    const engine = await enginePromise;
    const result = await engine.punctuate(text);
    self.postMessage({ type: 'result', id, text: result });
  } catch (error) {
    self.postMessage({ type: 'error', id, message: error.message || '自动标点未完成。' });
  } finally { busy = false; }
});
