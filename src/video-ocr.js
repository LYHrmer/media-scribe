// Only RGBA pixels leave the UI thread. Frames, audio and videos never leave
// the browser. Terminating this worker cancels inference and frees its memory.
export function createVideoOcrClient({ signal, onProgress = () => {}, assetBaseUrl, precision = 'standard' } = {}) {
  const worker = new Worker(new URL('./video-ocr.worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const abortError = () => new DOMException('已停止视频字幕识别。', 'AbortError');
  function dispose() {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const { reject } of pending.values()) reject(abortError());
    pending.clear();
    signal?.removeEventListener('abort', dispose);
  }
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { onProgress(data); return; }
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.type === 'error') item.reject(new Error(data.message));
    else item.resolve(data.result);
  };
  worker.onerror = event => {
    for (const { reject } of pending.values()) reject(new Error(event.message || '字幕识别运行库加载失败。'));
    pending.clear();
    dispose();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  function request(type, payload = {}, transfer = []) {
    if (closed) return Promise.reject(abortError());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...payload }, transfer);
    });
  }
  return {
    initialize: (options = {}) => request('initialize', { config: {
      assetBaseUrl: options.assetBaseUrl ?? assetBaseUrl,
      precision: options.precision ?? precision,
    } }),
    async recognize(frame, options = {}) {
      if (!(frame?.data instanceof Uint8ClampedArray || frame?.data instanceof Uint8Array)) throw new Error('需要 RGBA 视频画面。');
      const pixels = new Uint8ClampedArray(frame.data);
      return request('recognize', { width: frame.width, height: frame.height, pixels: pixels.buffer, options }, [pixels.buffer]);
    },
    dispose,
  };
}
