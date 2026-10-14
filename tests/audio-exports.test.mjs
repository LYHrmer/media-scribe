import test from 'node:test';
import assert from 'node:assert/strict';
import { downmixChannels, getResampledLength, validateMediaFile, MAX_FILE_BYTES } from '../src/audio.js';
import { renderTxt, renderSrt, renderVtt, renderJson } from '../src/exports.js';

test('ordinary stereo downmix preserves signal levels without amplification', () => {
  const signal = new Float32Array([-1, -0.25, 0, 0.5, 1]);
  assert.deepEqual(downmixChannels([signal, signal]), signal);
  assert.deepEqual(downmixChannels([signal]), signal);
  assert.deepEqual(downmixChannels([new Float32Array([1, 0]), new Float32Array([0, 1])]), new Float32Array([0.5, 0.5]));
});

test('inverted stereo copies retain audible recording instead of becoming silent', () => {
  const signal = new Float32Array([-0.8, -0.2, 0, 0.4, 0.8]);
  const inverted = signal.map(sample => -sample);
  const nearInverted = signal.map(sample => -sample * 0.99999);
  assert.deepEqual(downmixChannels([signal, inverted]), signal);
  assert.deepEqual(downmixChannels([signal, nearInverted]), signal);
  assert.deepEqual(signal, new Float32Array([-0.8, -0.2, 0, 0.4, 0.8]));
});

test('centered speech remains averaged when anti-phase background is suppressed', () => {
  const speech = new Float32Array([0.001, -0.001, 0.001, -0.001]);
  const background = new Float32Array([0.5, 0.25, -0.5, -0.25]);
  const left = speech.map((sample, index) => sample + background[index]);
  const right = speech.map((sample, index) => sample - background[index]);
  const mono = downmixChannels([left, right]);
  for (let i = 0; i < speech.length; i += 1) {
    assert.ok(Math.abs(mono[i] - speech[i]) < 2e-8);
  }
});

test('silence and inaudibly small opposite channels remain silent', () => {
  const silence = new Float32Array(4);
  assert.deepEqual(downmixChannels([silence, silence]), silence);
  const tiny = new Float32Array([1e-8, -1e-8, 1e-8, -1e-8]);
  assert.deepEqual(downmixChannels([tiny, tiny.map(sample => -sample)]), silence);
});

test('invalid channel data is rejected instead of becoming silent or NaN samples', () => {
  assert.throws(() => downmixChannels([]));
  assert.throws(() => downmixChannels([[]]));
  assert.throws(() => downmixChannels([new Float32Array(0)]));
  assert.throws(() => downmixChannels([new Float32Array([1]), null]));
  assert.throws(() => downmixChannels([new Float32Array([1]), new Float32Array([1, 2])]));
  assert.throws(() => downmixChannels([new Float32Array([NaN])]));
  assert.throws(() => downmixChannels([new Float32Array([Infinity])]));
});

test('resampling buffer preserves duration at native audio rates including partial samples', () => {
  assert.equal(getResampledLength(48000 * 3, 48000), 16000 * 3);
  assert.equal(getResampledLength(44100, 44100), 16000);
  assert.equal(getResampledLength(22050, 22050), 16000);
  assert.equal(getResampledLength(1, 48000), 1);
  const sourceLength = 44101;
  const resampled = getResampledLength(sourceLength, 44100);
  assert.ok(resampled / 16000 >= sourceLength / 44100);
  assert.ok(resampled / 16000 - sourceLength / 44100 < 1 / 16000);
  assert.throws(() => getResampledLength(0, 48000));
  assert.throws(() => getResampledLength(10, NaN));
});

test('empty and oversized files fail before any browser decoder reads them', () => {
  const file = size => ({ size, arrayBuffer() { throw new Error('must not read'); } });
  assert.throws(() => validateMediaFile(file(0)), /空/);
  assert.throws(() => validateMediaFile(file(MAX_FILE_BYTES + 1)), /300 MB/);
  assert.doesNotThrow(() => validateMediaFile(file(MAX_FILE_BYTES)));
  assert.throws(() => validateMediaFile(null));
});

const segments = [
  { start: 0, end: 59.9996, text: '你好，世界。' },
  { start: 60, end: 3600.0004, text: 'A < B & C > D\nEnglish.' },
];

test('TXT and JSON preserve Chinese and normalize predictable output', () => {
  assert.equal(renderTxt('  中文\r\nEnglish.  '), '中文\nEnglish.\n');
  const result = { text: '你好，世界。', duration: 3601, segments };
  assert.deepEqual(JSON.parse(renderJson(result)), result);
  assert.throws(() => renderTxt(null));
  assert.throws(() => renderJson({ text: 'x', duration: 1, segments }));
});

test('subtitle timestamps carry milliseconds across minutes and hours', () => {
  const srt = renderSrt(segments);
  assert.match(srt, /00:00:00,000 --> 00:01:00,000/);
  assert.match(srt, /00:01:00,000 --> 01:00:00,000/);
  const vtt = renderVtt(segments);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.match(vtt, /00:01:00\.000 --> 01:00:00\.000/);
});

test('literal subtitle speech cannot inject cue markup or extra cue blocks', () => {
  const literal = [{ start: 0, end: 1, text: '<script> &\n\n00:00:00 --> 00:00:01' }];
  const vtt = renderVtt(literal);
  assert.ok(vtt.includes('&lt;script&gt; &amp;'));
  assert.ok(vtt.includes('--&gt;'));
  assert.ok(!vtt.includes('<script>'));
  assert.equal(vtt.split('\n\n').length, 2);
});

test('both subtitle formats reject nonfinite, reversed, unordered and submillisecond timing', () => {
  const invalid = [
    { start: -1, end: 1, text: 'x' },
    { start: 1, end: 1, text: 'x' },
    { start: 2, end: 1, text: 'x' },
    { start: 0, end: Infinity, text: 'x' },
    { start: NaN, end: 1, text: 'x' },
    { start: 1, end: 1.0001, text: 'x' },
  ];
  for (const segment of invalid) {
    assert.throws(() => renderSrt([segment]), RangeError);
    assert.throws(() => renderVtt([segment]), RangeError);
  }
  assert.throws(() => renderSrt([{ start: 2, end: 3, text: 'later' }, { start: 0, end: 1, text: 'earlier' }]), RangeError);
  assert.equal(renderSrt([]), '');
  assert.equal(renderVtt([]), 'WEBVTT\n\n');
});

test('JSON export preserves visual source, unpunctuated evidence and review warnings', () => {
  const result = { text: '会议开始。', rawText: '会议开始', source: 'video_ocr', duration: 2,
    segments: [{ start: 0, end: 2, text: '会议开始。' }], warnings: ['画面文字尚未与语音核对。'] };
  assert.deepEqual(JSON.parse(renderJson(result)), result);
});

// Gain is a reproducibility detail, not a model confidence score.
test('JSON retains bounded retry gain without accepting invalid metadata', () => {
  for (const audioGain of [1, 0, NaN, Infinity, 9, 6.25]) {
    const result = JSON.parse(renderJson({ text: '你好。', duration: 1, segments: [], audioGain }));
    assert.equal(result.audioGain, audioGain === 6.25 ? 6.25 : undefined);
  }
});
