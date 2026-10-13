import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Exercise the shipped worker's message handler. Only its dependency loader and
// Vite compile-time base URL are replaced; inference itself is mocked here.
// This suite does not establish real model accuracy or browser compatibility.
const source = await readFile(new URL('../src/transcriber.worker.js', import.meta.url), 'utf8');
const modelAssetSource = await readFile(new URL('../src/model-assets.js', import.meta.url), 'utf8');
const audioSegmentSource = await readFile(new URL('../src/audio-segments.js', import.meta.url), 'utf8');
assert.equal(source.split("import('@huggingface/transformers')").length, 2);
assert.equal(source.split('import.meta.env.BASE_URL').length, 3);
assert.equal(source.split("import { installModelAssetFetch } from './model-assets.js';").length, 2);
assert.equal(source.split("import { findAudioRanges } from './audio-segments.js';").length, 2);
assert.equal(modelAssetSource.split('export function installModelAssetFetch').length, 2);
assert.equal(audioSegmentSource.split('export function findAudioRanges').length, 2);
const executable = audioSegmentSource.replace('export function findAudioRanges', 'function findAudioRanges') + '\n'
  + modelAssetSource.replace('export function installModelAssetFetch', 'function installModelAssetFetch') + '\n' + source
  .replace("import { installModelAssetFetch } from './model-assets.js';", '')
  .replace("import { findAudioRanges } from './audio-segments.js';", '')
  .replace("import('@huggingface/transformers')", '__loadLibrary()')
  .replaceAll('import.meta.env.BASE_URL', "'/test/'");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness({ infer = async () => ({ text: '  你好，世界。  ', chunks: [] }), loadLibrary, loadPipeline, dispose } = {}) {
  const messages = [];
  const calls = [];
  let listener;
  let imports = 0;
  let fetches = 0;
  const env = { allowLocalModels: true, useBrowserCache: false, backends: { onnx: { wasm: {} } } };
  const library = {
    env,
    async pipeline(task, model, options) {
      calls.push({ task, model, options });
      const transcriber = loadPipeline ? await loadPipeline(task, model, options, infer) : async (audio, options) => {
        calls.push({ audio, options });
        return infer(audio, options);
      };
      if (!transcriber.dispose) transcriber.dispose = async () => {
        calls.push({ dispose: model });
        await dispose?.(model);
      };
      return transcriber;
    },
  };
  const sandbox = {
    Float32Array,
    URL,
    WebAssembly,
    Response,
    Request,
    Headers,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    console: { error() {} },
    self: {
      location: { origin: 'https://example.test' },
      postMessage: message => messages.push(message),
      addEventListener(type, callback) {
        assert.equal(type, 'message');
        assert.equal(listener, undefined);
        listener = callback;
      },
    },
    async __loadLibrary() {
      imports++;
      return loadLibrary ? loadLibrary(imports, library) : library;
    },
    fetch() {
      fetches++;
      throw new Error('Worker must not upload or fetch user media');
    },
  };
  const originalFetch = sandbox.fetch;
  vm.runInNewContext(executable, sandbox, { filename: 'transcriber.worker.js' });
  assert.notEqual(sandbox.fetch, originalFetch, 'real same-origin model asset adapter is installed in the isolated worker');
  return {
    messages, calls, env,
    get imports() { return imports; },
    get fetches() { return fetches; },
    async send(job) { await listener({ data: job }); },
    results(type, id) { return messages.filter(m => m.type === type && (id === undefined || m.id === id)); },
  };
}

function signal(seconds = 1) {
  return new Float32Array(Math.round(seconds * 16000)).fill(0.001);
}

function job(id = 'one', overrides = {}) {
  return { type: 'transcribe', id, audio: signal(), ...overrides };
}

test('worker emits a real protocol result with local PCM and requested Chinese transcription options', async () => {
  const h = harness();
  const request = job('zh', { language: 'chinese' });
  await h.send(request);
  assert.equal(h.results('error').length, 0);
  const result = h.results('result', 'zh')[0];
  assert.equal(result.text, '你好，世界。');
  assert.equal(result.duration, 1);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].end, 1);
  assert.equal(h.calls[0].task, 'automatic-speech-recognition');
  assert.equal(h.calls[0].model, 'Xenova/whisper-tiny');
  assert.equal(h.calls[0].options.dtype, 'q8');
  assert.equal(h.calls[0].options.device, 'wasm');
  assert.equal(h.calls[1].audio, request.audio);
  assert.equal(h.calls[1].options.language, 'chinese');
  assert.equal(h.calls[1].options.task, 'transcribe');
  assert.equal(h.calls[1].options.return_timestamps, true);
  assert.equal(h.calls[1].options.chunk_length_s, 30);
  assert.equal(h.calls[1].options.stride_length_s, 5);
  assert.equal(h.fetches, 0);
  assert.equal(h.env.allowLocalModels, false);
  assert.equal(h.env.useBrowserCache, true);
  assert.equal(h.env.remoteHost, 'https://example.test/test/models-v2/');
  assert.equal(h.env.remotePathTemplate, '{model}/');
  assert.equal(h.env.backends.onnx.wasm.numThreads, 1);
  assert.equal(h.env.backends.onnx.wasm.proxy, false);
  assert.equal(h.env.backends.onnx.wasm.wasmPaths.mjs, 'https://example.test/test/vendor/ort/ort-wasm-simd-threaded.mjs');
  assert.equal(h.env.backends.onnx.wasm.wasmPaths.wasm, 'https://example.test/test/vendor/ort/ort-wasm-simd-threaded.wasm');
});

test('invalid PCM, options and foreign model IDs fail before downloading anything', async () => {
  const h = harness();
  const invalid = [
    { audio: null }, { audio: [] }, { audio: new Float32Array() },
    { audio: 'https://example.test/user-media.wav' },
    { model: 'untrusted/arbitrary-model' }, { language: 'unsupported-language' },
    { model: 'Xenova/whisper-base' },
  ];
  for (let i = 0; i < invalid.length; i++) {
    await h.send(job(`invalid-${i}`, invalid[i]));
    assert.equal(h.results('error', `invalid-${i}`).length, 1);
  }
  assert.equal(h.imports, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.fetches, 0);
  await h.send(job('valid-after-errors'));
  assert.equal(h.results('result', 'valid-after-errors').length, 1);
});

test('oversized decoded audio is rejected before a pipeline or user-media request', async () => {
  const h = harness();
  await h.send(job('long', { audio: new Float32Array(16000 * 30 * 60 + 1) }));
  assert.match(h.results('error', 'long')[0].message, /30 分钟/);
  assert.equal(h.imports, 0);
  assert.equal(h.fetches, 0);
});

test('unrelated worker messages have no effects', async () => {
  const h = harness();
  for (const data of [null, undefined, {}, { type: 'upload' }, { type: 'result' }]) await h.send(data);
  assert.equal(h.messages.length, 0);
  assert.equal(h.imports, 0);
});

test('same-model jobs reuse one pipeline and switching releases old models before loading another', async () => {
  const h = harness();
  await h.send(job('tiny-first'));
  await h.send(job('tiny-second', { language: 'english' }));
  await h.send(job('small-first', { model: 'Xenova/whisper-small' }));
  await h.send(job('tiny-third'));
  assert.equal(h.imports, 1);
  assert.deepEqual(h.calls.filter(call => call.task || call.dispose).map(call => call.task ? `load:${call.model}` : `dispose:${call.dispose}`), [
    'load:Xenova/whisper-tiny', 'dispose:Xenova/whisper-tiny',
    'load:Xenova/whisper-small', 'dispose:Xenova/whisper-small',
    'load:Xenova/whisper-tiny',
  ]);
  assert.equal(h.results('result').length, 4);
  assert.deepEqual(h.calls.filter(call => call.task).map(call => call.options.dtype), ['q8', 'q4f16', 'q8']);
  const inference = h.calls.filter(call => call.audio);
  assert.equal(inference[0].options.language, 'chinese');
  assert.equal(inference[1].options.language, 'english');
  assert.equal(inference[3].options.language, 'chinese');
});

test('missing and null language select Chinese while explicit English stays English', async () => {
  const h = harness();
  await h.send(job('missing-language'));
  await h.send(job('null-language', { language: null }));
  await h.send(job('english-language', { language: 'english' }));
  assert.deepEqual(h.calls.filter(call => call.audio).map(call => call.options.language), ['chinese', 'chinese', 'english']);
  assert.equal(h.results('error').length, 0);
});

test('model switches await completed disposal and remain busy until the switch finishes', async () => {
  const entered = deferred();
  const release = deferred();
  const h = harness({ dispose: async () => { entered.resolve(); await release.promise; } });
  await h.send(job('tiny'));
  const switching = h.send(job('small', { model: 'Xenova/whisper-small' }));
  await entered.promise;
  assert.equal(h.calls.filter(call => call.task).length, 1);
  await h.send(job('concurrent-tiny'));
  assert.equal(h.results('error', 'concurrent-tiny').length, 1);
  release.resolve();
  await switching;
  assert.equal(h.calls.filter(call => call.task).length, 2);
  assert.equal(h.results('result', 'small').length, 1);
});

test('failed disposal aborts new model loading and retains the previous handle for retry', async () => {
  let disposals = 0;
  const h = harness({ dispose: async () => { if (++disposals === 1) throw new Error('release failed'); } });
  await h.send(job('tiny'));
  await h.send(job('failed-switch', { model: 'Xenova/whisper-small' }));
  assert.equal(h.results('error', 'failed-switch').length, 1);
  assert.equal(h.calls.filter(call => call.task).length, 1);
  await h.send(job('tiny-reuse'));
  assert.equal(h.calls.filter(call => call.task).length, 1);
  await h.send(job('retry-switch', { model: 'Xenova/whisper-small' }));
  assert.equal(disposals, 2);
  assert.equal(h.calls.filter(call => call.task).length, 2);
  assert.equal(h.results('result', 'retry-switch').length, 1);
});

test('a load failure after a switch can retry without retaining or releasing an already disposed model', async () => {
  let smallLoads = 0;
  const h = harness({ loadPipeline: async (_task, model, _options, infer) => {
    if (model === 'Xenova/whisper-small' && ++smallLoads === 1) throw new Error('Model download 503');
    const transcriber = (...args) => infer(...args);
    return transcriber;
  } });
  await h.send(job('tiny'));
  await h.send(job('failed-small', { model: 'Xenova/whisper-small' }));
  await h.send(job('retry-small', { model: 'Xenova/whisper-small' }));
  assert.equal(h.results('error', 'failed-small').length, 1);
  assert.equal(h.results('result', 'retry-small').length, 1);
  assert.equal(smallLoads, 2);
  assert.deepEqual(h.calls.filter(call => call.dispose).map(call => call.dispose), ['Xenova/whisper-tiny']);
});

test('failed library download resets both import and pipeline promises, allowing retry', async () => {
  const h = harness({ loadLibrary: (attempt, library) => {
    if (attempt === 1) throw new Error('Failed to fetch module');
    return library;
  } });
  await h.send(job('failed'));
  assert.match(h.results('error', 'failed')[0].message, /未能下载/);
  await h.send(job('retry'));
  assert.equal(h.imports, 2);
  assert.equal(h.results('result', 'retry').length, 1);
});

test('failed model load removes its rejected cache entry without reimporting the library', async () => {
  let loads = 0;
  const h = harness({ loadPipeline: async (_task, _model, _options, infer) => {
    if (++loads === 1) throw new Error('Model download 503');
    return infer;
  } });
  await h.send(job('failed'));
  assert.match(h.results('error', 'failed')[0].message, /未能下载/);
  await h.send(job('retry'));
  await h.send(job('reuse'));
  assert.equal(loads, 2);
  assert.equal(h.imports, 1);
  assert.equal(h.results('result').length, 2);
});

test('concurrent requests are rejected while inference runs, and the worker accepts the next job', async () => {
  const entered = deferred();
  const finish = deferred();
  let inferenceCount = 0;
  const h = harness({ infer: async () => {
    if (++inferenceCount === 1) {
      entered.resolve();
      await finish.promise;
    }
    return { text: '完成', chunks: [] };
  } });
  const first = h.send(job('first'));
  await entered.promise;
  await h.send(job('concurrent'));
  assert.match(h.results('error', 'concurrent')[0].message, /上一份文件/);
  assert.equal(inferenceCount, 1);
  finish.resolve();
  await first;
  await h.send(job('next'));
  assert.equal(h.results('result', 'first').length, 1);
  assert.equal(h.results('result', 'next').length, 1);
});

test('download progress retains genuine zero values and bounds invalid provider metadata', async () => {
  const h = harness({ loadPipeline: async (_task, _model, options, infer) => {
    options.progress_callback({ file: 'model.onnx', loaded: 0, total: 100, progress: 0, status: 'progress' });
    options.progress_callback({ loaded: NaN, total: Infinity, progress: 150 });
    options.progress_callback({ progress: -1 });
    options.progress_callback({ progress: NaN });
    return infer;
  } });
  await h.send(job('download'));
  const progress = h.results('download', 'download');
  assert.equal(progress[0].loaded, 0);
  assert.equal(progress[0].progress, 0);
  assert.equal(progress[0].total, 100);
  assert.equal(progress[1].loaded, null);
  assert.equal(progress[1].total, null);
  assert.equal(progress[1].progress, 100);
  assert.equal(progress[2].progress, 0);
  assert.equal(progress[3].progress, null);
});

test('partial, null, out-of-range and backward timestamps become bounded exportable segments', async () => {
  const h = harness({ infer: async () => ({
    text: '第一句 第二句 第三句',
    chunks: [
      { text: ' 第一段 ', timestamp: [-3, 1] },
      { text: ' ', timestamp: [1, 2] },
      { text: '第二段', timestamp: [1, null] },
      { text: '第三段', timestamp: [null, 3] },
      { text: '超出音频', timestamp: [20, 30] },
      { text: '反向', timestamp: [3, 2] },
      { text: '太短', timestamp: [4, 4.0001] },
    ],
  }) });
  await h.send(job('timing', { audio: signal(5) }));
  const result = h.results('result', 'timing')[0];
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments[0].text, '第一段');
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].end, 1);
  assert.equal(result.segments[1].end, 5);
  assert.equal(result.segments[2].start, 1);
  assert.equal(result.segments[2].end, 3);
  const { renderSrt, renderVtt } = await import('../src/exports.js');
  assert.doesNotThrow(() => renderSrt(result.segments));
  assert.doesNotThrow(() => renderVtt(result.segments));
});

test('untimestamped text gets a whole-audio cue and silence stays empty', async () => {
  let runs = 0;
  const h = harness({ infer: async () => ++runs === 1 ? { text: ' 无时间戳 ', chunks: [] } : { text: ' ', chunks: [] } });
  await h.send(job('fallback'));
  assert.equal(h.results('result', 'fallback')[0].segments[0].end, 1);
  await h.send(job('silent'));
  assert.equal(h.results('result', 'silent')[0].text, '');
  assert.equal(h.results('result', 'silent')[0].segments.length, 0);
});

test('obvious repeated Chinese phrases produce a warning while preserving text and original timing', async () => {
  const text = '再见，秋天！再见 秋天。再见秋天；再见秋天。';
  const h = harness({ infer: async () => ({ text, chunks: [{ text, timestamp: [0.2, 0.9] }] }) });
  await h.send(job('repetition'));
  const result = h.results('result', 'repetition')[0];
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /重复/);
  assert.match(result.warnings[0], /可能/);
  assert.equal(result.text, text);
  assert.equal(result.segments[0].text, text);
  assert.equal(result.segments[0].start, 0.2);
  assert.equal(result.segments[0].end, 0.9);
  assert.equal(Object.hasOwn(result, 'confidence'), false);
});

test('normal repeated words and a single repeated chorus do not trigger the repetition warning', async () => {
  for (const text of [
    '今天讨论路径规划，明天还会讨论路径规划。',
    '再见秋天，风从树梢经过。再见秋天，风从树梢经过。',
    '再见秋天，再见秋天，再见秋天。',
    '',
  ]) {
    const h = harness({ infer: async () => ({ text, chunks: [] }) });
    await h.send(job('normal'));
    assert.equal(h.results('result', 'normal')[0].warnings.length, 0, text);
  }
});

test('all near-silence gives an empty warning result without importing or loading a model', async () => {
  const h = harness();
  const audio = new Float32Array(2 * 16000).fill(1e-5);
  await h.send(job('quiet', { audio }));
  const result = h.results('result', 'quiet')[0];
  assert.equal(result.text, '');
  assert.equal(result.segments.length, 0);
  assert.equal(result.duration, 2);
  assert.match(result.warnings[0], /没有检测到可识别的声音/);
  assert.equal(h.imports, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.fetches, 0);
  await h.send(job('non-silent-retry'));
  assert.equal(h.results('result', 'non-silent-retry').length, 1);
  assert.equal(h.calls.filter(call => call.task).length, 1);
});

test('near-silence ranges reuse one pipeline and restore absolute timestamps and full duration', async () => {
  const audio = new Float32Array(8 * 16000);
  audio.fill(0.001, 2 * 16000, 3 * 16000);
  audio.fill(0.001, 5 * 16000, 6 * 16000);
  let inferenceCount = 0;
  const h = harness({ infer: async () => {
    const text = `第${++inferenceCount}段`;
    return { text, chunks: [{ text, timestamp: [0.3, 0.8] }] };
  } });
  await h.send(job('split', { audio }));
  const result = h.results('result', 'split')[0];
  assert.equal(result.text, '第1段\n第2段');
  assert.equal(result.duration, 8);
  assert.equal(result.warnings.length, 0);
  assert.equal(h.calls.filter(call => call.task).length, 1);
  const inference = h.calls.filter(call => call.audio);
  assert.equal(inference.length, 2);
  assert.equal(inference[0].audio.length, 1.6 * 16000);
  assert.equal(inference[1].audio.length, 1.6 * 16000);
  assert.equal(inference[0].audio.buffer, audio.buffer);
  assert.equal(inference[1].audio.buffer, audio.buffer);
  assert.equal(inference[0].options.chunk_length_s, 30);
  assert.equal(inference[1].options.stride_length_s, 5);
  assert.equal(result.segments[0].start, 2);
  assert.equal(result.segments[0].end, 2.5);
  assert.equal(result.segments[1].start, 5);
  assert.equal(result.segments[1].end, 5.5);
});

test('very quiet audio above either near-silence threshold is still transcribed', async () => {
  for (const audio of [
    new Float32Array(16000).fill(1.01e-5),
    Object.assign(new Float32Array(16000), { 500: 1.01e-4 }),
  ]) {
    const h = harness();
    await h.send(job('quiet-voice', { audio }));
    assert.equal(h.calls.filter(call => call.audio).length, 1);
    assert.equal(h.results('result', 'quiet-voice')[0].text, '你好，世界。');
  }
});

test('sparse text over a long sounding range warns without changing text or timestamps', async () => {
  const text = '(字幕製作:貝爾)';
  const h = harness({ infer: async () => ({ text, chunks: [{ text, timestamp: [0, 20] }] }) });
  await h.send(job('sparse-long', { audio: signal(20) }));
  const result = h.results('result', 'sparse-long')[0];
  assert.equal(result.text, text);
  assert.equal(result.segments[0].text, text);
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].end, 20);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /可能存在漏识别/);
  assert.equal(Object.hasOwn(result, 'confidence'), false);
});

test('a short phrase or a long file with only a short sounding range avoids the sparse text warning', async () => {
  const longWithQuiet = new Float32Array(20 * 16000);
  longWithQuiet.fill(0.001, 5 * 16000, 10 * 16000);
  for (const audio of [signal(5), longWithQuiet]) {
    const h = harness({ infer: async () => ({ text: '你好', chunks: [] }) });
    await h.send(job('short-sound', { audio }));
    const result = h.results('result', 'short-sound')[0];
    assert.equal(result.text, '你好');
    assert.equal(result.duration, audio.length / 16000);
    assert.equal(result.warnings.length, 0);
  }
});

test('inference failures produce actionable messages and release the busy flag for subsequent jobs', async () => {
  const errors = ['memory allocation failed', 'Failed to fetch', 'Unsupported execution provider', 'unknown failure'];
  const expected = [/内存不足/, /未能下载/, /浏览器未能启动/, /未完成/];
  let run = 0;
  const h = harness({ infer: async () => {
    if (run < errors.length) throw new Error(errors[run++]);
    return { text: '恢复正常', chunks: [] };
  } });
  for (let i = 0; i < errors.length; i++) {
    await h.send(job(`error-${i}`));
    assert.match(h.results('error', `error-${i}`)[0].message, expected[i]);
  }
  await h.send(job('recovered'));
  assert.equal(h.results('result', 'recovered')[0].text, '恢复正常');
  assert.equal(h.calls.filter(call => call.task).length, 1);
});

test('HTTP access denial keeps its status, stops loading and allows a later user retry', async () => {
  for (const status of [401, 403]) {
    const h = harness({ loadLibrary: async (attempt, library) => {
      if (attempt === 1) throw new Error(`Failed to fetch runtime: HTTP ${status}`);
      return library;
    } });
    await h.send(job('blocked'));
    const message = h.results('error', 'blocked')[0].message;
    assert.match(message, new RegExp(`网站资源访问被拒绝.*HTTP ${status}`));
    assert.match(message, /系统浏览器/);
    assert.equal(h.calls.length, 0, 'denied library cannot proceed to model loading');
    await h.send(job('retry'));
    assert.equal(h.imports, 2);
    assert.equal(h.results('result', 'retry')[0].text, '你好，世界。');
  }
});
