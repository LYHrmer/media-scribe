const CHUNK_SAMPLES = 16000 * 32; // ~2 MB; exactly 1000 Silero frames.
const aborted = () => new DOMException('人声检测已取消。', 'AbortError');

// Keep the original decoded PCM usable for ASR/retry. Send just one small copied
// chunk at a time; only transfer that copy, never samples.buffer.
export async function evaluateSpeechPresence(samples, { signal, onProgress = () => {}, forceSpeech = false, contentMode = 'speech-only' } = {}) {
  if (signal?.aborted) throw aborted();
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > 16000 * 1800) throw new Error('人声检测输入无效。');
  const retain = reason => ({ reject: false, reason, maxProbability: null, analysisComplete: false });
  if (forceSpeech) return retain('force-speech');
  if (contentMode !== 'speech-only') return retain('lyrics-or-unknown');
  if (samples.length < 32000) return retain('short-audio');
  if (typeof Worker === 'undefined') return { ...retain('vad-unavailable'), warning: '人声检查未完成，将继续转写。' };
  return new Promise((resolve, reject) => {
    let worker, finished = false, offset = 0;
    const id = 'vad';
    const cleanUp = () => { signal?.removeEventListener('abort', cancel); worker?.terminate(); };
    const settle = (value, error) => { if (finished) return; finished = true; cleanUp(); if (error) reject(error); else resolve(value); };
    const cancel = () => settle(null, aborted());
    const nextChunk = () => {
      if (signal?.aborted) { cancel(); return; }
      if (offset === samples.length) { worker.postMessage({ type: 'finish', id }); return; }
      const end = Math.min(samples.length, offset + CHUNK_SAMPLES);
      const audio = samples.slice(offset, end);
      offset = end;
      worker.postMessage({ type: 'chunk', id, audio }, [audio.buffer]);
    };
    try {
      worker = new Worker(new URL('./vad.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (finished || data?.id !== id) return;
        try {
          if (data.type === 'ready' || data.type === 'chunk-ready') nextChunk();
          else if (data.type === 'result') settle({ reject: data.skipAsr === true, maxProbability: data.maxProbability ?? null, reason: data.reason, duration: data.duration, analysisComplete: data.analysisComplete === true, ...(data.observedMax === undefined ? {} : { observedMax: data.observedMax }), ...(data.warning ? { warning: data.warning } : {}) });
          else onProgress(data);
        } catch (error) { settle({ ...retain('vad-unavailable'), warning: '人声检查未完成，将继续转写。' }); }
      };
      worker.onerror = () => settle({ ...retain('vad-unavailable'), warning: '人声检查未完成，将继续转写。' });
      worker.onmessageerror = worker.onerror;
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      worker.postMessage({ type: 'start', id, sampleCount: samples.length, forceSpeech, contentMode });
    } catch { settle({ ...retain('vad-unavailable'), warning: '人声检查未完成，将继续转写。' }); }
  });
}
