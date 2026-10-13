import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { isVideoFile } from '../src/video-frames.js';

// These tests execute the shipped UI event handlers with a small DOM surface and
// explicit decoder/Worker doubles. They verify races and recovery, not browser
// decoding, model inference, CSS, or browser compatibility.
const [mainSource, exportSource, html] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/exports.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      toggle: (name, force) => {
        const enabled = force ?? !this.classes.has(name);
        if (enabled) this.classes.add(name); else this.classes.delete(name);
        return enabled;
      },
    };
    this.classes = new Set();
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  emit(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map(callback => callback({
      preventDefault() {}, ...event,
    })));
  }
  click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const file = name => ({ name, size: 64, type: 'audio/wav', lastModified: 1 });
const decoded = () => ({ samples: new Float32Array([0, 0.1]), duration: 1 });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(decode = async () => decoded(), vision = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const document = new Element('document');
  document.getElementById = id => {
    assert.ok(elements.has(id), `UI selector #${id} must exist in shipped HTML`);
    return elements.get(id);
  };
  document.body = new Element('body');
  const downloads = [];
  const objectUrls = new Map();
  let nextUrl = 0;
  document.createElement = tag => {
    const element = new Element(tag);
    if (tag === 'a') element.addEventListener('click', () => {
      downloads.push({ filename: element.download, blob: objectUrls.get(element.href) });
    });
    return element;
  };
  const workers = [];
  class WorkerDouble {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    result(text = '识别文字', warnings = []) {
      this.onmessage?.({ data: { type: 'result', id: this.messages.at(-1).id,
        text, duration: 1, segments: [{ start: 0, end: 1, text }], warnings } });
    }
    error(message = '模拟识别失败') {
      this.onmessage?.({ data: { type: 'error', id: this.messages.at(-1).id, message } });
    }
    fatal() { this.onerror?.({ preventDefault() {} }); }
  }
  const clipboard = { writeText: async text => clipboard.values.push(text), values: [] };
  const window = new Element('window');
  window.location = { origin: 'https://test.invalid' };
  const BrowserURL = class extends URL {};
  BrowserURL.createObjectURL = blob => { const url = `blob:test-${++nextUrl}`; objectUrls.set(url, blob); return url; };
  BrowserURL.revokeObjectURL = url => objectUrls.delete(url);
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({ document, window, navigator: { clipboard },
    decodeAudio: decode, MAX_FILE_BYTES: 300 * 1024 * 1024,
    Worker: WorkerDouble, URL: BrowserURL, Blob, Float32Array, AbortController,
    isVideoFile,
    readVideoFrames: vision.readFrames || (async () => { throw new Error('模拟浏览器不能读取画面'); }),
    createVideoOcrClient: vision.createClient || (() => ({ initialize: async () => {}, recognize: async () => ({ texts: [] }), dispose() {} })),
    fuseVideoCaptions: vision.fuse || (() => ({ reliable: false, segments: [], candidates: [], warnings: [] })),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(exportSource.replace(/^export /gm, ''), context, { filename: 'exports.js' });
  vm.runInContext(mainSource.replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('https://test.invalid/src/main.js'))
    .replaceAll('import.meta.env.VITE_COMPACT_BUILD', JSON.stringify('0'))
    .replaceAll('import.meta.env.BASE_URL', JSON.stringify('/')), context, { filename: 'main.js' });
  const ui = Object.fromEntries(elements);
  ui.language.value = 'chinese';
  ui.model.value = 'Xenova/whisper-small';
  ui['recognition-source'].value = 'auto';
  ui['export-format'].value = 'txt';
  const states = () => ui['file-queue'].children.map(row => row.children[2].textContent);
  const select = index => ui['file-queue'].children[index].children[1].click();
  const add = async files => { ui['file-input'].files = files; await ui['file-input'].emit('change'); };
  const controlsRestored = () => {
    for (const id of ['file-input', 'audio-input', 'video-input', 'single-file-input', 'drop-zone', 'choose-audio', 'choose-video', 'clear-files', 'language', 'model', 'recognition-source']) assert.equal(ui[id].disabled, false, id);
    assert.equal(ui['stop-button'].hidden, true);
    assert.equal(ui['progress-region'].hidden, true);
  };
  return { ui, workers, clipboard, downloads, states, select, add, controlsRestored };
}

test('generic and visible single-file pickers avoid restrictive native filters', () => {
  const inputs = Object.fromEntries([...html.matchAll(/<input\b[^>]*id="([^"]+)"[^>]*>/g)].map(match => [match[1], match[0]]));
  assert.doesNotMatch(inputs['file-input'], /\baccept=/);
  assert.match(inputs['file-input'], /\bmultiple\b/);
  assert.doesNotMatch(inputs['single-file-input'], /\b(?:accept|multiple|hidden|capture)\b/);
  assert.ok(html.indexOf('id="single-file-input"') < html.indexOf('id="picker-help"'), 'native single-file chooser must be visible before collapsed help');
  assert.match(inputs['audio-input'], /accept="audio\/\*"/);
  assert.match(inputs['video-input'], /accept="video\/\*"/);
});

test('picker dispatch remains synchronous in a click and routes separate media modes', async () => {
  const h = harness();
  const opened = [];
  for (const id of ['file-input', 'audio-input', 'video-input']) h.ui[id].addEventListener('click', () => opened.push(id));
  const click = h.ui['drop-zone'].click();
  assert.deepEqual(opened, ['file-input'], 'picker opens before any asynchronous work');
  await click;
  await h.ui['choose-audio'].click();
  await h.ui['choose-video'].click();
  assert.deepEqual(opened, ['file-input', 'audio-input', 'video-input']);
});

test('all picker paths validate files and reset values, including empty Android MIME', async () => {
  const h = harness();
  for (const [id, name] of [['file-input', 'recording.m4a'], ['single-file-input', 'video.mp4'], ['audio-input', 'audio.mp3'], ['video-input', 'clip.mov']]) {
    h.ui[id].value = `fakepath/${name}`;
    h.ui[id].files = [{ ...file(name), type: '' }];
    await h.ui[id].emit('change');
    assert.equal(h.ui[id].value, '', 'same file can be selected again');
  }
  assert.deepEqual(h.states(), Array(4).fill('待转写'));
  await h.add([{ ...file('notes.txt'), type: 'text/plain' }, { ...file('empty.wav'), size: 0 }, { ...file('huge.mp4'), size: 301 * 1024 * 1024 }]);
  assert.equal(h.states().length, 4);
  assert.match(h.ui['inline-error'].textContent, /不是可识别.*空文件.*超过 300 MB/);
});

test('cancel keeps completed draft and does not report a transcription failure', async () => {
  const h = harness();
  await h.add([file('saved.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('原稿');
  await run;
  h.ui.transcript.value = '校对后的原稿';
  await h.ui.transcript.emit('input');
  await h.ui['single-file-input'].emit('cancel');
  assert.equal(h.ui.transcript.value, '校对后的原稿');
  assert.deepEqual(h.states(), ['已完成']);
  assert.equal(h.ui['inline-error'].hidden, true);
  assert.match(h.ui['picker-status'].textContent, /未选择文件/);
});

test('all mobile picker controls disable while running and restore on stop', async () => {
  const h = harness();
  await h.add([file('running.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  for (const id of ['file-input', 'audio-input', 'video-input', 'single-file-input', 'drop-zone', 'choose-audio', 'choose-video']) assert.equal(h.ui[id].disabled, true, id);
  await h.ui['stop-button'].click();
  await run;
  h.controlsRestored();
});

test('picker exceptions provide visible native fallback and copyable browser URL', async () => {
  const h = harness();
  h.ui['file-input'].click = () => { throw new Error('native picker unavailable'); };
  await h.ui['drop-zone'].click();
  assert.equal(h.ui['picker-help'].open, true);
  assert.match(h.ui['picker-status'].textContent, /单文件入口/);
  await h.ui['copy-link'].click();
  assert.deepEqual(h.clipboard.values, ['https://test.invalid/']);
  h.clipboard.writeText = async () => { throw new Error('permission denied'); };
  await h.ui['copy-link'].click();
  assert.equal(h.ui['browser-link'].selected, true);
  assert.match(h.ui['picker-status'].textContent, /长按/);
});

test('batch continues after decode and fatal Worker errors; retry only repeats failures', async () => {
  const reads = [];
  let firstDecode = true;
  const h = harness(async file => {
    reads.push(file.name);
    if (file.name === 'bad.wav' && firstDecode) { firstDecode = false; throw new Error('模拟解码失败'); }
    return decoded();
  });
  await h.add([file('bad.wav'), file('fatal.wav'), file('good.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  assert.deepEqual(h.states(), ['未完成', '转写中', '待转写']);
  h.workers[0].fatal();
  await flush();
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.workers.length, 2);
  h.workers[1].result('已完成结果');
  await run;
  h.controlsRestored();
  assert.deepEqual(h.states(), ['未完成', '未完成', '已完成']);
  assert.equal(h.ui['start-label'].textContent, '重试未完成文件');
  const retry = h.ui['start-button'].click();
  await flush();
  h.workers[1].result('重试一');
  await flush();
  h.workers[1].result('重试二');
  await retry;
  h.controlsRestored();
  assert.deepEqual(h.states(), ['已完成', '已完成', '已完成']);
  assert.deepEqual(reads, ['bad.wav', 'fatal.wav', 'good.wav', 'bad.wav', 'fatal.wav']);
});

test('stop during decoding restores controls and ignores late decoder completion after restart', async () => {
  const oldDecode = deferred();
  let reads = 0;
  const h = harness(() => ++reads === 1 ? oldDecode.promise : Promise.resolve(decoded()));
  await h.add([file('first.wav'), file('second.wav')]);
  const oldRun = h.ui['start-button'].click();
  await h.ui['stop-button'].click();
  h.controlsRestored();
  assert.deepEqual(h.states(), ['已停止', '待转写']);
  const newRun = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers.length, 1);
  oldDecode.resolve(decoded());
  await oldRun;
  assert.equal(h.workers[0].messages.length, 1, 'old run cannot submit a duplicate job');
  assert.equal(h.ui['start-button'].disabled, true);
  h.workers[0].result('第一份');
  await flush();
  assert.equal(h.workers[0].messages.length, 2);
  h.workers[0].result('第二份');
  await newRun;
  assert.deepEqual(h.states(), ['已完成', '已完成']);
  h.controlsRestored();
});

test('stop during inference preserves completed files and rejects stale Worker events', async () => {
  const h = harness();
  await h.add([file('done.wav'), file('cancel.wav'), file('pending.wav')]);
  const oldRun = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('保留这份');
  await flush();
  await h.ui['stop-button'].click();
  await oldRun;
  h.controlsRestored();
  assert.deepEqual(h.states(), ['已完成', '已停止', '待转写']);
  const newRun = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('过期文字');
  h.workers[0].fatal();
  assert.equal(h.workers[1].terminated, false);
  assert.deepEqual(h.states(), ['已完成', '转写中', '待转写']);
  h.workers[1].result('有效结果');
  await flush();
  h.workers[1].result('最后结果');
  await newRun;
  await h.select(0);
  assert.equal(h.ui.transcript.value, '保留这份');
  assert.equal(h.workers[1].messages.length, 2);
  h.controlsRestored();
});

test('recoverable recognition errors continue the queue without disabling retry', async () => {
  const h = harness();
  await h.add([file('error.wav'), file('success.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers[0].error('模型下载失败');
  await flush();
  assert.equal(h.workers[0].messages.length, 2);
  h.workers[0].result();
  await run;
  h.controlsRestored();
  assert.equal(h.ui['start-button'].disabled, false);
  await h.select(0);
  assert.equal(h.ui['empty-description'].textContent, '模型下载失败');
  assert.equal(h.ui['copy-button'].disabled, true);
  assert.equal(h.ui['export-button'].disabled, true);
});

test('drafts survive tab and file selection; TXT exports edits while subtitles and JSON retain original', async () => {
  const h = harness();
  await h.add([file('甲.wav'), file('乙.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('原文甲');
  await flush();
  h.workers[0].result('原文乙');
  await run;
  await h.select(0);
  h.ui.transcript.value = '修改后的正文😀';
  await h.ui.transcript.emit('input');
  assert.equal(h.ui['character-count'].textContent, '7 个字符');
  await h.ui['timeline-tab'].click();
  assert.equal(h.ui['timeline-view'].children[0].children[1].textContent, '原文甲');
  await h.select(1);
  await h.ui['text-tab'].click();
  assert.equal(h.ui.transcript.value, '原文乙');
  await h.select(0);
  assert.equal(h.ui.transcript.value, '修改后的正文😀');
  for (const format of ['txt', 'srt', 'vtt', 'json']) {
    h.ui['export-format'].value = format;
    await h.ui['export-button'].click();
  }
  assert.deepEqual(h.downloads.map(item => item.filename), ['甲.txt', '甲.srt', '甲.vtt', '甲.json']);
  const [txt, srt, vtt, json] = await Promise.all(h.downloads.map(item => item.blob.text()));
  assert.equal(txt, '修改后的正文😀\n');
  assert.match(srt, /00:00:00,000 --> 00:00:01,000\n原文甲/);
  assert.match(vtt, /^WEBVTT/);
  assert.equal(JSON.parse(json).text, '原文甲');
});

test('clipboard failure selects edited text for manual copy and subsequent copy succeeds', async () => {
  const h = harness();
  await h.add([file('copy.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('待复制');
  await run;
  h.ui.transcript.value = '校对后的文字';
  await h.ui.transcript.emit('input');
  await h.ui['timeline-tab'].click();
  h.clipboard.writeText = async () => { throw new Error('Permission denied'); };
  await h.ui['copy-button'].click();
  assert.equal(h.ui['text-view'].hidden, false);
  assert.equal(h.ui.transcript.focused, true);
  assert.equal(h.ui.transcript.selected, true);
  assert.match(h.ui['inline-error'].textContent, /Ctrl \/ ⌘ \+ C/);
  h.clipboard.writeText = async text => h.clipboard.values.push(text);
  await h.ui['copy-button'].click();
  assert.deepEqual(h.clipboard.values, ['校对后的文字']);
  assert.equal(h.ui['copy-label'].textContent, '已复制');
});

test('rerun uses current settings for only the selected file, then restores its edited previous version', async () => {
  const reads = [];
  const h = harness(async file => { reads.push(file.name); return decoded(); });
  assert.equal(h.ui['rerun-actions'].hidden, true);
  await h.add([file('甲.wav'), file('乙.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('原始甲');
  await flush();
  h.workers[0].result('原始乙');
  await initial;
  await h.add([file('仍待转写.wav')]);
  await h.select(0);
  h.ui.transcript.value = '已校对的甲';
  await h.ui.transcript.emit('input');
  const oldMetadata = h.ui['result-meta'].textContent;
  h.ui.model.value = 'Xenova/whisper-tiny';
  await h.ui.model.emit('change');
  h.ui.language.value = 'english';
  const rerun = h.ui['rerun-button'].click();
  await flush();
  const request = h.workers[0].messages.at(-1);
  assert.equal(request.model, 'Xenova/whisper-tiny');
  assert.equal(request.language, 'english');
  assert.equal(h.ui.transcript.value, '已校对的甲');
  assert.equal(h.ui.transcript.disabled, true);
  assert.equal(h.ui['result-meta'].textContent, oldMetadata, 'pending settings cannot relabel the old result');
  assert.equal(h.ui['rerun-button'].disabled, true);
  h.workers[0].result('新的甲');
  await rerun;
  assert.deepEqual(reads, ['甲.wav', '乙.wav', '甲.wav']);
  assert.deepEqual(h.states(), ['已完成', '已完成', '待转写']);
  assert.equal(h.ui.transcript.value, '新的甲');
  assert.equal(h.ui.transcript.disabled, false);
  assert.match(h.ui['result-meta'].textContent, /快速 · 英语/);
  assert.equal(h.ui['restore-button'].hidden, false);
  await h.ui['restore-button'].click();
  assert.equal(h.ui.transcript.value, '已校对的甲');
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  assert.equal(h.ui['restore-button'].hidden, true);
  await h.ui['timeline-tab'].click();
  assert.equal(h.ui['timeline-view'].children[0].children[1].textContent, '原始甲');
  await h.select(1);
  await h.ui['text-tab'].click();
  assert.equal(h.ui.transcript.value, '原始乙');
  h.controlsRestored();
});

test('rerun preserves the edited draft and result metadata throughout decoding and recognition failure', async () => {
  const decoding = deferred();
  let reads = 0;
  const h = harness(() => ++reads === 2 ? decoding.promise : Promise.resolve(decoded()));
  await h.add([file('保留.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('识别原文');
  await initial;
  h.ui.transcript.value = '手工校对过的正文';
  await h.ui.transcript.emit('input');
  const oldMetadata = h.ui['result-meta'].textContent;
  h.ui.model.value = 'Xenova/whisper-tiny';
  h.ui.language.value = 'auto'; // A stale pre-upgrade selection must fall back to Chinese.
  const rerun = h.ui['rerun-button'].click();
  assert.deepEqual(h.states(), ['读取中']);
  assert.equal(h.ui.transcript.value, '手工校对过的正文');
  assert.equal(h.ui.transcript.disabled, true);
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  decoding.resolve(decoded());
  await flush();
  assert.deepEqual(h.states(), ['转写中']);
  assert.equal(h.workers[0].messages.at(-1).language, 'chinese');
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  h.workers[0].error('本次模型加载失败');
  await rerun;
  assert.equal(h.ui.transcript.value, '手工校对过的正文');
  assert.equal(h.ui.transcript.disabled, false);
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  assert.equal(h.ui['rerun-button'].disabled, false);
  assert.match(h.ui['rerun-help'].textContent, /本次模型加载失败.*原结果已保留/);
  assert.equal(h.ui['restore-button'].hidden, true, 'a failed attempt does not create a new revision');
  h.ui['export-format'].value = 'txt';
  await h.ui['export-button'].click();
  assert.equal(await h.downloads[0].blob.text(), '手工校对过的正文\n');
  h.controlsRestored();
});

test('stopping a rerun retains the draft and metadata and ignores late Worker events after another rerun', async () => {
  const h = harness();
  await h.add([file('停止.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('第一次结果');
  await initial;
  h.ui.transcript.value = '用户修改的版本';
  await h.ui.transcript.emit('input');
  const oldMetadata = h.ui['result-meta'].textContent;
  h.ui.model.value = 'Xenova/whisper-tiny';
  const stopped = h.ui['rerun-button'].click();
  await flush();
  await h.ui['stop-button'].click();
  await stopped;
  assert.equal(h.ui.transcript.value, '用户修改的版本');
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  assert.equal(h.ui.transcript.disabled, false);
  assert.equal(h.ui['rerun-button'].disabled, false);
  const next = h.ui['rerun-button'].click();
  await flush();
  h.workers[0].result('已停止任务的过期结果');
  h.workers[0].fatal();
  assert.equal(h.workers[1].terminated, false);
  assert.equal(h.ui.transcript.value, '用户修改的版本');
  h.workers[1].result('有效新结果');
  await next;
  await h.ui['restore-button'].click();
  assert.equal(h.ui.transcript.value, '用户修改的版本');
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  h.controlsRestored();
});

test('decoder errors and canceled decoder completion cannot replace an existing result or submit stale work', async () => {
  const staleDecode = deferred();
  let reads = 0;
  const h = harness(() => {
    reads++;
    if (reads === 2) throw new Error('视频重新读取失败');
    if (reads === 3) return staleDecode.promise;
    return Promise.resolve(decoded());
  });
  await h.add([file('解码.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('仍可使用的结果');
  await initial;
  const oldMetadata = h.ui['result-meta'].textContent;
  await h.ui['rerun-button'].click();
  assert.equal(h.ui.transcript.value, '仍可使用的结果');
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  assert.match(h.ui['rerun-help'].textContent, /视频重新读取失败/);
  const canceled = h.ui['rerun-button'].click();
  await h.ui['stop-button'].click();
  const next = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.length, 2);
  staleDecode.resolve(decoded());
  await canceled;
  assert.equal(h.workers[1].messages.length, 1);
  assert.equal(h.ui.transcript.value, '仍可使用的结果');
  h.workers[1].result('最后版本');
  await next;
  assert.equal(h.ui.transcript.value, '最后版本');
  h.controlsRestored();
});

test('the two precision choices default to Small; an unchanged Tiny rerun upgrades and Small reruns stay Small', async () => {
  const modelOptions = html.match(/<select id="model">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...modelOptions.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['Xenova/whisper-tiny', 'Xenova/whisper-small']);
  assert.match(modelOptions, /value="Xenova\/whisper-small" selected>高精度 · 下载较大/);
  for (const model of ['Xenova/whisper-tiny', 'Xenova/whisper-small']) {
    const h = harness();
    assert.equal(h.ui.model.value, 'Xenova/whisper-small');
    h.ui.model.value = model;
    await h.add([file('提高精度.wav')]);
    const initial = h.ui['start-button'].click();
    await flush();
    h.workers[0].result('原结果');
    await initial;
    const oldMetadata = h.ui['result-meta'].textContent;
    if (model === 'Xenova/whisper-tiny') assert.match(h.ui['rerun-help'].textContent, /改用高精度.*190 MB/);
    else assert.doesNotMatch(h.ui['rerun-help'].textContent, /改用高精度/);
    const upgraded = h.ui['rerun-button'].click();
    await flush();
    assert.equal(h.workers[0].messages.at(-1).model, 'Xenova/whisper-small');
    assert.equal(h.ui.model.value, 'Xenova/whisper-small');
    assert.equal(h.ui['result-meta'].textContent, oldMetadata);
    h.workers[0].result('高精度结果');
    await upgraded;
    assert.match(h.ui['result-meta'].textContent, /高精度/);
    assert.match(h.ui['rerun-help'].textContent, /相同设置通常结果相同/);
    assert.doesNotMatch(h.ui['rerun-help'].textContent, /改用高精度/);
    const samePrecision = h.ui['rerun-button'].click();
    await flush();
    assert.equal(h.workers[0].messages.at(-1).model, 'Xenova/whisper-small');
    h.workers[0].result('第二次高精度结果');
    await samePrecision;
    h.controlsRestored();
  }
});

test('manual precision selection is respected even when the user returns to the original model', async () => {
  const h = harness();
  h.ui.model.value = 'Xenova/whisper-tiny';
  await h.add([file('手动选择.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('快速结果');
  await initial;
  h.ui.model.value = 'Xenova/whisper-small';
  await h.ui.model.emit('change');
  h.ui.model.value = 'Xenova/whisper-tiny';
  await h.ui.model.emit('change');
  assert.doesNotMatch(h.ui['rerun-help'].textContent, /改用高精度/);
  const rerun = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers[0].messages.at(-1).model, 'Xenova/whisper-tiny');
  h.workers[0].result('仍使用手动选择的快速精度');
  await rerun;
  h.controlsRestored();
});

test('result warnings preserve all text and follow the prior version through rerun and restore', async () => {
  const h = harness();
  await h.add([file('警告.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  const repeated = '重复内容重复内容重复内容';
  const warning = '识别结果中有较多重复内容，请对照音频校对。';
  h.workers[0].result(repeated, [warning, '<提示文字>', null]);
  await initial;
  assert.equal(h.ui.transcript.value, repeated, 'a warning must not delete recognized text');
  assert.equal(h.ui['result-warning'].hidden, false);
  assert.equal(h.ui['result-warning'].textContent, `${warning} <提示文字>`);
  const rerun = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.ui['result-warning'].textContent, `${warning} <提示文字>`);
  h.workers[0].result('新识别的内容');
  await rerun;
  assert.equal(h.ui['result-warning'].hidden, true);
  assert.equal(h.ui['result-warning'].textContent, '');
  await h.ui['restore-button'].click();
  assert.equal(h.ui.transcript.value, repeated);
  assert.equal(h.ui['result-warning'].hidden, false);
  assert.equal(h.ui['result-warning'].textContent, `${warning} <提示文字>`);
  await h.ui['timeline-tab'].click();
  assert.equal(h.ui['timeline-view'].children[0].children[1].textContent, repeated);
  h.controlsRestored();
});

test('language choices explicitly default to Chinese and send English only when selected', async () => {
  assert.match(html, /value="chinese" selected>中文/);
  assert.doesNotMatch(html.match(/<select id="language">([\s\S]*?)<\/select>/)[1], /value="auto"|自动判断/);
  const h = harness();
  await h.add([file('语言.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers[0].messages.at(-1).language, 'chinese');
  assert.equal(h.workers[0].messages.at(-1).model, 'Xenova/whisper-small');
  h.workers[0].result('中文原文');
  await initial;
  assert.match(h.ui['result-meta'].textContent, /中文/);
  h.ui.language.value = 'english';
  await h.ui.language.emit('change');
  const rerun = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers[0].messages.at(-1).language, 'english');
  h.workers[0].result('English result');
  await rerun;
  assert.match(h.ui['result-meta'].textContent, /英语/);
  await h.ui['restore-button'].click();
  assert.match(h.ui['result-meta'].textContent, /中文/);
  h.controlsRestored();
});

function videoFixture(overrides = {}) {
  const metadata = { duration: 2, width: 320, height: 180, frameCount: 2, sampleInterval: 0.5, sparse: false };
  return {
    readFrames: async (_file, { onMetadata, onFrame, signal }) => {
      onMetadata(metadata);
      for (let index = 0; index < 2; index++) {
        if (signal.aborted) throw new DOMException('stopped', 'AbortError');
        await onFrame({ ...metadata, index, time: 0.125 + index / 2, pixels: { width: 320, height: 180, data: new Uint8ClampedArray(4) } });
      }
      return metadata;
    },
    ...overrides,
  };
}

test('reliable local video captions bypass audio decoding and clearly identify the visual source', async () => {
  let decodedAudio = false;
  let disposed = false;
  let recognized = 0;
  const h = harness(async () => { decodedAudio = true; throw new Error('no audio track'); }, videoFixture({
    createClient: () => ({ initialize: async () => {}, recognize: async () => { recognized++; return { texts: [{ text: '欢迎收看', confidence: 0.98 }] }; }, dispose() { disposed = true; } }),
    fuse: frames => {
      assert.equal(frames.length, 2);
      return { reliable: true, segments: [{ start: 0, end: 1, text: '欢迎收看。' }], candidates: [], warnings: [] };
    },
  }));
  await h.add([{ ...file('silent.mp4'), type: 'video/mp4' }]);
  await h.ui['start-button'].click();
  assert.equal(decodedAudio, false);
  assert.equal(h.workers.length, 0);
  assert.equal(recognized, 2);
  assert.equal(disposed, true);
  assert.equal(h.ui.transcript.value, '欢迎收看。');
  assert.match(h.ui['result-meta'].textContent, /画面字幕 · 待核对/);
  assert.match(h.ui['result-warning'].textContent, /尚未与声音逐字核验/);
  assert.match(h.ui['result-warning'].textContent, /没有出现或看不清/);
  h.controlsRestored();
});

test('uncertain video text stays out of the audio transcript and remains separately reviewable', async () => {
  const h = harness(undefined, videoFixture({ fuse: () => ({ reliable: false, segments: [], candidates: [{ start: 0, text: '背景招牌', reason: '固定文字' }], warnings: [] }) }));
  await h.add([{ ...file('uncertain.mp4'), type: 'video/mp4' }]);
  const run = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers.length, 1);
  h.workers[0].result('识别出的声音。');
  await run;
  assert.equal(h.ui.transcript.value, '识别出的声音。');
  assert.match(h.ui['result-warning'].textContent, /已改用声音识别/);
  assert.equal(h.ui['visual-candidates'].hidden, false);
  assert.match(h.ui['visual-candidate-list'].children[0].textContent, /背景招牌/);
  h.controlsRestored();
});

test('a visual-only rerun without reliable evidence retains the edited original and its metadata', async () => {
  const h = harness(undefined, videoFixture({ fuse: () => ({ reliable: false, segments: [], candidates: [{ start: 0, text: '模糊字' }], warnings: [] }) }));
  h.ui['recognition-source'].value = 'audio';
  await h.add([{ ...file('compare.mp4'), type: 'video/mp4' }]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers[0].result('第一版。');
  await initial;
  h.ui.transcript.value = '已经校对的原稿。';
  await h.ui.transcript.emit('input');
  const meta = h.ui['result-meta'].textContent;
  h.ui['recognition-source'].value = 'video';
  await h.ui['rerun-button'].click();
  assert.equal(h.ui.transcript.value, '已经校对的原稿。');
  assert.equal(h.ui['result-meta'].textContent, meta);
  assert.equal(h.ui['restore-button'].hidden, true);
  assert.match(h.ui['rerun-help'].textContent, /没有发现证据足够/);
  assert.equal(h.ui['visual-candidates'].hidden, false);
  assert.equal(h.workers[0].terminated, true, 'old ASR heap is freed before visual inference');
  assert.equal(h.workers.length, 1, 'visual-only mode must not silently run ASR');
  h.controlsRestored();
});

test('stopping an OCR run disposes the worker and cannot submit a late audio fallback', async () => {
  const pending = deferred();
  let disposed = false;
  const h = harness(undefined, videoFixture({ createClient: ({ signal }) => {
    signal.addEventListener('abort', () => { disposed = true; pending.reject(new DOMException('stop', 'AbortError')); });
    return { initialize: async () => {}, recognize: () => pending.promise, dispose() { disposed = true; } };
  } }));
  await h.add([{ ...file('stop-visual.mp4'), type: 'video/mp4' }]);
  const run = h.ui['start-button'].click();
  await flush();
  await h.ui['stop-button'].click();
  await run;
  assert.equal(disposed, true);
  assert.equal(h.workers.length, 0);
  assert.deepEqual(h.states(), ['已停止']);
  h.controlsRestored();
});
