import { installModelAssetFetch } from './model-assets.js';
import { findAudioRanges } from './audio-segments.js';

// This worker accepts only already-decoded local PCM, never an audio URL.
// Models are downloaded from the same site; no media is uploaded.
const MODEL_BASE_URL = new URL(`${import.meta.env.BASE_URL}models-v2/`, self.location.origin).href;
installModelAssetFetch(MODEL_BASE_URL);
const ALLOWED_MODELS = new Set(['Xenova/whisper-tiny', 'Xenova/whisper-small']);
const ALLOWED_LANGUAGES = new Set(['chinese', 'english']);
const ALLOWED_DECODINGS = new Set(['timestamps', 'text']);
const APPROXIMATE_TIMING_WARNING = '本次采用另一种正文解码尝试；字幕时间仅为音频段的粗略范围，需要对照原音核对。';
const SAMPLE_RATE = 16000;
const MAX_SAMPLES = SAMPLE_RATE * 30 * 60;
// Keep only one model resident: loading multiple models can exhaust the memory
// available to a browser tab. The UI serializes jobs and busy also guards here.
let cachedPipeline;
let libraryPromise;
let busy = false;

function send(type, id, data = {}) {
  self.postMessage({ type, id, ...data });
}

async function getLibrary() {
  if (!libraryPromise) {
    libraryPromise = import('@huggingface/transformers').then(library => {
      library.env.allowLocalModels = false;
      library.env.useBrowserCache = true;
      library.env.remoteHost = MODEL_BASE_URL;
      library.env.remotePathTemplate = '{model}/';
      // Single-threaded WASM works without SharedArrayBuffer/COOP/COEP headers.
      // We already run in a worker, so ONNX must not spawn its proxy worker.
      library.env.backends.onnx.wasm.numThreads = 1;
      library.env.backends.onnx.wasm.proxy = false;
      const runtimeBase = new URL(`${import.meta.env.BASE_URL}vendor/ort/`, self.location.origin).href;
      // Select the verified baseline runtime explicitly, so JSEP is not fetched
      // merely because the bundled runtime also contains that optional build.
      library.env.backends.onnx.wasm.wasmPaths = {
        mjs: new URL('ort-wasm-simd-threaded.mjs', runtimeBase).href,
        wasm: new URL('ort-wasm-simd-threaded.wasm', runtimeBase).href,
      };
      return library;
    }).catch(error => {
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

async function getTranscriber(model, id) {
  if (cachedPipeline?.model === model) {
    send('status', id, { message: '正在准备已加载的识别模型……' });
    return cachedPipeline.transcriber;
  }
  if (cachedPipeline) {
    send('status', id, { message: '正在释放上一模型的内存……' });
    // Do not start another model until release has completed. On disposal
    // failure, retain the handle so retrying the switch can retry disposal.
    await cachedPipeline.transcriber.dispose();
    cachedPipeline = undefined;
  }
  send('status', id, { message: '正在下载并准备识别模型，首次使用需要等待……' });
  const { pipeline } = await getLibrary();
  const transcriber = await pipeline('automatic-speech-recognition', model, {
    dtype: model === 'Xenova/whisper-small' ? 'q4f16' : 'q8',
    device: 'wasm',
    progress_callback: event => {
      send('download', id, {
        file: event.file || '',
        loaded: Number.isFinite(event.loaded) ? event.loaded : null,
        total: Number.isFinite(event.total) ? event.total : null,
        progress: Number.isFinite(event.progress) ? Math.max(0, Math.min(100, event.progress)) : null,
        status: event.status || 'progress',
      });
    },
  });
  // Failed library/model loads never become cached and can be retried.
  cachedPipeline = { model, transcriber };
  return transcriber;
}

function outputWarnings(text, activeSoundDuration) {
  const compact = text.replace(/[\p{P}\p{Z}\s]/gu, '');
  const warnings = [];
  // Four contiguous copies are suspicious but are not proof of a bad result.
  // Keep all original text/timestamps; never delete lyrics or invent confidence.
  if (/([\p{Script=Han}]{2,40})\1{3,}/u.test(compact)) {
    warnings.push('结果中有连续多次重复的文字，可能是模型误识别，也可能是原音重复。请对照原音检查，或尝试更大模型重新转写。');
  }
  // Sound may be speech, singing, music or noise. A sparse result warrants
  // checking against the source; it does not establish transcription accuracy.
  if (activeSoundDuration >= 15 && Array.from(compact).length <= Math.floor(activeSoundDuration * 0.5)) {
    warnings.push('音频中有声音的时段较长，但识别文字较少，可能存在漏识别。歌声、伴奏或现场回声较强时，请对照原音校对。');
  }
  return warnings;
}

function actionableError(error) {
  const message = String(error?.message || error);
  if (message.startsWith('MODEL_ASSET_FAILED:')) return message.slice('MODEL_ASSET_FAILED:'.length).trim();
  if (/\b(?:401|403)\b/.test(message)) {
    const status = message.match(/\b(?:401|403)\b/)[0];
    return `网站资源访问被拒绝（HTTP ${status}）。请在系统浏览器中打开后重试；如果仍显示「blocked」，需要站点托管方排查。`;
  }
  if (/memory|allocation|allocate|out of bounds|bad_alloc|oom/i.test(message)) {
    return '浏览器内存不足。请关闭其他页面，选择「快速」，或把音视频剪短后重试。';
  }
  if (/fetch|network|download|load.*file|locate.*file|404|502|503|504|import.*module/i.test(message)) {
    return '识别模型或运行文件未能下载。请检查网络并重试；模型由本网页提供，音视频仍留在本机。';
  }
  if (/webassembly|wasm|backend|unsupported|not supported|execution provider/i.test(message)) {
    return '这个浏览器未能启动本地识别。请使用较新的 Chrome / Edge，并关闭其他占用内存的页面后重试。';
  }
  return '本地识别未完成。请刷新页面，先用较短的音频和「快速」重试。';
}

function normalizeSegments(output, duration) {
  const segments = [];
  for (const chunk of output.chunks || []) {
    const text = String(chunk.text || '').trim();
    if (!text) continue;
    const rawStart = chunk.timestamp?.[0];
    const rawEnd = chunk.timestamp?.[1];
    const start = Math.max(segments.at(-1)?.start || 0, Math.min(duration, Number.isFinite(rawStart) ? rawStart : 0));
    const end = Math.min(duration, Number.isFinite(rawEnd) ? rawEnd : duration);
    if (end > start && Math.round(end * 1000) > Math.round(start * 1000)) segments.push({ start, end, text });
  }
  const text = String(output.text || '').trim();
  if (!segments.length && text && duration >= 0.001) segments.push({ start: 0, end: duration, text });
  return segments;
}

self.addEventListener('message', async event => {
  const job = event.data;
  if (!job || job.type !== 'transcribe') return;
  const { id } = job;
  if (busy) {
    send('error', id, { message: '正在处理上一份文件。请等待完成，或先停止当前任务。' });
    return;
  }
  busy = true;
  try {
    if (!(job.audio instanceof Float32Array) || !job.audio.length || job.audio.length > MAX_SAMPLES) {
      throw new Error('INPUT_INVALID');
    }
    if (!ALLOWED_MODELS.has(job.model || 'Xenova/whisper-tiny')) throw new Error('MODEL_INVALID');
    if (job.language && !ALLOWED_LANGUAGES.has(job.language)) throw new Error('LANGUAGE_INVALID');
    const decoding = job.decoding === undefined ? 'timestamps' : job.decoding;
    if (!ALLOWED_DECODINGS.has(decoding)) throw new Error('DECODING_INVALID');
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly not supported');
    const duration = job.audio.length / SAMPLE_RATE;
    const ranges = findAudioRanges(job.audio, SAMPLE_RATE);
    if (!ranges.length) {
      send('result', id, {
        text: '', segments: [], duration,
        decoding,
        ...(decoding === 'text' ? { timing: 'approximate' } : {}),
        warnings: ['没有检测到可识别的声音，音频可能无声或音量过低。请检查原音，也可以重新转写。',
          ...(decoding === 'text' ? [APPROXIMATE_TIMING_WARNING] : [])],
      });
      return;
    }
    const model = job.model || 'Xenova/whisper-tiny';
    const transcriber = await getTranscriber(model, id);
    send('status', id, { message: '正在本机识别声音……可以继续使用其他页面，请保持本页打开。' });
    const options = {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      return_timestamps: decoding !== 'text',
      // Transformers.js does not implement Whisper language detection here;
      // absent language falls back to English. This app defaults to Chinese.
      language: job.language || 'chinese',
    };
    const texts = [];
    const segments = [];
    for (const range of ranges) {
      const audio = range.start === 0 && range.end === job.audio.length
        ? job.audio : job.audio.subarray(range.start, range.end);
      const output = await transcriber(audio, options);
      const text = String(output.text || '').trim();
      if (text) texts.push(text);
      const offset = range.start / SAMPLE_RATE;
      if (decoding === 'text') {
        // Text-only generation is a distinct retry, not a timestamp aligner.
        // Ignore any stale/unexpected chunks and preserve this original range.
        const end = range.end / SAMPLE_RATE;
        if (text && Math.round(end * 1000) > Math.round(offset * 1000)) {
          segments.push({ start: offset, end, text });
        }
      } else {
        for (const segment of normalizeSegments(output, audio.length / SAMPLE_RATE)) {
          segments.push({ ...segment, start: segment.start + offset, end: segment.end + offset });
        }
      }
    }
    const text = texts.join('\n');
    const activeSoundDuration = ranges.reduce((total, range) => total + (range.end - range.start) / SAMPLE_RATE, 0);
    send('result', id, {
      text,
      segments,
      duration,
      decoding,
      ...(decoding === 'text' ? { timing: 'approximate' } : {}),
      warnings: [...outputWarnings(text, activeSoundDuration), ...(decoding === 'text' ? [APPROXIMATE_TIMING_WARNING] : [])],
    });
  } catch (error) {
    console.error('[听写匣] 本地识别错误：', error);
    let message;
    if (error?.message === 'INPUT_INVALID') message = '没有可识别的音频，或音频超过 30 分钟。请重新选择较短的文件。';
    else if (error?.message === 'MODEL_INVALID' || error?.message === 'LANGUAGE_INVALID') message = '模型或语言选项无效。请刷新页面后重试。';
    else if (error?.message === 'DECODING_INVALID') message = '正文解码方式无效。请刷新页面后重试。';
    else message = actionableError(error);
    send('error', id, { message });
  } finally {
    busy = false;
  }
});
