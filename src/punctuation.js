import { needsPunctuation, punctuationSegments } from './punctuation-text.js';

export function createPunctuationClient({ signal, onProgress = () => {} } = {}) {
  const worker = new Worker(new URL('./punctuation.worker.js', import.meta.url), { type: 'module' });
  let nextId = 0, closed = false;
  const pending = new Map();
  const abortError = () => new DOMException('已停止标点处理。', 'AbortError');
  function dispose() {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const request of pending.values()) request.reject(abortError());
    pending.clear();
    signal?.removeEventListener('abort', dispose);
  }
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { onProgress(data); return; }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    data.type === 'error' ? request.reject(new Error(data.message)) : request.resolve(data.text);
  };
  worker.onerror = event => {
    for (const request of pending.values()) request.reject(new Error(event.message || '自动标点运行库加载失败。'));
    pending.clear(); dispose();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return {
    punctuate(text) {
      if (closed) return Promise.reject(abortError());
      if (!needsPunctuation(text)) return Promise.resolve(text);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'punctuate', id, text });
      });
    },
    dispose,
  };
}

/** Model punctuation never supplies missing spoken/OCR characters. */
export async function punctuateResult(result, options = {}) {
  if (!needsPunctuation(result?.text)) return result;
  let client;
  try {
    client = createPunctuationClient(options);
    const text = await client.punctuate(result.text);
    const segments = punctuationSegments(result.text, text, result.segments || []);
    const warnings = [...(result.warnings || [])];
    if (segments === null) warnings.push('正文已补标点；原文与字幕时间段不能逐字对齐，时间轴保留原始文字。');
    return { ...result, rawText: result.rawText ?? result.text, text,
      segments: segments ?? result.segments, warnings };
  } catch (error) {
    if (options.signal?.aborted || error.name === 'AbortError') throw error;
    return { ...result, warnings: [...(result.warnings || []), `自动标点未完成，原文已保留：${error.message}`] };
  } finally { client?.dispose(); }
}
