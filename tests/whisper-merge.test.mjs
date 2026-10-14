import assert from 'node:assert/strict';
import test from 'node:test';
import { installWhisperNonoverlapGuard, installSafeTimestampMerge, transcribeWithSafeTimestampMerge, VERIFIED_TRANSFORMERS_VERSION } from '../src/whisper-nonoverlap-wrapper.js';

const settings = { transformersVersion: '3.8.1' };
const options = { return_timestamps: true, time_precision: 0.02 };
const begin = 50364;
const stamp = seconds => begin + Math.round(seconds / 0.02);
function windowAt(end = 19, stride = [30, 0, 5]) {
  return {
    tokens: [50258, stamp(0), 42, stamp(end), stamp(end), 50257],
    stride,
    input_features: { exactObject: true },
    observer: { untouched: true },
  };
}
function harness() {
  const calls = [];
  const result = ['original synchronous result', { chunks: [] }];
  const original = function (...args) { calls.push({ receiver: this, args }); return result; };
  const prototype = { _decode_asr: original };
  const tokenizer = Object.assign(Object.create(prototype), {
    timestamp_begin: begin, all_special_ids: [50258, 50257],
  });
  installWhisperNonoverlapGuard(tokenizer, settings);
  return { tokenizer, calls, result, prototype, original };
}
function assertBypass(h, sequences, opt = options) {
  const extra = { identity: true };
  assert.strictEqual(h.tokenizer._decode_asr(sequences, opt, extra), h.result);
  const call = h.calls.at(-1);
  assert.strictEqual(call.args[0], sequences);
  assert.strictEqual(call.args[1], opt);
  assert.strictEqual(call.args[2], extra);
  assert.strictEqual(call.receiver, h.tokenizer);
}

test('only the pinned, explicitly supplied actual version is accepted', () => {
  assert.equal(VERIFIED_TRANSFORMERS_VERSION, '3.8.1');
  for (const version of [undefined, '3.8.2', '4.0.0']) {
    const tokenizer = { _decode_asr() {} };
    const original = tokenizer._decode_asr;
    assert.throws(() => installWhisperNonoverlapGuard(tokenizer, { transformersVersion: version }), /requires reviewed/);
    assert.strictEqual(tokenizer._decode_asr, original);
  }
});

test('instance installation does not touch the prototype or wrap twice', () => {
  const h = harness();
  const wrapper = h.tokenizer._decode_asr;
  assert.strictEqual(h.prototype._decode_asr, h.original);
  assert.strictEqual(installWhisperNonoverlapGuard(h.tokenizer, settings), h.tokenizer);
  assert.strictEqual(h.tokenizer._decode_asr, wrapper);
  assertBypass(h, [windowAt()]);
  assert.equal(h.calls.length, 1);
});

test('one eligible prefix window changes only its cloned stride metadata', () => {
  const h = harness();
  const sequences = [windowAt(), windowAt(10, [15, 5, 0])];
  for (const sequence of sequences) {
    Object.freeze(sequence.tokens); Object.freeze(sequence.stride); Object.freeze(sequence);
  }
  Object.freeze(sequences);
  const extra = { forwarded: true };
  const result = h.tokenizer._decode_asr(sequences, options, extra, undefined);
  assert.strictEqual(result, h.result);
  assert.equal(result instanceof Promise, false);
  const { receiver, args } = h.calls[0];
  assert.strictEqual(receiver, h.tokenizer);
  assert.equal(args.length, 4);
  assert.strictEqual(args[1], options); assert.strictEqual(args[2], extra);
  assert.equal(args[3], undefined);
  assert.notStrictEqual(args[0], sequences);
  assert.notStrictEqual(args[0][0], sequences[0]);
  assert.strictEqual(args[0][1], sequences[1]);
  assert.deepEqual(args[0][0].stride, [25, 0, 0]);
  assert.deepEqual(sequences[0].stride, [30, 0, 5]);
  for (const field of ['tokens', 'input_features', 'observer']) {
    assert.strictEqual(args[0][0][field], sequences[0][field]);
  }
});

test('dynamic this and extra argument identities survive a triggered call', () => {
  const h = harness();
  const receiver = { timestamp_begin: begin, all_special_ids: [50258, 50257] };
  const extra = Symbol('extra');
  const result = h.tokenizer._decode_asr.call(receiver, [windowAt(), windowAt(10, [15, 5, 0])], options, extra);
  assert.strictEqual(result, h.result);
  assert.strictEqual(h.calls[0].receiver, receiver);
  assert.strictEqual(h.calls[0].args[2], extra);
});

test('zero triggers forward the original sequence object and every argument', () => {
  for (const end of [20, 24, 29]) {
    assertBypass(harness(), [windowAt(end), windowAt(10, [15, 5, 0])]);
  }
  for (const return_timestamps of [false, 'word', undefined, 1]) {
    assertBypass(harness(), [windowAt(), windowAt(10, [15, 5, 0])], { ...options, return_timestamps });
  }
  assertBypass(harness(), [windowAt(19, [30, 1, 5]), windowAt(10, [15, 5, 0])]);
  assertBypass(harness(), [windowAt()]);
  assertBypass(harness(), [windowAt(), windowAt(10, [15, 5])]);
});

test('consecutive eligible windows are adjusted using original neighbor strides', () => {
  const h = harness();
  const sequences = [windowAt(), windowAt(18, [30, 5, 5]), windowAt(17, [30, 5, 5]), windowAt(10, [15, 5, 0])];
  h.tokenizer._decode_asr(sequences, options);
  const forwarded = h.calls[0].args[0];
  assert.deepEqual(forwarded.map(x => x.stride), [[25, 0, 0], [25, 5, 0], [25, 5, 0], [15, 5, 0]]);
  assert.strictEqual(forwarded[3], sequences[3]);
  assert.deepEqual(sequences.map(x => x.stride), [[30, 0, 5], [30, 5, 5], [30, 5, 5], [15, 5, 0]]);
});

test('first ineligible window ends processing even if later windows qualify', () => {
  const h = harness();
  const sequences = [windowAt(), windowAt(24, [30, 5, 5]), windowAt(17, [30, 5, 5]), windowAt(10, [15, 5, 0])];
  h.tokenizer._decode_asr(sequences, options);
  const forwarded = h.calls[0].args[0];
  assert.deepEqual(forwarded[0].stride, [25, 0, 0]);
  for (let index = 1; index < sequences.length; index++) assert.strictEqual(forwarded[index], sequences[index]);
  const second = harness();
  const blockedFirst = [windowAt(24), windowAt(18, [30, 5, 5]), windowAt(10, [15, 5, 0])];
  assertBypass(second, blockedFirst);
});

test('malformed, nonmonotone, unclosed or zero-length token segments bypass unchanged', () => {
  for (const tokens of [
    [stamp(0), 42],
    [stamp(5), 42, stamp(4)],
    [stamp(0), 42, stamp(0)],
    [stamp(0), 42, stamp(19), 43],
    [stamp(0), 42, stamp(19), Number.NaN],
  ]) {
    const first = { ...windowAt(), tokens };
    assertBypass(harness(), [first, windowAt(10, [15, 5, 0])]);
  }
});

test('original exceptions remain the same synchronous exception object', () => {
  const failure = new Error('original failure');
  const tokenizer = { timestamp_begin: begin, all_special_ids: [50258, 50257], _decode_asr() { throw failure; } };
  installWhisperNonoverlapGuard(tokenizer, settings);
  assert.throws(() => tokenizer._decode_asr([windowAt(), windowAt(10, [15, 5, 0])], options), error => error === failure);
});

test('unexpected decoder replacement is not silently wrapped twice', () => {
  const h = harness();
  h.tokenizer._decode_asr = function replaced() {};
  assert.throws(() => installWhisperNonoverlapGuard(h.tokenizer, settings), /decoder changed/);
});

test('detaching is idempotent and restores the exact original property descriptor', () => {
  for (const inherited of [false, true]) {
    const original = function original() {};
    const tokenizer = inherited ? Object.create({ _decode_asr: original }) : {};
    if (!inherited) Object.defineProperty(tokenizer, '_decode_asr', { value: original, writable: true, configurable: true, enumerable: false });
    const before = Object.getOwnPropertyDescriptor(tokenizer, '_decode_asr');
    const handle = installSafeTimestampMerge(tokenizer, settings);
    assert.strictEqual(installSafeTimestampMerge(tokenizer, settings), handle);
    assert.equal(handle.detach(), true);
    assert.equal(handle.detach(), false);
    assert.strictEqual(tokenizer._decode_asr, original);
    assert.deepEqual(Object.getOwnPropertyDescriptor(tokenizer, '_decode_asr'), before);
    const again = installSafeTimestampMerge(tokenizer, settings);
    assert.notStrictEqual(again, handle);
    again.detach();
  }
});

const englishOptions = { ...options, language: 'english', task: 'transcribe' };
const englishScope = { ...settings, model: 'Xenova/whisper-small' };
function scopedHarness({ rejectWith } = {}) {
  const calls = [];
  const sequences = [windowAt(), windowAt(10, [15, 5, 0])];
  const original = function (received) { calls.push({ received, receiver: this }); return received; };
  const tokenizer = Object.assign(Object.create({ _decode_asr: original }), { timestamp_begin: begin, all_special_ids: [50258, 50257] });
  const pipelineCalls = [];
  const transcriber = async (audio, opts) => {
    pipelineCalls.push({ audio, options: opts, decoder: tokenizer._decode_asr });
    await Promise.resolve();
    const result = tokenizer._decode_asr(sequences, opts);
    if (rejectWith) throw rejectWith;
    return result;
  };
  transcriber.tokenizer = tokenizer;
  return { calls, sequences, original, tokenizer, transcriber, pipelineCalls };
}

test('English Small scope is temporary and cached subsequent Chinese stays untouched', async () => {
  const h = scopedHarness();
  const audio = new Float32Array(2);
  const result = await transcribeWithSafeTimestampMerge(h.transcriber, audio, englishOptions, englishScope);
  assert.deepEqual(result[0].stride, [25, 0, 0]);
  assert.strictEqual(h.pipelineCalls[0].audio, audio);
  assert.strictEqual(h.pipelineCalls[0].options, englishOptions);
  assert.notStrictEqual(h.pipelineCalls[0].decoder, h.original);
  assert.strictEqual(h.tokenizer._decode_asr, h.original);
  assert.equal(Object.hasOwn(h.tokenizer, '_decode_asr'), false);
  const chinese = { ...englishOptions, language: 'chinese' };
  assert.strictEqual(await transcribeWithSafeTimestampMerge(h.transcriber, audio, chinese, englishScope), h.sequences);
  assert.strictEqual(h.pipelineCalls[1].decoder, h.original);
  assert.strictEqual(h.tokenizer._decode_asr, h.original);
});

test('noneligible jobs never install and do not require the pinned version', async () => {
  for (const [opt, model] of [
    [englishOptions, 'Xenova/whisper-tiny'],
    [{ ...englishOptions, language: 'chinese' }, 'Xenova/whisper-small'],
    [{ ...englishOptions, language: 'en' }, 'Xenova/whisper-small'],
    [{ ...englishOptions, task: 'translate' }, 'Xenova/whisper-small'],
    [{ ...englishOptions, return_timestamps: false }, 'Xenova/whisper-small'],
    [{ ...englishOptions, return_timestamps: 'word' }, 'Xenova/whisper-small'],
  ]) {
    const h = scopedHarness();
    assert.strictEqual(await transcribeWithSafeTimestampMerge(h.transcriber, new Float32Array(), opt, { model, transformersVersion: 'unreviewed' }), h.sequences);
    assert.strictEqual(h.pipelineCalls[0].decoder, h.original);
    assert.strictEqual(h.tokenizer._decode_asr, h.original);
  }
});

test('ordinary and cancellation-like rejection restore the decoder and preserve the error', async () => {
  for (const failure of [new Error('inference failed'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    const h = scopedHarness({ rejectWith: failure });
    await assert.rejects(transcribeWithSafeTimestampMerge(h.transcriber, new Float32Array(), englishOptions, englishScope), error => error === failure);
    assert.strictEqual(h.tokenizer._decode_asr, h.original);
    assert.equal(Object.hasOwn(h.tokenizer, '_decode_asr'), false);
  }
});

test('scope preserves an already explicitly installed instance guard', async () => {
  const h = scopedHarness();
  const handle = installSafeTimestampMerge(h.tokenizer, settings);
  const existing = h.tokenizer._decode_asr;
  await transcribeWithSafeTimestampMerge(h.transcriber, new Float32Array(), englishOptions, englishScope);
  assert.strictEqual(h.tokenizer._decode_asr, existing);
  handle.detach();
  assert.strictEqual(h.tokenizer._decode_asr, h.original);
});

