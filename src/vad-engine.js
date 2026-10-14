import * as ort from 'onnxruntime-web/wasm';
import { loadVadAsset } from './vad-assets.js';

export const VAD_POLICY = Object.freeze({ sampleRate: 16000, frameSamples: 512, contextSamples: 64, minimumSeconds: 2, weakProbability: 0.05, strongProbability: 0.5, minimumConsecutiveWeakFrames: 2 });
export function createVadEvidence() { return { maxProbability: 0, allProbabilitiesFinite: true, framesAtOrAboveThreshold: 0, weakRun: 0, longestConsecutiveWeakFrames: 0, hasStrongPeak: false }; }
export function observeVadProbability(evidence, probability) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) { evidence.allProbabilitiesFinite = false; evidence.weakRun = 0; return evidence; }
  evidence.maxProbability = Math.max(evidence.maxProbability, probability);
  if (probability >= VAD_POLICY.weakProbability) { evidence.framesAtOrAboveThreshold++; evidence.weakRun++; evidence.longestConsecutiveWeakFrames = Math.max(evidence.longestConsecutiveWeakFrames, evidence.weakRun); }
  else evidence.weakRun = 0;
  if (probability >= VAD_POLICY.strongProbability) evidence.hasStrongPeak = true;
  return evidence;
}
export function decideVadSkip({ sampleCount, checkedFrames, maxProbability, allProbabilitiesFinite, longestConsecutiveWeakFrames, hasStrongPeak, forceSpeech = false, contentMode = 'speech-only' }) {
  return !forceSpeech && contentMode === 'speech-only'
    && Number.isSafeInteger(sampleCount) && sampleCount >= VAD_POLICY.sampleRate * VAD_POLICY.minimumSeconds
    && checkedFrames === Math.ceil(sampleCount / VAD_POLICY.frameSamples)
    && allProbabilitiesFinite === true && hasStrongPeak === false
    && Number.isSafeInteger(longestConsecutiveWeakFrames) && longestConsecutiveWeakFrames >= 0 && longestConsecutiveWeakFrames < VAD_POLICY.minimumConsecutiveWeakFrames
    && Number.isFinite(maxProbability) && maxProbability >= 0 && maxProbability < VAD_POLICY.strongProbability
    && (maxProbability < VAD_POLICY.weakProbability || longestConsecutiveWeakFrames > 0);
}
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

// Whole-file low-voice candidate only. Never use standard .5 VAD intervals to
// remove audio: this model can classify real singing below the speech threshold.
export async function createVadEngine(options = {}) {
  const runtimeBase = options.runtimeBase || new URL(`${import.meta.env.BASE_URL}vendor/ort/`, self.location.origin).href;
  const modelBase = options.modelBase || new URL(`${import.meta.env.BASE_URL}models-vad/`, self.location.origin).href;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { mjs: new URL('ort-wasm-simd-threaded.mjs', runtimeBase).href, wasm: new URL('ort-wasm-simd-threaded.wasm', runtimeBase).href };
  const bytes = await loadVadAsset(modelBase, options.progress);
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  if (!['input', 'state', 'sr'].every(name => session.inputNames.includes(name))
    || !['output', 'stateN'].every(name => session.outputNames.includes(name))) {
    await session.release();
    throw new Error('人声检测模型格式不匹配。');
  }
  let busy = false, disposed = false;
  const retain = (reason, sampleCount) => ({ skipAsr: false, reason, duration: sampleCount / 16000, checkedFrames: 0, maxProbability: null, allProbabilitiesFinite: true });
  function begin(sampleCount, { forceSpeech = false, contentMode = 'speech-only', earlyAccept = false, progress = () => {} } = {}) {
    if (disposed) throw new Error('人声检测模型已经释放。');
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > 16000 * 1800) throw new Error('人声检测输入无效。');
    if (busy) throw new Error('人声检测正在处理上一份音频。');
    busy = true;
    // Recurrent state and context reset per FILE, not per transport chunk.
    let state = new Float32Array(256), context = new Float32Array(64);
    const evidence = createVadEvidence();
    let checkedFrames = 0, receivedSamples = 0;
    let processing = false, closed = false, lastProgressTime = 0, earlyDecision = null;
    const frameCount = Math.ceil(sampleCount / 512);
    const bypass = forceSpeech ? 'force-speech' : contentMode !== 'speech-only' ? 'lyrics-or-unknown' : sampleCount < 32000 ? 'short-audio' : null;
    const close = () => { closed = true; busy = false; };
    return {
      async push(chunk) {
        if (closed || processing) throw new Error('人声检测分块顺序无效。');
        if (!(chunk instanceof Float32Array) || !chunk.length || receivedSamples + chunk.length > sampleCount
          || (receivedSamples + chunk.length < sampleCount && chunk.length % 512 !== 0)) throw new Error('人声检测分块长度无效。');
        processing = true;
        try {
          if (!bypass) for (let offset = 0; offset < chunk.length; offset += 512) {
            if (closed) throw new DOMException('检测已取消。', 'AbortError');
            const input = new Float32Array(576);
            input.set(context);
            input.set(chunk.subarray(offset, Math.min(offset + 512, chunk.length)), 64);
            const feeds = { input: new ort.Tensor('float32', input, [1, 576]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr: new ort.Tensor('int64', new BigInt64Array([16000n]), []) };
            let outputs;
            try {
              outputs = await session.run(feeds);
              const probability = Number(outputs.output.data[0]);
              observeVadProbability(evidence, probability);
              state = new Float32Array(outputs.stateN.data);
              context = input.slice(-64);
              checkedFrames++;
              if (earlyAccept && (!evidence.allProbabilitiesFinite || evidence.hasStrongPeak || evidence.longestConsecutiveWeakFrames >= 2)) {
                earlyDecision = { skipAsr: false, reason: evidence.allProbabilitiesFinite ? 'voice-possible' : 'invalid-probability', duration: sampleCount / 16000, checkedFrames, maxProbability: null, observedMax: evidence.maxProbability, allProbabilitiesFinite: evidence.allProbabilitiesFinite, longestConsecutiveWeakFrames: evidence.longestConsecutiveWeakFrames, hasStrongPeak: evidence.hasStrongPeak, analysisComplete: false };
              }
            } finally {
              for (const tensor of Object.values(feeds)) tensor.dispose?.();
              if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose?.();
            }
            if (earlyDecision) break;
            // Every 4 frames yield to messages. Worker termination cancels immediately.
            if (checkedFrames % 4 === 0) {
              const now = performance.now();
              if (now - lastProgressTime >= 150) { progress({ phase: 'vad', completedFrames: checkedFrames, totalFrames: frameCount }); lastProgressTime = now; }
              await pause();
            }
          }
          receivedSamples += chunk.length;
          return { receivedSamples, totalSamples: sampleCount, done: Boolean(earlyDecision) };
        } catch (error) { close(); throw error; }
        finally { processing = false; }
      },
      finish() {
        if (closed || processing || (!earlyDecision && receivedSamples !== sampleCount)) throw new Error('人声检测尚未收到完整音频。');
        close();
        if (earlyDecision) return earlyDecision;
        if (bypass) return { ...retain(bypass, sampleCount), analysisComplete: false };
        progress({ phase: 'vad', completedFrames: frameCount, totalFrames: frameCount });
        const skipAsr = decideVadSkip({ sampleCount, checkedFrames, ...evidence, forceSpeech, contentMode });
        return { skipAsr, analysisComplete: true, reason: skipAsr ? 'low-voice-candidate' : evidence.allProbabilitiesFinite ? 'voice-possible' : 'invalid-probability', duration: sampleCount / 16000, checkedFrames, maxProbability: evidence.maxProbability, allProbabilitiesFinite: evidence.allProbabilitiesFinite, framesAtOrAboveThreshold: evidence.framesAtOrAboveThreshold, longestConsecutiveWeakFrames: evidence.longestConsecutiveWeakFrames, hasStrongPeak: evidence.hasStrongPeak };
      },
      cancel() { close(); },
    };
  }
  return {
    begin,
    async analyze(audio, options = {}) {
      if (!(audio instanceof Float32Array)) throw new Error('人声检测输入无效。');
      const analysis = begin(audio.length, options);
      try { await analysis.push(audio); return analysis.finish(); } catch (error) { analysis.cancel(); throw error; }
    },
    async dispose() { if (busy) throw new Error('人声检测仍在运行。'); if (!disposed) { await session.release(); disposed = true; } },
  };
}
