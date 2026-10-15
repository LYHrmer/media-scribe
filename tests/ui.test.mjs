import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { isVideoFile } from '../src/video-frames.js';
import { reviewCaptionEvidence, captionLabel } from '../src/caption-review.js';

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
  querySelector(selector) { return { remove: () => { this.removedSelector = selector; } }; }
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
    postMessage(message) {
      assert.equal(this.terminated, false, 'a released Worker must never receive a new job');
      vision.postMessage?.(message);
      this.messages.push(message);
    }
    terminate() { this.terminated = true; }
    result(text = '识别文字', warnings = [], metadata = {}) {
      this.onmessage?.({ data: { type: 'result', id: this.messages.at(-1).id,
        text, duration: 1, segments: [{ start: 0, end: 1, text }], warnings, ...metadata } });
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
    isVideoFile, reviewCaptionEvidence, captionLabel,
    punctuateResult: vision.punctuate || (async result => result),
    evaluateSpeechPresence: vision.speechCheck || (async () => ({ reject: false })),
    readVideoFrames: vision.readFrames || (async () => { throw new Error('模拟浏览器不能读取画面'); }),
    createVideoOcrClient: vision.createClient || (() => ({ initialize: async () => {}, recognize: async () => ({ texts: [] }), dispose() {} })),
    fuseVideoCaptions: vision.fuse || (() => ({ reliable: false, segments: [], candidates: [], warnings: [] })),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(exportSource.replace(/^export /gm, ''), context, { filename: 'exports.js' });
  vm.runInContext(mainSource.replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('https://test.invalid/src/main.js'))
    .replaceAll('import.meta.env.VITE_COMPACT_BUILD', JSON.stringify(vision.compact ? '1' : '0'))
    .replaceAll('import.meta.env.BASE_URL', JSON.stringify('/')), context, { filename: 'main.js' });
  const ui = Object.fromEntries(elements);
  ui.language.value = 'chinese';
  if (!vision.compact) ui.model.value = 'Xenova/whisper-small';
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

test('a low-voice candidate avoids ASR and offers a force retry without losing the file', async () => {
  let checks = 0;
  const h = harness(undefined, { speechCheck: async () => {
    checks++;
    return { reject: true, maxProbability: 0.02 };
  } });
  await h.add([file('可能是轻声.wav')]);
  await h.ui['start-button'].click();
  assert.equal(checks, 1);
  assert.equal(h.workers.length, 0, 'no ASR worker/model is started for the deferred candidate');
  assert.equal(h.ui.transcript.value, '');
  assert.match(h.ui['result-meta'].textContent, /人声待核对.*暂停生成文字/);
  assert.equal(h.ui['rerun-button'].textContent, '仍然尝试识别');
  assert.match(h.ui['result-warning'].textContent, /不能排除歌声、轻声/);
  const forced = h.ui['rerun-button'].click();
  await flush();
  assert.equal(checks, 1, 'explicit override bypasses the gate');
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'timestamps');
  h.workers.at(-1).result('确实有轻声。');
  await forced;
  assert.equal(h.ui.transcript.value, '确实有轻声。');
  await h.ui['restore-button'].click();
  assert.equal(h.ui['rerun-button'].textContent, '仍然尝试识别', 'restore includes the deferred decision');
  h.controlsRestored();
});

test('the file override survives successful decoding retries and restoring the deferred result', async () => {
  let checks = 0;
  const h = harness(undefined, { speechCheck: async () => { checks++; return { reject: true }; } });
  await h.add([file('持续允许.wav')]);
  await h.ui['start-button'].click();
  const forced = h.ui['rerun-button'].click();
  await flush();
  h.workers.at(-1).result('确认是人声。');
  await forced;
  assert.equal(checks, 1);
  const alternative = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'text');
  h.workers.at(-1).result('另一版人声文字。', ['字幕时间为粗略范围。'], { timing: 'approximate' });
  await alternative;
  assert.equal(checks, 1, 'the successful file override also applies to a different decoding strategy');
  assert.match(h.ui['rerun-help'].textContent, /已允许直接识别原音/);
  const restored = harness(undefined, { speechCheck: async () => { checks++; return { reject: true }; } });
  await restored.add([file('恢复允许.wav')]);
  await restored.ui['start-button'].click();
  const firstForced = restored.ui['rerun-button'].click();
  await flush();
  restored.workers.at(-1).result('已识别的原音。');
  await firstForced;
  await restored.ui['restore-button'].click();
  assert.equal(restored.ui.transcript.value, '');
  assert.match(restored.ui['rerun-help'].textContent, /已允许直接识别原音/);
  const afterRestore = restored.ui['rerun-button'].click();
  await flush();
  assert.equal(checks, 2, 'restoring old text does not revoke the preference for this file');
  restored.workers.at(-1).result('恢复后仍直接识别。');
  await afterRestore;
  restored.controlsRestored();
});

test('failed forced recognition can use the main retry button while another file retains its gate', async () => {
  let checks = 0;
  const h = harness(undefined, { speechCheck: async () => { checks++; return { reject: true }; } });
  await h.add([file('允许重试.wav')]);
  await h.ui['start-button'].click();
  const forced = h.ui['rerun-button'].click();
  await flush();
  h.workers.at(-1).error('模型暂未加载');
  await forced;
  assert.deepEqual(h.states(), ['未完成']);
  assert.match(h.ui['rerun-help'].textContent, /后续重试会跳过人声检查/);
  const retry = h.ui['start-button'].click();
  await flush();
  assert.equal(checks, 1, 'the main failed-file retry respects the explicit file override');
  assert.equal(h.workers.length, 2);
  h.workers.at(-1).result('重试完成。');
  await retry;
  await h.add([file('未允许的另一个.wav')]);
  await h.ui['start-button'].click();
  assert.equal(checks, 2, 'an unrelated file still undergoes the speech check');
  assert.equal(h.workers.length, 2, 'a deferred second file does not reach ASR');
  assert.deepEqual(h.states(), ['已完成', '已完成']);
  assert.equal(h.ui['rerun-button'].textContent, '仍然尝试识别');
  assert.doesNotMatch(h.ui['rerun-help'].textContent, /已允许直接识别原音/);
  h.controlsRestored();
});

test('stopping a forced attempt keeps its preference, while removing and adding the file resets it', async () => {
  let checks = 0;
  const h = harness(undefined, { speechCheck: async () => { checks++; return { reject: true }; } });
  const sourceFile = file('停止后直接识别.wav');
  await h.add([sourceFile]);
  await h.ui['start-button'].click();
  const forced = h.ui['rerun-button'].click();
  await flush();
  await h.ui['stop-button'].click();
  await forced;
  assert.deepEqual(h.states(), ['已停止']);
  const restart = h.ui['start-button'].click();
  await flush();
  assert.equal(checks, 1);
  assert.equal(h.workers.length, 2);
  h.workers.at(-1).result('停止后继续原音。');
  await restart;
  await h.ui['clear-files'].click();
  await h.add([sourceFile]);
  await h.ui['start-button'].click();
  assert.equal(checks, 2, 'adding a new entry for the removed file resets the override');
  assert.equal(h.workers[1].messages.length, 1);
  assert.equal(h.ui['rerun-button'].textContent, '仍然尝试识别');
  h.controlsRestored();
});

test('a deferred Tiny retry shows the cost of its automatic model upgrade', async () => {
  let checks = 0;
  const h = harness(undefined, { speechCheck: async () => { checks++; return { reject: true }; } });
  h.ui.model.value = 'Xenova/whisper-tiny';
  await h.add([file('快速模式轻声.wav')]);
  await h.ui['start-button'].click();
  assert.match(h.ui['rerun-help'].textContent, /跳过.*人声|跳过这项检查/);
  assert.match(h.ui['rerun-help'].textContent, /改用高精度.*190 MB/);
  const forced = h.ui['rerun-button'].click();
  await flush();
  assert.equal(checks, 1);
  assert.equal(h.workers.at(-1).messages.at(-1).model, 'Xenova/whisper-small');
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'timestamps');
  h.workers.at(-1).result('原音识别。');
  await forced;
});

test('VAD failure continues ordinary ASR and stopping VAD ignores its stale decision', async () => {
  const h = harness(undefined, { speechCheck: async () => { throw new Error('model unavailable'); } });
  await h.add([file('继续识别.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).result('原音结果。');
  await run;
  assert.match(h.ui['result-warning'].textContent, /人声检查未完成/);
  assert.equal(h.ui.transcript.value, '原音结果。');
  const late = deferred();
  let signal;
  const stopped = harness(undefined, { speechCheck: (_audio, options) => { signal = options.signal; return late.promise; } });
  await stopped.add([file('停止检测.wav')]);
  const pending = stopped.ui['start-button'].click();
  await flush();
  await stopped.ui['stop-button'].click();
  assert.equal(signal.aborted, true);
  late.resolve({ reject: true });
  await pending;
  assert.equal(stopped.workers.length, 0);
  assert.equal(stopped.ui['rerun-actions'].hidden, true);
  stopped.controlsRestored();
});

test('a returned VAD warning remains visible and exported when recognition continues', async () => {
  const warning = '人声检查未完成，将继续转写。';
  const h = harness(undefined, { speechCheck: async () => ({ reject: false, warning }) });
  await h.add([file('检查故障但可转写.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).result('继续识别的原音。');
  await run;
  assert.equal(h.ui.transcript.value, '继续识别的原音。');
  assert.equal(h.ui['result-warning'].hidden, false);
  assert.match(h.ui['result-warning'].textContent, /人声检查未完成/);
  h.ui['export-format'].value = 'json';
  await h.ui['export-button'].click();
  const json = JSON.parse(await h.downloads.at(-1).blob.text());
  assert.ok(json.warnings.includes(warning));
  assert.equal(Object.hasOwn(json, 'speechCheck'), false, 'a VAD failure cannot claim a low-voice rejection or user override');
});

test('unchanged Small retries alternate real decoding strategies and retain approximate-time metadata', async () => {
  const h = harness();
  await h.add([file('不同方式.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'timestamps');
  h.workers.at(-1).result('第一版。');
  await initial;
  assert.match(h.ui['rerun-help'].textContent, /另一种文字识别方式/);
  const retry = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'text');
  h.workers.at(-1).result('另一版。', ['时间为粗略范围。'], { timing: 'approximate' });
  await retry;
  h.ui['export-format'].value = 'json';
  await h.ui['export-button'].click();
  assert.equal(JSON.parse(await h.downloads.at(-1).blob.text()).timing, 'approximate');
  assert.match(h.ui['rerun-help'].textContent, /恢复带时间轴/);
  const third = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'timestamps');
  h.workers.at(-1).result('时间轴版。');
  await third;
  await h.ui['restore-button'].click();
  assert.equal(h.ui.transcript.value, '另一版。');
  assert.match(h.ui['rerun-help'].textContent, /恢复带时间轴/);
});

test('changing language updates the retry explanation and uses ordinary timestamp decoding', async () => {
  const h = harness();
  await h.add([file('切换语言.wav')]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).result('中文结果。');
  await initial;
  assert.match(h.ui['rerun-help'].textContent, /另一种文字识别方式/);
  h.ui.language.value = 'english';
  await h.ui.language.emit('change');
  assert.doesNotMatch(h.ui['rerun-help'].textContent, /另一种文字识别方式/);
  const changed = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).language, 'english');
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'timestamps');
  h.workers.at(-1).result('English result.');
  await changed;
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
  h.workers.at(-1).result('原稿');
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
  h.workers.at(-1).result('已完成结果');
  await run;
  h.controlsRestored();
  assert.deepEqual(h.states(), ['未完成', '未完成', '已完成']);
  assert.equal(h.ui['start-label'].textContent, '重试未完成文件');
  const retry = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).result('重试一');
  await flush();
  h.workers.at(-1).result('重试二');
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
  h.workers.at(-1).result('第一份');
  await flush();
  assert.equal(h.workers.length, 2);
  h.workers.at(-1).result('第二份');
  await newRun;
  assert.deepEqual(h.states(), ['已完成', '已完成']);
  h.controlsRestored();
});

test('stop during inference preserves completed files and rejects stale Worker events', async () => {
  const h = harness();
  await h.add([file('done.wav'), file('cancel.wav'), file('pending.wav')]);
  const oldRun = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).result('保留这份');
  await flush();
  await h.ui['stop-button'].click();
  await oldRun;
  h.controlsRestored();
  assert.deepEqual(h.states(), ['已完成', '已停止', '待转写']);
  const newRun = h.ui['start-button'].click();
  await flush();
  h.workers[1].result('过期文字');
  h.workers[1].fatal();
  assert.equal(h.workers[2].terminated, false);
  assert.deepEqual(h.states(), ['已完成', '转写中', '待转写']);
  h.workers.at(-1).result('有效结果');
  await flush();
  h.workers.at(-1).result('最后结果');
  await newRun;
  await h.select(0);
  assert.equal(h.ui.transcript.value, '保留这份');
  assert.equal(h.workers.length, 4);
  h.controlsRestored();
});

test('recoverable recognition errors continue the queue without disabling retry', async () => {
  const h = harness();
  await h.add([file('error.wav'), file('success.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).error('模型下载失败');
  await flush();
  assert.equal(h.workers.length, 2);
  h.workers.at(-1).result();
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
  h.workers.at(-1).result('原文甲');
  await flush();
  h.workers.at(-1).result('原文乙');
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
  h.workers.at(-1).result('待复制');
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
  h.workers.at(-1).result('原始甲');
  await flush();
  h.workers.at(-1).result('原始乙');
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
  const request = h.workers.at(-1).messages.at(-1);
  assert.equal(request.model, 'Xenova/whisper-tiny');
  assert.equal(request.language, 'english');
  assert.equal(h.ui.transcript.value, '已校对的甲');
  assert.equal(h.ui.transcript.disabled, true);
  assert.equal(h.ui['result-meta'].textContent, oldMetadata, 'pending settings cannot relabel the old result');
  assert.equal(h.ui['rerun-button'].disabled, true);
  h.workers.at(-1).result('新的甲');
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
  h.workers.at(-1).result('识别原文');
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
  assert.equal(h.workers.at(-1).messages.at(-1).language, 'chinese');
  assert.equal(h.ui['result-meta'].textContent, oldMetadata);
  h.workers.at(-1).error('本次模型加载失败');
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
  h.workers.at(-1).result('第一次结果');
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
  h.workers[1].result('已停止任务的过期结果');
  h.workers[1].fatal();
  assert.equal(h.workers[2].terminated, false);
  assert.equal(h.ui.transcript.value, '用户修改的版本');
  h.workers.at(-1).result('有效新结果');
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
  h.workers.at(-1).result('仍可使用的结果');
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
  h.workers.at(-1).result('最后版本');
  await next;
  assert.equal(h.ui.transcript.value, '最后版本');
  h.controlsRestored();
});

test('Chinese defaults to SenseVoice; existing Tiny and Small rerun choices remain available', async () => {
  const modelOptions = html.match(/<select id="model">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...modelOptions.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['Xenova/whisper-tiny', 'FunAudioLLM/SenseVoiceSmall', 'Xenova/whisper-small']);
  assert.match(modelOptions, /value="FunAudioLLM\/SenseVoiceSmall" selected>中文增强/);
  for (const model of ['Xenova/whisper-tiny', 'Xenova/whisper-small']) {
    const h = harness();
    assert.equal(h.ui.model.value, 'Xenova/whisper-small');
    h.ui.model.value = model;
    await h.add([file('提高精度.wav')]);
    const initial = h.ui['start-button'].click();
    await flush();
    h.workers.at(-1).result('原结果');
    await initial;
    const oldMetadata = h.ui['result-meta'].textContent;
    if (model === 'Xenova/whisper-tiny') assert.match(h.ui['rerun-help'].textContent, /改用高精度.*190 MB/);
    else assert.doesNotMatch(h.ui['rerun-help'].textContent, /改用高精度/);
    const upgraded = h.ui['rerun-button'].click();
    await flush();
    assert.equal(h.workers.at(-1).messages.at(-1).model, 'Xenova/whisper-small');
    assert.equal(h.ui.model.value, 'Xenova/whisper-small');
    assert.equal(h.ui['result-meta'].textContent, oldMetadata);
    h.workers.at(-1).result('高精度结果');
    await upgraded;
    assert.match(h.ui['result-meta'].textContent, /高精度/);
    assert.match(h.ui['rerun-help'].textContent, /相同设置通常结果相同/);
    assert.doesNotMatch(h.ui['rerun-help'].textContent, /改用高精度/);
    const samePrecision = h.ui['rerun-button'].click();
    await flush();
    assert.equal(h.workers.at(-1).messages.at(-1).model, 'Xenova/whisper-small');
    h.workers.at(-1).result('第二次高精度结果');
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
  h.workers.at(-1).result('快速结果');
  await initial;
  h.ui.model.value = 'Xenova/whisper-small';
  await h.ui.model.emit('change');
  h.ui.model.value = 'Xenova/whisper-tiny';
  await h.ui.model.emit('change');
  assert.doesNotMatch(h.ui['rerun-help'].textContent, /改用高精度/);
  const rerun = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).model, 'Xenova/whisper-tiny');
  h.workers.at(-1).result('仍使用手动选择的快速精度');
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
  h.workers.at(-1).result(repeated, [warning, '<提示文字>', null]);
  await initial;
  assert.equal(h.ui.transcript.value, repeated, 'a warning must not delete recognized text');
  assert.equal(h.ui['result-warning'].hidden, false);
  assert.equal(h.ui['result-warning'].textContent, `${warning} <提示文字>`);
  const rerun = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.ui['result-warning'].textContent, `${warning} <提示文字>`);
  h.workers.at(-1).result('新识别的内容');
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
  assert.equal(h.workers.at(-1).messages.at(-1).language, 'chinese');
  assert.equal(h.workers.at(-1).messages.at(-1).model, 'Xenova/whisper-small');
  h.workers.at(-1).result('中文原文');
  await initial;
  assert.match(h.ui['result-meta'].textContent, /中文/);
  h.ui.language.value = 'english';
  await h.ui.language.emit('change');
  const rerun = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).language, 'english');
  h.workers.at(-1).result('English result');
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

test('explicit visual-only mode bypasses audio decoding and clearly identifies the visual source', async () => {
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
  h.ui['recognition-source'].value = 'video';
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

test('an interview name plate never bypasses full audio in auto mode and both OCR evidence classes stay reviewable', async () => {
  let disposed = false;
  let decodedAudio = 0;
  const samples = new Float32Array(16000 * 45);
  const h = harness(async () => {
    assert.equal(disposed, true, 'release the OCR model before decoding/loading ASR');
    decodedAudio++;
    return { samples, duration: 45 };
  }, videoFixture({
    createClient: () => ({ initialize: async () => {}, recognize: async () => ({ texts: [] }), dispose() { disposed = true; } }),
    fuse: () => ({ reliable: true,
      segments: [{ start: 0.1, end: 0.6, text: '陈敏 研究员', confidence: 0.99, reliable: true }],
      candidates: [{ start: 0.8, end: 1.4, text: '背景招牌', reason: 'static_text' }], warnings: [] }),
  }));
  await h.add([{ ...file('interview.mp4'), type: 'video/mp4' }]);
  const run = h.ui['start-button'].click();
  await flush();
  assert.equal(decodedAudio, 1);
  assert.equal(h.workers.length, 1, 'reliable screen text cannot short-circuit ASR');
  assert.equal(h.workers[0].messages[0].audio.length, samples.length, 'the complete decoded audio is submitted');
  h.workers.at(-1).result('问：这个实验如何进行？答：我们先记录数据。');
  await run;
  assert.equal(h.ui.transcript.value, '问：这个实验如何进行？答：我们先记录数据。');
  assert.doesNotMatch(h.ui['result-meta'].textContent, /画面字幕/);
  assert.equal(h.ui['visual-candidate-list'].children.length, 1);
  assert.equal(h.ui['visual-other-list'].children.length, 1);
  assert.match(h.ui['visual-candidate-list'].children[0].textContent, /陈敏 研究员.*声音尚未确认/);
  assert.match(h.ui['visual-other-list'].children[0].textContent, /背景招牌.*固定画面文字/);
  h.ui['export-format'].value = 'json';
  await h.ui['export-button'].click();
  const exported = JSON.parse(await h.downloads.at(-1).blob.text());
  assert.equal(exported.source, 'audio');
  assert.doesNotMatch(exported.text, /陈敏|背景招牌/);
  assert.doesNotMatch(exported.segments.map(segment => segment.text).join(''), /陈敏|背景招牌/);
  h.controlsRestored();
});

test('an auto video without a readable audio track keeps OCR candidates and can be retried in explicit visual-only mode', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; throw new Error('无法读取音轨'); }, videoFixture({
    fuse: () => ({ reliable: true, segments: [{ start: 0, end: 1, text: '画面歌词。' }], candidates: [], warnings: [] }),
  }));
  await h.add([{ ...file('no-audio.mp4'), type: 'video/mp4' }]);
  await h.ui['start-button'].click();
  assert.deepEqual(h.states(), ['未完成'], 'audio failure must not silently turn auto into an OCR transcript');
  assert.equal(h.ui['visual-candidates'].hidden, false);
  assert.match(h.ui['visual-candidate-list'].children[0].textContent, /画面歌词/);
  h.ui['recognition-source'].value = 'video';
  await h.ui['start-button'].click();
  assert.equal(reads, 1, 'explicit video-only retry does not need an audio track');
  assert.equal(h.workers.length, 0);
  assert.equal(h.ui.transcript.value, '画面歌词。');
  assert.match(h.ui['result-meta'].textContent, /画面字幕/);
  h.controlsRestored();
});

test('auto video retries preserve and restore the matching audio draft and visual evidence', async () => {
  let version = 1;
  const h = harness(undefined, videoFixture({
    fuse: () => ({ reliable: true, segments: [{ start: 0, end: 1, text: `标题${version}` }],
      candidates: [{ start: 1, end: 2, text: `候选${version}`, reason: 'needs_review' }], warnings: [] }),
  }));
  await h.add([{ ...file('interview-retry.mp4'), type: 'video/mp4' }]);
  const initial = h.ui['start-button'].click();
  await flush();
  h.workers.at(-1).result('第一次采访识别。');
  await initial;
  h.ui.transcript.value = '手动校对的采访。';
  await h.ui.transcript.emit('input');
  version = 2;
  const retry = h.ui['rerun-button'].click();
  await flush();
  assert.equal(h.workers[0].terminated, true, 'old ASR heap is released before the next OCR pass');
  assert.equal(h.workers.length, 2);
  assert.equal(h.ui.transcript.value, '手动校对的采访。');
  h.workers.at(-1).result('第二次采访识别。');
  await retry;
  assert.match(h.ui['visual-candidate-list'].children[0].textContent, /标题2/);
  await h.ui['restore-button'].click();
  assert.equal(h.ui.transcript.value, '手动校对的采访。');
  assert.match(h.ui['visual-candidate-list'].children[0].textContent, /标题1/);
  assert.match(h.ui['visual-candidate-list'].children[1].textContent, /候选1/);
  h.controlsRestored();
});

test('uncertain video text stays out of the audio transcript and remains separately reviewable', async () => {
  const h = harness(undefined, videoFixture({ fuse: () => ({ reliable: false, segments: [], candidates: [{ start: 0, text: '背景招牌', reason: '固定文字' }], warnings: [] }) }));
  await h.add([{ ...file('uncertain.mp4'), type: 'video/mp4' }]);
  const run = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers.length, 1);
  h.workers.at(-1).result('识别出的声音。');
  await run;
  assert.equal(h.ui.transcript.value, '识别出的声音。');
  assert.match(h.ui['result-warning'].textContent, /已继续识别声音/);
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
  h.workers.at(-1).result('第一版。');
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

test('stopping during punctuation preserves a manually edited previous result', async () => {
  const pending = deferred();
  let calls = 0;
  let punctuationSignal;
  const h = harness(undefined, { punctuate: (result, { signal }) => {
    if (++calls === 1) return Promise.resolve(result);
    punctuationSignal = signal;
    return pending.promise;
  } });
  await h.add([file('punctuation.wav')]);
  const initial = h.ui['start-button'].click();
  await flush(); h.workers.at(-1).result('原始文字'); await initial;
  h.ui.transcript.value = '保留我校对的文字。';
  await h.ui.transcript.emit('input');
  const rerun = h.ui['rerun-button'].click();
  await flush(); h.workers.at(-1).result('新的识别文字'); await flush();
  assert.match(h.ui['progress-stage'].textContent, /标点/);
  await h.ui['stop-button'].click();
  assert.equal(punctuationSignal.aborted, true);
  pending.resolve({ text: '迟到的标点结果。', duration: 1, segments: [] });
  await rerun;
  assert.equal(h.ui.transcript.value, '保留我校对的文字。');
  assert.equal(h.ui['restore-button'].hidden, true);
  h.controlsRestored();
});

test('SenseVoice retries recreate the worker with real verbatim inference and restore the original draft', async () => {
  const h = harness(); h.ui.model.value = 'FunAudioLLM/SenseVoiceSmall';
  await h.add([file('中文快语速.wav')]);
  const first = h.ui['start-button'].click(); await flush();
  assert.equal(h.workers.at(-1).messages.at(-1).model, 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'timestamps');
  h.workers.at(-1).result('第一版'); await first;
  h.ui.transcript.value = '保留我的修改'; await h.ui.transcript.emit('input');
  assert.match(h.ui['rerun-help'].textContent, /按原话识别/);
  const rerun = h.ui['rerun-button'].click(); await flush();
  assert.equal(h.workers[0].terminated, true, 'old WASM heap is released before loading the new recognizer');
  assert.equal(h.workers.at(-1).messages.at(-1).decoding, 'text');
  h.workers.at(-1).result('原话版本'); await rerun;
  await h.ui['restore-button'].click();
  assert.equal(h.ui.transcript.value, '保留我的修改');
  h.ui.language.value = 'english'; await h.ui.language.emit('change');
  assert.equal(h.ui.model.value, 'Xenova/whisper-small', 'English keeps the existing validated Whisper model');
  const english = h.ui['rerun-button'].click(); await flush();
  assert.equal(h.workers[1].terminated, true);
  assert.equal(h.workers.at(-1).messages.at(-1).language, 'english');
  h.workers.at(-1).result('English words.'); await english;
  h.controlsRestored();
});

test('compact build retains the enhanced model and fast fallback without requesting absent Small assets', async () => {
  const h = harness(undefined, { compact: true });
  assert.equal(h.ui.model.value, 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(h.ui.model.removedSelector, 'option[value="Xenova/whisper-small"]');
  assert.equal(h.ui['full-version-link'].hidden, false);
  h.ui.model.value = 'Xenova/whisper-tiny';
  await h.add([file('compact.wav')]);
  const run = h.ui['start-button'].click(); await flush(); h.workers.at(-1).result('第一版'); await run;
  assert.match(h.ui['rerun-help'].textContent, /中文增强.*152/);
  const again = h.ui['rerun-button'].click(); await flush();
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.workers.at(-1).messages.at(-1).model, 'FunAudioLLM/SenseVoiceSmall');
  h.workers.at(-1).result('中文增强'); await again;
  assert.match(h.ui['rerun-help'].textContent, /完整版/);
  h.ui.language.value = 'english'; await h.ui.language.emit('change');
  assert.equal(h.ui.model.value, 'FunAudioLLM/SenseVoiceSmall');
});

// These doubles verify lifecycle ordering, not browser memory reclamation.
test('each file releases ASR before punctuation, the next decode and VAD; clear leaves none running', async () => {
  let h;
  let reads = 0;
  const assertReleased = () => assert.ok(h.workers.every(worker => worker.terminated));
  h = harness(async (_file, { signal }) => {
    assert.equal(signal.aborted, false);
    assertReleased();
    reads++;
    return decoded();
  }, {
    speechCheck: async () => { assertReleased(); return { reject: false }; },
    punctuate: async result => { assertReleased(); return result; },
  });
  await h.add([file('one.wav'), file('two.wav')]);
  const run = h.ui['start-button'].click();
  await flush();
  const first = h.workers[0];
  first.result('第一份');
  assert.equal(first.terminated, true, 'release is synchronous, before the result promise resolves');
  await flush();
  assert.equal(reads, 2);
  assert.equal(h.workers.length, 2);
  first.error('过期错误');
  first.fatal();
  assert.equal(h.workers[1].terminated, false);
  h.workers[1].result('第二份');
  await run;
  assertReleased();
  await h.ui['clear-files'].click();
  assert.deepEqual(h.states(), []);
  assertReleased();
});

test('ordinary errors and postMessage failures release the worker and permit fresh retries', async () => {
  let failPost = true;
  const h = harness(undefined, { postMessage: () => {
    if (failPost) { failPost = false; throw new Error('模拟传输失败'); }
  } });
  await h.add([file('retry.wav')]);
  await h.ui['start-button'].click();
  assert.equal(h.workers[0].terminated, true);
  assert.deepEqual(h.states(), ['未完成']);
  const retry = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers.length, 2);
  h.workers[1].error('模拟模型中止');
  assert.equal(h.workers[1].terminated, true);
  await retry;
  const next = h.ui['start-button'].click();
  await flush();
  assert.equal(h.workers.length, 3);
  h.workers[1].error('过期模型错误');
  h.workers[1].fatal();
  assert.equal(h.workers[2].terminated, false);
  h.workers[2].result('恢复成功');
  await next;
  assert.equal(h.ui.transcript.value, '恢复成功');
  assert.ok(h.workers.every(worker => worker.terminated));
  h.controlsRestored();
});

test('stop passes an aborted signal to the decoder and preserves a fresh run signal', async () => {
  const pending = deferred();
  const signals = [];
  const h = harness((_file, { signal }) => {
    signals.push(signal);
    return signals.length === 1 ? pending.promise : Promise.resolve(decoded());
  });
  await h.add([file('cancel-decode.wav')]);
  const first = h.ui['start-button'].click();
  await h.ui['stop-button'].click();
  assert.equal(signals[0].aborted, true);
  const next = h.ui['start-button'].click();
  await flush();
  assert.equal(signals[1].aborted, false);
  pending.reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
  await first;
  assert.equal(h.workers.length, 1);
  h.workers[0].result('新任务');
  await next;
  assert.equal(h.ui.transcript.value, '新任务');
});

test('caption review compares local ASR, keeps credits collapsed, and replay/copy preserve the draft', async () => {
  const caption={start:.2,end:1,text:'我们明天继续练习。',reliable:true,category:'subtitle'};
  const credit={start:.2,end:1,text:'编剧。',reliable:false,reason:'probable_credit',category:'credits'};
  const h=harness(undefined,videoFixture({fuse:()=>({reliable:true,segments:[caption],candidates:[credit],warnings:[]})}));
  await h.add([{...file('captions.mp4'),type:'video/mp4'}]);
  const run=h.ui['start-button'].click();await flush();h.workers.at(-1).result('我们明天继续练习。');await run;
  assert.match(h.ui['visual-summary'].textContent,/1 句与语音识别一致/);
  assert.equal(h.ui['visual-other-list'].children.length,1);
  assert.match(h.ui['visual-other-list'].children[0].textContent,/疑似演职员信息/);
  const actions=h.ui['visual-candidate-list'].children[0].children.at(-1).children;
  let plays=0,pauses=0;h.ui['source-player'].play=()=>{plays++;return Promise.resolve();};h.ui['source-player'].pause=()=>{pauses++;};
  await actions[0].click();assert.equal(plays,1);assert.equal(h.ui['source-player-wrap'].hidden,false);
  await h.ui['source-player'].emit('loadedmetadata');assert.equal(h.ui['source-player'].currentTime,0);
  h.ui['source-player'].currentTime=1.8;await h.ui['source-player'].emit('timeupdate');assert.equal(pauses,1);
  await actions[1].click();assert.equal(h.clipboard.values.at(-1),caption.text);assert.equal(h.ui.transcript.value,caption.text);
  await h.ui['clear-files'].click();assert.equal(h.ui['source-player-wrap'].hidden,true);
});

test('audio-only retry refreshes agreement and restore recovers the previous evidence', async () => {
  const h=harness(undefined,videoFixture({fuse:()=>({reliable:true,segments:[{start:0,end:1,text:'我们明天继续练习。',reliable:true}],candidates:[],warnings:[]})}));
  await h.add([{...file('captions-retry.mp4'),type:'video/mp4'}]);
  const initial=h.ui['start-button'].click();await flush();h.workers.at(-1).result('我们明天继续练习。');await initial;
  assert.match(h.ui['visual-summary'].textContent,/1 句与语音识别一致/);
  h.ui['recognition-source'].value='audio';
  const retry=h.ui['rerun-button'].click();await flush();
  assert.doesNotMatch(h.ui['visual-summary'].textContent,/与语音识别一致/,'an active retry invalidates the old agreement');
  h.workers.at(-1).result('这里讲述另一个故事。');await retry;
  assert.doesNotMatch(h.ui['visual-summary'].textContent,/与语音识别一致/);
  await h.ui['restore-button'].click();assert.match(h.ui['visual-summary'].textContent,/1 句与语音识别一致/);
});

test('canceled punctuation cannot attach new ASR agreement to the previous draft', async () => {
  let calls=0;const pending=deferred();
  const h=harness(undefined,videoFixture({fuse:()=>({reliable:true,segments:[{start:0,end:1,text:'我们明天继续练习。',reliable:true}],candidates:[],warnings:[]}),
    punctuate:(result,{signal})=>{if(++calls===1)return Promise.resolve(result);signal.addEventListener('abort',()=>pending.reject(new DOMException('stop','AbortError')));return pending.promise;}}));
  await h.add([{...file('cancel-review.mp4'),type:'video/mp4'}]);const first=h.ui['start-button'].click();await flush();h.workers.at(-1).result('这是之前的正文。');await first;
  const retry=h.ui['rerun-button'].click();await flush();h.workers.at(-1).result('我们明天继续练习。');await flush();await h.ui['stop-button'].click();await retry;
  assert.equal(h.ui.transcript.value,'这是之前的正文。');assert.doesNotMatch(h.ui['visual-summary'].textContent,/与语音识别一致/);
});
