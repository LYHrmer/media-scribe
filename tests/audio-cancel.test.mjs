import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/audio.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Isolated Web Audio doubles verify cancellation boundaries, not native codec
// cancellation, garbage collection, or real-device memory usage.
function harness(options = {}) {
  const calls = { read: 0, context: 0, decode: 0, close: 0, channels: 0, offline: 0, renderedChannels: 0 };
  const audio = { duration: 1, length: 4, sampleRate: options.rate || 48000, numberOfChannels: 2,
    getChannelData() { calls.channels++; return new Float32Array([0.1, 0.2, 0.3, 0.4]); } };
  const rendered = { getChannelData() { calls.renderedChannels++; return new Float32Array([0.2, 0.4]); } };
  class AudioContext {
    constructor() { calls.context++; }
    async decodeAudioData() { calls.decode++; return options.decode ? options.decode(audio) : audio; }
    async close() { calls.close++; await options.close?.(); }
  }
  class OfflineAudioContext {
    constructor() { calls.offline++; }
    createBufferSource() { return { connect() {}, start() {} }; }
    createBuffer() { return { copyToChannel() {} }; }
    async startRendering() { return options.render ? options.render(rendered) : rendered; }
  }
  const context = vm.createContext({ Float32Array, Float64Array, AudioContext, OfflineAudioContext });
  vm.runInContext(source.replace(/^export /gm, ''), context);
  const file = { size: 16, name: 'synthetic.wav', type: 'audio/wav', async arrayBuffer() {
    calls.read++;
    return options.read ? options.read() : new ArrayBuffer(16);
  } };
  return { calls, audio, rendered, decode: settings => context.decodeAudio(file, settings) };
}

test('already canceled audio never reads a file or opens an audio context', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness();
  await assert.rejects(h.decode({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.read, 0);
  assert.equal(h.calls.context, 0);
});

test('cancel while reading stops before native decoding', async () => {
  const pending = deferred();
  const controller = new AbortController();
  const h = harness({ read: () => pending.promise });
  const result = h.decode({ signal: controller.signal });
  controller.abort(); pending.resolve(new ArrayBuffer(16));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(h.calls.read, 1);
  assert.equal(h.calls.context, 0);
});

test('cancel during native decode closes its context and skips channel mixing and resampling', async () => {
  const pending = deferred();
  const started = deferred();
  const controller = new AbortController();
  const h = harness({ decode: () => { started.resolve(); return pending.promise; } });
  const result = h.decode({ signal: controller.signal });
  await started.promise;
  controller.abort(); pending.resolve(h.audio);
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(h.calls.close, 1);
  assert.equal(h.calls.channels, 0);
  assert.equal(h.calls.offline, 0);
});

test('a decoder failure after cancellation remains AbortError rather than a format error', async () => {
  const controller = new AbortController();
  const h = harness({ decode: () => { controller.abort(); throw new Error('allocation failed'); } });
  await assert.rejects(h.decode({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.close, 1);
  assert.equal(h.calls.channels, 0);
});

test('cancellation while closing the native context or entering mixing prevents channel reads', async () => {
  for (const stage of ['close', 'mix']) {
    const controller = new AbortController();
    const h = harness({ close: stage === 'close' ? () => controller.abort() : undefined });
    await assert.rejects(h.decode({ signal: controller.signal, onStatus: status => {
      if (stage === 'mix' && status.includes('整理')) controller.abort();
    } }), { name: 'AbortError' });
    assert.equal(h.calls.close, 1);
    assert.equal(h.calls.channels, 0);
    assert.equal(h.calls.offline, 0);
  }
});

test('cancel during native resampling skips copying the rendered result', async () => {
  const pending = deferred();
  const started = deferred();
  const controller = new AbortController();
  const h = harness({ render: () => { started.resolve(); return pending.promise; } });
  const result = h.decode({ signal: controller.signal });
  await started.promise;
  controller.abort(); pending.resolve(h.rendered);
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(h.calls.offline, 1);
  assert.equal(h.calls.renderedChannels, 0);
});

test('normal decoding preserves mono samples, resampled output and duration', async () => {
  const native = harness({ rate: 16000 });
  const direct = await native.decode({ signal: new AbortController().signal });
  assert.deepEqual(direct.samples, new Float32Array([0.1, 0.2, 0.3, 0.4]));
  assert.equal(native.calls.offline, 0);
  assert.equal(native.calls.close, 1);
  const h = harness();
  const resampled = await h.decode();
  assert.deepEqual(resampled.samples, new Float32Array([0.2, 0.4]));
  assert.equal(resampled.sampleRate, 16000);
  assert.equal(resampled.duration, 1);
  assert.equal(h.calls.channels, 2);
  assert.equal(h.calls.renderedChannels, 1);
  assert.equal(h.calls.close, 1);
});
