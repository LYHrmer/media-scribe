import './styles.css';
import { decodeAudio, MAX_FILE_BYTES } from './audio.js';
import { renderTxt, renderSrt, renderVtt, renderJson, downloadText } from './exports.js';
import { isVideoFile, readVideoFrames } from './video-frames.js';
import { createVideoOcrClient } from './video-ocr.js';
import { fuseVideoCaptions } from './video-captions.js';
import { punctuateResult } from './punctuation.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'file-input', 'drop-zone', 'file-queue', 'clear-files', 'inline-error',
  'language', 'model', 'settings-summary', 'start-button', 'start-label',
  'stop-button', 'progress-region', 'progress-stage', 'progress-count',
  'progress-track', 'progress-fill', 'progress-message', 'result-meta',
  'text-tab', 'timeline-tab', 'text-view', 'timeline-view', 'output-empty',
  'empty-title', 'empty-description', 'transcript', 'character-count',
  'copy-button', 'copy-label', 'export-format', 'export-button',
  'rerun-actions', 'rerun-button', 'restore-button', 'rerun-help', 'result-warning',
  'audio-input', 'video-input', 'single-file-input', 'choose-audio', 'choose-video',
  'picker-help', 'picker-status', 'browser-link', 'copy-link',
  'recognition-source', 'visual-candidates', 'visual-candidate-list',
].map(id => [id, $(id)]));

if (import.meta.env.VITE_COMPACT_BUILD === '1') {
  ui.model.querySelector('option[value="Xenova/whisper-tiny"]')?.remove();
  ui.model.value = 'Xenova/whisper-small';
  $('model-help').textContent = '默认按中文、高精度识别，可切换为英语。语音模型首次下载约 190 MB，需要一定时间与内存；画面识别使用另一份较小的模型。部分视频编码可能不受浏览器支持，可先转换为 MP3 或 WAV。';
}

const fileInputs = ['file-input', 'audio-input', 'video-input', 'single-file-input'];
const pickerControls = [...fileInputs, 'drop-zone', 'choose-audio', 'choose-video'];
ui['browser-link'].value = new URL(import.meta.env.BASE_URL, window.location.origin).href;

function pickerStatus(message = '') {
  ui['picker-status'].textContent = message;
  ui['picker-status'].hidden = !message;
}

function openPicker(id) {
  if (busy) return;
  pickerStatus();
  // Keep this synchronous inside the user's click: mobile pickers need the
  // original activation. The default input has no accept filter; media is
  // validated after selection, avoiding mixed-MIME native handler matching.
  try { ui[id].click(); }
  catch {
    ui['picker-help'].open = true;
    pickerStatus('浏览器未能打开文件选择。请试「手机推荐」单文件入口，或在系统浏览器中打开。');
  }
}

async function copyBrowserLink() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText(ui['browser-link'].value);
    pickerStatus('网址已复制。请粘贴到系统浏览器地址栏打开。');
  } catch {
    ui['browser-link'].focus();
    ui['browser-link'].select();
    pickerStatus('请长按已选中的网址，选择复制，再粘贴到系统浏览器地址栏。');
  }
}

const queue = [];
let selectedId = null;
let worker = null;
let activeJob = null;
let busy = false;
let runToken = 0;
let nextId = 0;
let activeFileId = null;
let currentTab = 'text';
let outputRenderKey = '';
let errorMessage = '';
let copyTimer;
let modelSelectionRevision = 0;
let activeAbort = null;
let progress = { stage: '', message: '', percent: null };

const statusLabels = { pending: '待转写', decoding: '读取中', running: '转写中', done: '已完成', error: '未完成', canceled: '已停止' };
const fileIcon = '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 2h5l3 3v10H5V2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 7v5m-2-3v1m4-2v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

function selectedEntry() { return queue.find(entry => entry.id === selectedId); }
function canRun(entry) { return entry.status === 'pending' || entry.status === 'canceled'; }
function modelLabel(model) {
  const name = model?.split('/').at(-1).replace(/^whisper-/, '');
  return { tiny: '快速', base: '标准', small: '高精度' }[name] || model || '未记录';
}
function languageLabel(language) { return { chinese: '中文', english: '英语' }[language] || '未记录'; }
function resultRevision(entry) { return { result: entry.result, draft: entry.draft, model: entry.model, language: entry.language, modelSelectionRevision: entry.modelSelectionRevision, visualCandidates: entry.visualCandidates, sourceMode: entry.sourceMode }; }
function shouldUpgradeOnRerun(entry) {
  return Boolean(entry?.result && entry.result.source !== 'video_ocr' && entry.model === 'Xenova/whisper-tiny'
    && ui.model.value === entry.model && modelSelectionRevision === entry.modelSelectionRevision);
}
function bytesLabel(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function timeLabel(seconds) {
  const rounded = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor(rounded % 3600 / 60);
  const s = rounded % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function showError(message) {
  errorMessage = message || '';
  ui['inline-error'].textContent = errorMessage;
  ui['inline-error'].hidden = !errorMessage;
}

function renderQueue() {
  ui['file-queue'].hidden = !queue.length;
  ui['clear-files'].hidden = !queue.length;
  ui['file-queue'].replaceChildren(...queue.map(entry => {
    const row = document.createElement('div');
    row.className = `queue-row${entry.id === selectedId ? ' selected' : ''}`;
    const icon = document.createElement('span');
    icon.className = 'queue-file-icon';
    icon.innerHTML = fileIcon;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'queue-select';
    select.setAttribute('aria-label', `查看 ${entry.file.name}，${statusLabels[entry.status]}`);
    select.setAttribute('aria-pressed', String(entry.id === selectedId));
    const filename = document.createElement('span');
    filename.className = 'queue-filename';
    filename.textContent = entry.file.name;
    filename.title = entry.file.name;
    const detail = document.createElement('span');
    detail.className = 'queue-detail';
    detail.textContent = `${bytesLabel(entry.file.size)}${entry.result ? ` · ${timeLabel(entry.result.duration)}` : ''}`;
    select.append(filename, detail);
    select.addEventListener('click', () => { selectedId = entry.id; renderQueue(); renderOutput(); });
    const status = document.createElement('span');
    status.className = `queue-state ${entry.status}`;
    status.textContent = statusLabels[entry.status];
    row.append(icon, select, status);
    if (!busy) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-file';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除 ${entry.file.name}`);
      remove.addEventListener('click', () => {
        queue.splice(queue.indexOf(entry), 1);
        if (selectedId === entry.id) selectedId = queue[0]?.id || null;
        render();
      });
      row.append(remove);
    }
    return row;
  }));
}

function renderControls() {
  const pending = queue.filter(canRun).length;
  const failed = queue.some(entry => entry.status === 'error');
  ui['start-button'].disabled = busy || (!pending && !failed);
  ui['start-label'].textContent = busy ? '正在转写…' : pending ? `开始转写${pending > 1 ? ` ${pending} 个文件` : ''}` : failed ? '重试未完成文件' : queue.length ? '转写已完成' : '开始转写';
  ui['stop-button'].hidden = !busy;
  for (const id of pickerControls) ui[id].disabled = busy;
  ui['clear-files'].disabled = busy;
  ui.language.disabled = busy;
  ui.model.disabled = busy;
  ui['recognition-source'].disabled = busy;
  const mode = { auto: '自动', audio: '仅声音', video: '仅画面' }[ui['recognition-source'].value] || '自动';
  ui['settings-summary'].textContent = `${languageLabel(ui.language.value)} · ${mode} · ${modelLabel(ui.model.value)}`;
}

function renderProgress() {
  ui['progress-region'].hidden = !busy;
  if (!busy) return;
  ui['progress-stage'].textContent = progress.stage;
  const index = queue.findIndex(entry => entry.id === activeFileId);
  ui['progress-count'].textContent = index >= 0 ? `第 ${index + 1} / ${queue.length} 个文件` : '';
  ui['progress-message'].textContent = progress.message;
  const numeric = Number.isFinite(progress.percent);
  ui['progress-track'].classList.toggle('indeterminate', !numeric);
  ui['progress-fill'].style.width = numeric ? `${Math.max(0, Math.min(100, progress.percent))}%` : '';
  if (numeric) ui['progress-track'].setAttribute('aria-valuenow', String(Math.round(progress.percent)));
  else ui['progress-track'].removeAttribute('aria-valuenow');
  ui['progress-track'].setAttribute('aria-valuetext', numeric ? `${progress.stage} ${Math.round(progress.percent)}%` : progress.stage);
}

function renderOutput() {
  const entry = selectedEntry();
  const hasResult = Boolean(entry?.result);
  const key = `${entry?.id || ''}:${entry?.status || ''}:${entry?.revision || 0}:${currentTab}`;
  const rerunning = hasResult && busy && activeFileId === entry.id;
  const textReady = hasResult && entry.draft.trim().length > 0;
  ui['copy-button'].disabled = !textReady;
  ui['export-button'].disabled = !hasResult;
  ui['export-format'].disabled = !hasResult;
  ui['character-count'].textContent = `${hasResult ? [...entry.draft].length.toLocaleString('zh-CN') : 0} 个字符`;
  ui['result-meta'].textContent = hasResult ? `${timeLabel(entry.result.duration)} · ${entry.result.source === 'video_ocr' ? '画面字幕 · 待核对' : `${modelLabel(entry.model)} · ${languageLabel(entry.language)}`}` : '可编辑 · 可导出';
  ui['rerun-actions'].hidden = !hasResult;
  ui['rerun-button'].disabled = busy || !hasResult;
  ui['restore-button'].hidden = !entry?.previousRevision;
  ui['restore-button'].disabled = busy || !entry?.previousRevision;
  ui.transcript.disabled = Boolean(rerunning);
  const rerunHelp = '可在更多设置中切换画面 / 声音和精度，再重新转写；相同设置通常结果相同。';
  ui['rerun-help'].textContent = rerunning ? '正在重新转写，原结果已保留。停止或失败后，仍可使用原结果。' : hasResult && entry.error ? `重新转写未完成：${entry.error} 原结果已保留，可再试一次。` : shouldUpgradeOnRerun(entry) ? `未切换精度时，重转将改用高精度，下载约 190 MB 且更慢。${rerunHelp}` : rerunHelp;
  const warnings = Array.isArray(entry?.result?.warnings) ? entry.result.warnings.filter(message => typeof message === 'string' && message.trim()) : [];
  ui['result-warning'].hidden = !warnings.length;
  ui['result-warning'].textContent = warnings.join(' ');
  const candidates = Array.isArray(entry?.visualCandidates) ? entry.visualCandidates : [];
  ui['visual-candidates'].hidden = !candidates.length;
  ui['text-tab'].classList.toggle('active', currentTab === 'text');
  ui['timeline-tab'].classList.toggle('active', currentTab === 'timeline');
  ui['text-tab'].setAttribute('aria-selected', String(currentTab === 'text'));
  ui['timeline-tab'].setAttribute('aria-selected', String(currentTab === 'timeline'));
  ui['text-tab'].tabIndex = currentTab === 'text' ? 0 : -1;
  ui['timeline-tab'].tabIndex = currentTab === 'timeline' ? 0 : -1;
  ui['output-empty'].hidden = hasResult;
  ui['text-view'].hidden = !hasResult || currentTab !== 'text';
  ui['timeline-view'].hidden = !hasResult || currentTab !== 'timeline';
  if (outputRenderKey === key) return;
  outputRenderKey = key;
  ui['visual-candidate-list'].replaceChildren(...candidates.map(candidate => {
    const row = document.createElement('p');
    const text = String(candidate.text || '').trim();
    const reason = { static_text: '固定文字，请确认是否为字幕', needs_review: '字形不清或多帧读数不同' }[candidate.reason] || candidate.reason;
    const alternatives = [...new Set((candidate.alternatives || []).map(item => item.text).filter(Boolean))].slice(0, 3);
    row.textContent = `${timeLabel(candidate.start ?? candidate.time ?? 0)} · ${text}${reason ? `（${reason}）` : ''}${alternatives.length > 1 ? ` 可对照：${alternatives.join(' / ')}` : ''}`;
    return row;
  }));
  if (!hasResult) {
    const title = !entry ? '留一份文字，少一次回放' : entry.status === 'error' ? '这份文件暂未完成' : entry.status === 'canceled' ? '转写已停止' : ['running', 'decoding'].includes(entry.status) ? '正在把声音变成文字' : '文件已就位';
    const description = !entry ? '添加文件，点击「开始转写」。\n完成后可校对文字、复制或导出字幕。' : entry.status === 'error' ? entry.error : entry.status === 'canceled' ? '已完成的文件会保留。点击「开始转写」可重试这份文件。' : ['running', 'decoding'].includes(entry.status) ? '请保持页面打开。长录音需要更长时间，完成后会自动显示。' : '点击「开始转写」，完成后文字就会出现在这里。';
    ui['empty-title'].textContent = title;
    ui['empty-description'].textContent = description;
    ui['empty-description'].style.whiteSpace = 'pre-line';
    return;
  }
  ui.transcript.value = entry.draft;
  const segments = entry.result.segments || [];
  const rows = segments.map(segment => {
    const row = document.createElement('div');
    row.className = 'timeline-row';
    const time = document.createElement('span');
    time.className = 'timeline-time';
    time.textContent = `${timeLabel(segment.start)} – ${timeLabel(segment.end)}`;
    const text = document.createElement('span');
    text.className = 'timeline-text';
    text.textContent = segment.text;
    row.append(time, text);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'timeline-empty';
    empty.textContent = '这份文件没有识别到可用的文字时间段。';
    rows.push(empty);
  }
  ui['timeline-view'].replaceChildren(...rows);
}

function render() { renderQueue(); renderControls(); renderProgress(); renderOutput(); showError(errorMessage); }

function addFiles(files) {
  if (busy) return;
  const errors = [];
  for (const file of files) {
    if (!file.size) { errors.push(`${file.name} 是空文件。`); continue; }
    if (file.size > MAX_FILE_BYTES) { errors.push(`${file.name} 超过 300 MB，请剪短或压缩后再添加。`); continue; }
    if (!/^(audio|video)\//.test(file.type) && !/\.(wav|mp3|m4a|mp4|m4v|webm|ogg|flac|aac|mov|mkv|opus|aiff?|wma|avi)$/i.test(file.name)) {
      errors.push(`${file.name} 不是可识别的音视频文件。`);
      continue;
    }
    if (queue.some(entry => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified)) continue;
    const entry = { id: `file-${++nextId}`, file, status: 'pending', result: null, draft: '', error: '', revision: 0, previousRevision: null };
    queue.push(entry);
    if (!selectedId) selectedId = entry.id;
  }
  showError(errors.join(' '));
  for (const id of fileInputs) ui[id].value = '';
  pickerStatus();
  render();
}

function cancelError() { const error = new Error('CANCELED'); error.name = 'AbortError'; return error; }

function ensureWorker() {
  if (worker) return worker;
  const instance = new Worker(new URL('./transcriber.worker.js', import.meta.url), { type: 'module' });
  worker = instance;
  instance.onmessage = event => {
    const data = event.data;
    if (instance !== worker || !activeJob || data?.id !== activeJob.id) return;
    if (data.type === 'download') {
      progress.stage = '正在下载识别模型';
      progress.percent = data.status === 'progress' && Number.isFinite(data.progress) ? data.progress : null;
      progress.message = data.total > 0 && data.loaded >= 0
        ? `当前模型文件 ${bytesLabel(data.loaded)} / ${bytesLabel(data.total)}。只下载模型，音视频留在本机。`
        : '首次使用需要联网获取模型；已缓存的文件会优先复用。';
      renderProgress();
    } else if (data.type === 'status') {
      progress.stage = /模型/.test(data.message) ? '正在准备识别模型' : '正在本机转写';
      progress.message = data.message;
      progress.percent = null;
      renderProgress();
    } else if (data.type === 'result' || data.type === 'error') {
      const job = activeJob;
      activeJob = null;
      if (data.type === 'result') job.resolve({ text: data.text || '', segments: data.segments || [], duration: data.duration, warnings: Array.isArray(data.warnings) ? data.warnings : [] });
      else job.reject(new Error(data.message || '这份文件未能完成识别，请重试。'));
    }
  };
  const fatal = event => {
    event.preventDefault?.();
    if (instance !== worker) return;
    instance.terminate();
    worker = null;
    const job = activeJob;
    activeJob = null;
    job?.reject(new Error('本地识别文件未能加载，请检查网络并刷新重试。如果出现「blocked」或 401 / 403，请复制网址到系统浏览器；仍被拒绝时，需要站点托管方排查。'));
  };
  instance.onerror = fatal;
  instance.onmessageerror = fatal;
  return instance;
}

function transcribe(audio, entry, token, settings) {
  return new Promise((resolve, reject) => {
    try {
      const instance = ensureWorker();
      const id = `${entry.id}-run-${token}`;
      activeJob = { id, resolve, reject };
      instance.postMessage({ type: 'transcribe', id, audio, model: settings.model, language: settings.language }, [audio.buffer]);
    } catch (error) { activeJob = null; reject(error); }
  });
}

async function startQueue() {
  if (busy) return;
  if (!queue.some(canRun)) queue.filter(entry => entry.status === 'error').forEach(entry => { entry.status = 'pending'; });
  const pending = queue.filter(canRun);
  if (!pending.length) return;
  await runEntries(pending);
}

async function rerunSelected() {
  const entry = selectedEntry();
  if (busy || !entry?.result) return;
  if (shouldUpgradeOnRerun(entry)) ui.model.value = 'Xenova/whisper-small';
  await runEntries([entry]);
}

function restorePrevious() {
  const entry = selectedEntry();
  if (busy || !entry?.previousRevision) return;
  Object.assign(entry, entry.previousRevision);
  entry.previousRevision = null;
  entry.revision++;
  entry.status = 'done';
  entry.error = '';
  showError('');
  render();
}

async function recognizeVideo(entry, token, signal) {
  const frames = [];
  let client;
  // Do not hold both ASR and OCR model heaps on a phone at the same time.
  worker?.terminate();
  worker = null;
  try {
    const metadata = await readVideoFrames(entry.file, {
      signal,
      onMetadata: info => {
        if (token !== runToken) return;
        entry.status = 'running';
        progress = { stage: '正在读取画面字幕', percent: 0, message: `将检查整段视频的 ${info.frameCount} 帧画面。${info.sparse ? '长视频采用分散抽样，短暂字幕可能遗漏。' : ''}文件留在本机。` };
        render();
      },
      onFrame: async ({ time, pixels, index, frameCount, width, height }) => {
        if (signal.aborted || token !== runToken) throw cancelError();
        if (!client) {
          client = createVideoOcrClient({ signal, onProgress: data => {
            if (token !== runToken) return;
            progress = { stage: '正在准备画面识别模型', percent: null, message: data.message || '首次使用将下载本地字幕识别模型。视频不会上传。' };
            renderProgress();
          } });
          await client.initialize();
        }
        const result = await client.recognize(pixels, { maxSide: 1920 });
        if (signal.aborted || token !== runToken) throw cancelError();
        frames.push({ time, width, height, texts: result.texts || [] });
        progress = { stage: '正在读取画面字幕', percent: ((index + 1) / frameCount) * 100, message: `已检查 ${index + 1} / ${frameCount} 帧（${timeLabel(time)}）。正在对照多帧，保留有重复证据的文字。` };
        renderProgress();
      },
    });
    const captions = fuseVideoCaptions(frames, { duration: metadata.duration, sampleInterval: metadata.sampleInterval });
    entry.visualCandidates = captions.candidates || [];
    entry.revision++;
    const segments = captions.segments || [];
    const warnings = [...(captions.warnings || [])];
    if (metadata.sparse) warnings.push('长视频采用全时段抽样，短暂出现的字幕可能遗漏；需要完整语音时可切换「仅识别声音」。');
    if (captions.reliable && segments.length) {
      warnings.unshift('结果来自画面文字，尚未与声音逐字核验；可能包含歌词、标题或其他屏幕文字。时间轴为字幕出现的抽样时间，可能有误差。');
      warnings.push('画面中没有出现或看不清的内容可能遗漏。可切换「仅识别声音」重新转写，并用「恢复上一版」比较。');
      return { source: 'video_ocr', text: segments.map(segment => segment.text).join('\n'), segments, duration: metadata.duration, warnings };
    }
    return null;
  } finally {
    client?.dispose();
  }
}

async function recognizeEntry(entry, token, settings, signal) {
  const warnings = [];
  const video = isVideoFile(entry.file);
  if (settings.sourceMode === 'video' && !video) throw new Error('「仅识别画面字幕」需要视频文件。音频请切换「自动」或「仅识别声音」。');
  if (video && settings.sourceMode !== 'audio') {
    progress = { stage: '正在读取视频画面', message: '先检查画面中的字幕，识别过程在本机完成。', percent: null };
    renderProgress();
    try {
      const result = await recognizeVideo(entry, token, signal);
      if (result) return result;
      if (settings.sourceMode === 'video') throw new Error(`没有发现证据足够的重复字幕。可查看下方画面文字候选，或切换「仅识别声音」。${entry.result ? '原结果已保留。' : ''}`);
      warnings.push('未找到足够可靠的画面字幕，本次已改用声音识别。可疑画面文字保留在候选中，未拼入正文。');
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError' || token !== runToken) throw cancelError();
      if (settings.sourceMode === 'video') throw error;
      warnings.push(`画面字幕识别未完成，已改用声音识别：${error.message}`);
    }
  }
  if (signal.aborted || token !== runToken) throw cancelError();
  entry.status = 'decoding';
  progress = { stage: '正在读取声音', message: warnings.length ? `${warnings.at(-1)} 正在本机读取音轨。` : '正在浏览器中读取和整理音频，文件不会上传。', percent: null };
  render();
  const decoded = await decodeAudio(entry.file, { onStatus: message => {
    if (token === runToken) { progress.message = message; renderProgress(); }
  } });
  if (signal.aborted || token !== runToken) throw cancelError();
  entry.status = 'running';
  progress = { stage: '正在准备识别模型', message: '模型准备好后，会自动开始本地识别。', percent: null };
  render();
  const result = await transcribe(decoded.samples, entry, token, settings);
  return { ...result, source: 'audio', warnings: [...warnings, ...(result.warnings || [])] };
}

async function runEntries(pending) {
  const token = ++runToken;
  const controller = new AbortController();
  activeAbort = controller;
  const settings = { model: ui.model.value, language: ['chinese', 'english'].includes(ui.language.value) ? ui.language.value : 'chinese', selectionRevision: modelSelectionRevision, sourceMode: ['audio', 'video'].includes(ui['recognition-source'].value) ? ui['recognition-source'].value : 'auto' };
  busy = true;
  showError('');
  for (const entry of pending) {
    if (token !== runToken) return;
    activeFileId = entry.id;
    selectedId = entry.id;
    const previous = entry.result ? resultRevision(entry) : null;
    entry.status = 'decoding';
    entry.error = '';
    progress = { stage: '正在读取声音', message: '正在浏览器中读取和整理音频，文件不会上传。', percent: null };
    render();
    try {
      let result = await recognizeEntry(entry, token, settings, controller.signal);
      if (token !== runToken) return;
      if (result.text?.trim()) {
        progress = { stage: '正在整理标点', percent: null, message: '根据识别文字补充标点，保留原始字词。' };
        renderProgress();
        result = await punctuateResult(result, { signal: controller.signal, onProgress: () => {
          if (token === runToken) renderProgress();
        } });
        if (token !== runToken) return;
      }
      entry.previousRevision = previous;
      entry.result = result;
      entry.draft = result.text;
      entry.model = settings.model;
      entry.language = settings.language;
      entry.modelSelectionRevision = settings.selectionRevision;
      entry.sourceMode = settings.sourceMode;
      entry.revision++;
      entry.status = 'done';
    } catch (error) {
      if (token !== runToken || error.name === 'AbortError') return;
      entry.status = 'error';
      entry.error = error.message || '文件识别未完成，请换一个较短的音频重试。';
    }
    render();
  }
  if (token !== runToken) return;
  busy = false;
  activeAbort = null;
  activeFileId = null;
  const failed = queue.filter(entry => entry.status === 'error').length;
  if (failed) showError(`${failed} 个文件未完成，点击对应文件可查看原因。可以点击「重试未完成文件」再次尝试。`);
  render();
}

function stopQueue() {
  if (!busy) return;
  ++runToken;
  activeAbort?.abort();
  activeAbort = null;
  const entry = queue.find(item => item.id === activeFileId);
  if (entry && ['decoding', 'running'].includes(entry.status)) entry.status = 'canceled';
  const job = activeJob;
  activeJob = null;
  worker?.terminate();
  worker = null;
  job?.reject(cancelError());
  busy = false;
  activeFileId = null;
  render();
}

function setTab(tab, focus = false) {
  currentTab = tab;
  renderOutput();
  if (focus) ui[`${tab === 'text' ? 'text' : 'timeline'}-tab`].focus();
}

async function copyText() {
  const entry = selectedEntry();
  if (!entry?.result || !entry.draft.trim()) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(entry.draft);
    else throw new Error('CLIPBOARD_UNAVAILABLE');
    ui['copy-label'].textContent = '已复制';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { ui['copy-label'].textContent = '复制文字'; }, 1800);
  } catch {
    setTab('text');
    ui.transcript.focus();
    ui.transcript.select();
    showError('浏览器未允许自动复制。文字已选中，请按 Ctrl / ⌘ + C 复制。');
  }
}

function exportResult() {
  const entry = selectedEntry();
  if (!entry?.result) return;
  const format = ui['export-format'].value;
  try {
    const base = entry.file.name.replace(/\.[^.]+$/, '') || '转写结果';
    const renderers = { txt: () => renderTxt(entry.draft), srt: () => renderSrt(entry.result.segments), vtt: () => renderVtt(entry.result.segments), json: () => renderJson(entry.result) };
    downloadText(renderers[format](), `${base}.${format}`, format === 'json' ? 'application/json' : format === 'vtt' ? 'text/vtt' : 'text/plain');
  } catch (error) { showError(`导出未完成：${error.message}`); }
}

ui['drop-zone'].addEventListener('click', () => openPicker('file-input'));
ui['choose-audio'].addEventListener('click', () => openPicker('audio-input'));
ui['choose-video'].addEventListener('click', () => openPicker('video-input'));
for (const id of fileInputs) {
  ui[id].addEventListener('change', () => addFiles(ui[id].files || []));
  ui[id].addEventListener('cancel', () => pickerStatus('未选择文件。如手机提示无法打开，可展开上方提示，试单文件入口或系统浏览器。'));
}
ui['copy-link'].addEventListener('click', copyBrowserLink);
ui['drop-zone'].addEventListener('dragover', event => { event.preventDefault(); if (!busy) ui['drop-zone'].classList.add('drag-over'); });
ui['drop-zone'].addEventListener('dragleave', () => ui['drop-zone'].classList.remove('drag-over'));
ui['drop-zone'].addEventListener('drop', event => { event.preventDefault(); ui['drop-zone'].classList.remove('drag-over'); if (!busy) addFiles(event.dataTransfer.files); });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
ui['clear-files'].addEventListener('click', () => { if (busy) return; queue.length = 0; selectedId = null; showError(''); render(); });
ui['start-button'].addEventListener('click', startQueue);
ui['rerun-button'].addEventListener('click', rerunSelected);
ui['restore-button'].addEventListener('click', restorePrevious);
ui['stop-button'].addEventListener('click', stopQueue);
ui.language.addEventListener('change', renderControls);
ui['recognition-source'].addEventListener('change', () => { renderControls(); renderOutput(); });
ui.model.addEventListener('change', () => { modelSelectionRevision++; renderControls(); renderOutput(); });
ui['text-tab'].addEventListener('click', () => setTab('text'));
ui['timeline-tab'].addEventListener('click', () => setTab('timeline'));
for (const id of ['text-tab', 'timeline-tab']) ui[id].addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    setTab(event.key === 'Home' ? 'text' : event.key === 'End' ? 'timeline' : currentTab === 'text' ? 'timeline' : 'text', true);
  }
});
ui.transcript.addEventListener('input', () => {
  const entry = selectedEntry();
  if (!entry?.result || busy && activeFileId === entry.id) return;
  entry.draft = ui.transcript.value;
  renderOutput();
});
ui['copy-button'].addEventListener('click', copyText);
ui['export-button'].addEventListener('click', exportResult);
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (event.key.toLowerCase() === 'o') { event.preventDefault(); openPicker('file-input'); }
  if (event.key.toLowerCase() === 's' && selectedEntry()?.result) { event.preventDefault(); exportResult(); }
});
window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}));
}
render();
