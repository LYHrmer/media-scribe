import test from 'node:test';
import assert from 'node:assert/strict';
import { findAudioRanges } from '../src/audio-segments.js';

const RATE = 16000;
const FRAME = Math.round(RATE * 0.02);
const CONTEXT = Math.round(RATE * 0.3);

function audio(seconds, spans = []) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (const [start, end, level = 0.1] of spans) {
    samples.fill(level, Math.round(start * RATE), Math.round(end * RATE));
  }
  return samples;
}

function assertRangesInBounds(ranges, length) {
  let previousEnd = 0;
  for (const { start, end } of ranges) {
    assert.ok(Number.isInteger(start) && Number.isInteger(end), 'sample bounds are integers');
    assert.ok(start >= previousEnd && start < end && end <= length, 'ranges are ordered, nonempty and clipped');
    previousEnd = end;
  }
}

function assertNear(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= FRAME + 1, `expected ${actual} to be within one frame of ${expected}`);
}

test('empty and entirely near-silent audio produce no inference ranges', () => {
  assert.deepEqual(findAudioRanges(new Float32Array()), []);
  assert.deepEqual(findAudioRanges(new Float32Array(17)), []);
  assert.deepEqual(findAudioRanges(audio(5)), []);
  assert.deepEqual(findAudioRanges(new Float32Array(RATE * 2).fill(1e-5)), []);
  const impulseAtLimit = new Float32Array(RATE * 2);
  impulseAtLimit[100] = 1e-4;
  assert.deepEqual(findAudioRanges(impulseAtLimit), []);
});

test('RMS above the quiet threshold retains a very low-level continuous signal', () => {
  const quietSignal = new Float32Array(RATE + 37).fill(1.01e-5);
  assert.deepEqual(findAudioRanges(quietSignal), [{ start: 0, end: quietSignal.length }]);
});

test('a single peak above the threshold is retained even when frame RMS is below its threshold', () => {
  const samples = audio(5);
  const impulseIndex = Math.round(2.5 * RATE);
  samples[impulseIndex] = 1.01e-4;
  const ranges = findAudioRanges(samples);
  assert.equal(ranges.length, 1);
  assertRangesInBounds(ranges, samples.length);
  assert.ok(ranges[0].start <= impulseIndex && ranges[0].end > impulseIndex, 'the quiet impulse is not discarded');
  const frameStart = Math.floor(impulseIndex / FRAME) * FRAME;
  assertNear(ranges[0].start, frameStart - CONTEXT);
  assertNear(ranges[0].end, frameStart + FRAME + CONTEXT);
});

test('a 1.48 second internal quiet pause does not split speech', () => {
  const samples = audio(3.48, [[0, 1], [2.48, 3.48]]);
  assert.deepEqual(findAudioRanges(samples), [{ start: 0, end: samples.length }]);
});

test('a continuous 1.5 second internal quiet pause splits with context on both sides', () => {
  const samples = audio(3.5, [[0, 1], [2.5, 3.5]]);
  const ranges = findAudioRanges(samples);
  assert.equal(ranges.length, 2);
  assertRangesInBounds(ranges, samples.length);
  assert.equal(ranges[0].start, 0);
  assertNear(ranges[0].end, RATE + CONTEXT);
  assertNear(ranges[1].start, Math.round(2.5 * RATE) - CONTEXT);
  assert.equal(ranges[1].end, samples.length);
});

test('long leading, internal and trailing quiet spans preserve speech and roughly 0.3 second context', () => {
  const samples = audio(8, [[2, 3], [5, 6]]);
  const ranges = findAudioRanges(samples);
  assert.equal(ranges.length, 2);
  assertRangesInBounds(ranges, samples.length);
  for (const [range, speechStart, speechEnd] of [[ranges[0], 2, 3], [ranges[1], 5, 6]]) {
    assertNear(range.start, speechStart * RATE - CONTEXT);
    assertNear(range.end, speechEnd * RATE + CONTEXT);
    assert.ok(range.start <= speechStart * RATE && range.end >= speechEnd * RATE, 'all speech samples remain included');
  }
});

test('short quiet spans at the boundaries remain included', () => {
  const samples = audio(3.96, [[1.48, 2.48]]);
  assert.deepEqual(findAudioRanges(samples), [{ start: 0, end: samples.length }]);
});

test('a final partial frame uses its own RMS and clips the range at the last real sample', () => {
  const samples = new Float32Array(RATE * 2 + 1);
  samples[samples.length - 1] = 2e-5;
  const ranges = findAudioRanges(samples);
  assert.equal(ranges.length, 1);
  assertRangesInBounds(ranges, samples.length);
  assertNear(ranges[0].start, RATE * 2 - CONTEXT);
  assert.equal(ranges[0].end, samples.length);
});

test('sample range duration follows a non-default sample rate', () => {
  const sampleRate = 8000;
  const samples = new Float32Array(sampleRate * 4);
  samples.fill(0.02, sampleRate * 2);
  const ranges = findAudioRanges(samples, sampleRate);
  assert.equal(ranges.length, 1);
  assertRangesInBounds(ranges, samples.length);
  assert.ok(Math.abs(ranges[0].start - sampleRate * 1.7) <= sampleRate * 0.02 + 1);
  assert.equal(ranges[0].end, samples.length);
  assert.ok(Math.abs((ranges[0].end - ranges[0].start) / sampleRate - 2.3) <= 0.021);
});
