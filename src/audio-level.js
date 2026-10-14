// A bounded, linear level adjustment for SenseVoice's fixed acoustic frontend.
// This does not improve signal-to-noise ratio. Speech detection and window
// selection must see the original PCM; never turn a quiet/no-speech decision
// into speech by amplifying it. Ordinary-level recordings stay byte-identical.
export function quietAudioGain(audio) {
  if (!(audio instanceof Float32Array) || !audio.length) return 1;
  let power = 0, peak = 0;
  for (const sample of audio) {
    if (!Number.isFinite(sample)) throw new TypeError('Invalid PCM');
    power += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(power / audio.length);
  if (rms <= 1e-5 || rms >= 0.01) return 1;
  return Math.max(1, Math.min(8, 0.04 / rms, 0.95 / peak));
}

// Copy at most one bounded inference window, not another entire long recording.
export function applyAudioGain(audio, gain) {
  if (!Number.isFinite(gain) || gain < 1 || gain > 8) throw new RangeError('Invalid audio gain');
  return gain === 1 ? audio : audio.map(sample => sample * gain);
}
