import { SENSEVOICE_ASSETS, SENSEVOICE_MODEL, loadSenseAsset } from './sensevoice-assets.js';
import { findAudioRanges } from './audio-segments.js';
import { normalizeSensePunctuation, senseResultSegments, splitSenseRanges } from './sensevoice-segments.js';

const BASE = new URL(`${import.meta.env.BASE_URL}models-sensevoice/`, self.location.origin).href;
let cached, busy = false;
const send = (type, id, data = {}) => self.postMessage({ type, id, ...data });

async function getRecognizer(language, decoding, id) {
  const key = `${language}:${decoding}`;
  if (cached?.key === key) return cached;
  // A recognizer's text-normalization setting is fixed at creation. Recreate it
  // on retry, actually changing inference rather than relabeling old text.
  if (cached) { cached.recognizer.free(); cached = null; }
  send('status', id, { message: '正在准备中文增强模型，首次使用需要下载……' });
  const progress = event => send('download', id, event);
  const wasm = await loadSenseAsset(BASE, SENSEVOICE_ASSETS.wasm, progress);
  const runtimeUrl = new URL('runtime.mjs', BASE).href;
  const apiUrl = new URL('asr.mjs', BASE).href;
  const { default: createModule } = await import(/* @vite-ignore */ runtimeUrl);
  const { OfflineRecognizer } = await import(/* @vite-ignore */ apiUrl);
  const module = await createModule({ wasmBinary: wasm, print: () => {}, printErr: text => console.error('[听写匣]', text) });
  const model = await loadSenseAsset(BASE, SENSEVOICE_ASSETS.model, progress);
  const tokens = await loadSenseAsset(BASE, SENSEVOICE_ASSETS.tokens, progress);
  module.FS_createDataFile('/', 'model.onnx', model, true, false, true);
  module.FS_createDataFile('/', 'tokens.txt', tokens, true, false, true);
  try {
    const recognizer = new OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: '/model.onnx', language: language === 'english' ? 'en' : 'zh', useInverseTextNormalization: decoding === 'text' ? 0 : 1 }, tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0 },
      decodingMethod: 'greedy_search',
    }, module);
    if (!recognizer.handle) throw new Error('中文增强模型未能初始化。');
    cached = { key, recognizer, module };
    return cached;
  } finally {
    // ONNX now owns the weights. Release the virtual files and download buffers.
    module.FS_unlink('/model.onnx'); module.FS_unlink('/tokens.txt');
  }
}

self.addEventListener('message', async ({ data: job }) => {
  if (job?.type !== 'transcribe') return;
  const { id } = job;
  if (busy) { send('error', id, { message: '正在识别上一份文件，请等待完成或停止。' }); return; }
  busy = true;
  try {
    if (!(job.audio instanceof Float32Array) || !job.audio.length || job.audio.length > 16000 * 1800) throw new Error('音频为空或超过 30 分钟。');
    if (job.model !== SENSEVOICE_MODEL || !['chinese', 'english'].includes(job.language) || !['timestamps', 'text'].includes(job.decoding || 'timestamps')) throw new Error('识别设置无效，请刷新重试。');
    // Validate PCM before passing it to the native feature extractor.
    for (const sample of job.audio) if (!Number.isFinite(sample)) throw new Error('音频数据无效，请重新选择文件。');
    const duration = job.audio.length / 16000;
    // SenseVoice needs the surrounding acoustic context: applying Whisper's
    // near-silence trims changed "开放" to "开饭" in the repeated-sentence
    // control. Keep complete bounded windows, skipping only fully quiet ones.
    const ranges = splitSenseRanges(job.audio, [{ start: 0, end: job.audio.length }])
      .filter(({ start, end }) => findAudioRanges(job.audio.subarray(start, end), 16000).length);
    const decoding = job.decoding || 'timestamps';
    if (!ranges.length) { send('result', id, { text: '', segments: [], duration, decoding, warnings: ['未检测到声音，请检查原音或重新转写。'] }); return; }
    const { recognizer } = await getRecognizer(job.language, decoding, id);
    const texts = [], originals = [], segments = [], warnings = [];
    let approximate = false;
    for (let i = 0; i < ranges.length; i++) {
      send('status', id, { message: `正在本机识别声音（${i + 1}/${ranges.length} 段）……` });
      const { start, end } = ranges[i];
      const stream = recognizer.createStream();
      try {
        stream.acceptWaveform(16000, job.audio.subarray(start, end));
        recognizer.decode(stream);
        const raw = recognizer.getResult(stream);
        if (raw.text?.trim()) originals.push(raw.text.trim());
        const output = normalizeSensePunctuation(raw);
        if (output.text?.trim()) texts.push(output.text.trim());
        const cues = senseResultSegments(output, (end - start) / 16000, start / 16000);
        segments.push(...cues.segments); approximate ||= cues.approximate;
      } finally { stream.free(); }
    }
    const text = texts.join('\n');
    if (decoding === 'text') warnings.push('本次按原话识别，数字可能写为汉字。号码、人名和听不清的内容仍需核对。');
    if (approximate) warnings.push('部分片段缺少有效逐字时间，已保留对应音频段的粗略范围。');
    if (duration >= 15 && text.replace(/[\p{P}\p{Z}\s]/gu, '').length < duration / 2) warnings.push('识别文字偏少，可能存在漏字。可切换其他识别方式重新转写。');
    const rawText = originals.join('\n');
    send('result', id, { text, segments, duration, decoding, ...(rawText !== text ? { rawText } : {}), ...(approximate ? { timing: 'approximate' } : {}), warnings });
  } catch (error) {
    console.error('[听写匣] 中文增强识别错误', error);
    const message = String(error?.message || error);
    send('error', id, { message: /memory|allocation|out of bounds|bad_alloc|oom/i.test(message)
      ? '浏览器内存不足，请关闭其他页面、剪短音频，或选择「快速」重试。'
      : /fetch|network|import.*module|load.*file/i.test(message) ? '中文识别资源下载失败，请检查网络后重试，或切换其他模型。' : error?.message || '中文增强识别未完成，请切换其他模型重试。' });
  } finally { busy = false; }
});
