import { createVadEngine, VAD_POLICY } from './vad-engine.js';

// Independent model preflight; no ASR model/library is imported. One file per
// active analysis, PCM arrives in <=32-second transport chunks.
let enginePromise, active, busy = false;
const send = (type, id, fields = {}) => self.postMessage({ type, id, ...fields });
async function getEngine(id) {
  if (!enginePromise) enginePromise = createVadEngine({ progress: event => send('download', id, event) }).catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}
const retain = (id, reason, warning) => send('result', id, { skipAsr: false, reason, ...(warning ? { warning } : {}) });
self.addEventListener('message', async event => {
  const job = event.data;
  if (!job || !['start', 'chunk', 'finish', 'detect'].includes(job.type)) return;
  const { id } = job;
  if (busy) { retain(id, 'vad-busy'); return; }
  busy = true;
  try {
    if (job.type === 'start' || job.type === 'detect') {
      if (active) { retain(id, 'vad-busy'); return; }
      const sampleCount = job.type === 'detect' ? job.audio?.length : job.sampleCount;
      if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > VAD_POLICY.sampleRate * 1800) { retain(id, 'invalid-audio'); return; }
      if (job.forceSpeech) { retain(id, 'force-speech'); return; }
      if (job.contentMode && job.contentMode !== 'speech-only') { retain(id, 'lyrics-or-unknown'); return; }
      if (sampleCount < 32000) { retain(id, 'short-audio'); return; }
      send('status', id, { message: '正在本机检查音频是否有人声……' });
      const engine = await getEngine(id);
      const analysis = engine.begin(sampleCount, { earlyAccept: true, progress: progress => send('progress', id, progress) });
      active = { id, analysis };
      if (job.type === 'detect') {
        await analysis.push(job.audio);
        const decision = analysis.finish(); active = null; send('result', id, decision);
      } else send('ready', id);
    } else {
      if (!active || active.id !== id) { retain(id, 'invalid-stream'); return; }
      if (job.type === 'chunk') {
        if (!(job.audio instanceof Float32Array) || job.audio.length > 16000 * 32) throw new Error('人声检测音频块过大。');
        const progress = await active.analysis.push(job.audio);
        if (progress.done) { const decision = active.analysis.finish(); active = null; send('result', id, decision); }
        else send('chunk-ready', id, progress);
      } else {
        const decision = active.analysis.finish(); active = null; send('result', id, decision);
      }
    }
  } catch (error) {
    active?.analysis.cancel(); active = null;
    console.warn('[听写匣] 人声检测未完成，将继续转写：', error?.message || error);
    retain(id, 'vad-unavailable', '人声检查未完成，将继续转写。');
  } finally { busy = false; }
});
