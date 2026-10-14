import test from 'node:test';
import assert from 'node:assert/strict';
import { quietAudioGain, applyAudioGain } from '../src/audio-level.js';

test('silence, almost silent and ordinary audio remain untouched', () => {
  for (const amplitude of [0, 1e-6, 0.02, 0.3]) {
    const audio = new Float32Array(1600).fill(amplitude);
    assert.equal(quietAudioGain(audio), 1);
    assert.equal(applyAudioGain(audio, 1), audio);
  }
});

test('quiet gain preserves waveform, length, input and channel sign without clipping', () => {
  const audio = Float32Array.from({ length: 16000 }, (_, i) => 0.005 * Math.sin(i / 7));
  const original = audio.slice(), gain = quietAudioGain(audio), output = applyAudioGain(audio, gain);
  assert.equal(gain, 8);
  assert.equal(output.length, audio.length);
  assert.deepEqual(audio, original);
  for (let i = 0; i < audio.length; i++) assert.equal(output[i], Math.fround(audio[i] * gain));
});

test('isolated peaks bound the gain even if average level is low', () => {
  const audio = new Float32Array(16000).fill(0.001);
  audio[8000] = -0.8;
  const gain = quietAudioGain(audio);
  assert(gain > 1 && gain < 1.2);
  assert(Math.abs(applyAudioGain(audio, gain)[8000]) <= 0.950001);
  audio[8000] = 1;
  assert.equal(quietAudioGain(audio), 1);
});

test('invalid numeric data is rejected before native inference', () => {
  assert.throws(() => quietAudioGain(new Float32Array([NaN])), /Invalid PCM/);
  for (const gain of [NaN, Infinity, 0, 9]) assert.throws(() => applyAudioGain(new Float32Array(2), gain));
});
