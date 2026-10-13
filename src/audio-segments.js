// Conservative near-silence segmentation, not speech activity detection.
// Preserve music, breath and very quiet voices unless both thresholds agree
// that an entire 20 ms frame is almost silent.
const FRAME_SECONDS = 0.02;
const MIN_QUIET_SECONDS = 1.5;
const CONTEXT_SECONDS = 0.3;
const QUIET_RMS = 1e-5;
const QUIET_PEAK = 1e-4;

/** Return half-open ranges in absolute input sample indices. */
export function findAudioRanges(audio, sampleRate = 16000) {
  if (!(audio instanceof Float32Array)) throw new TypeError('Expected Float32Array PCM');
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid sample rate');
  const frameSamples = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const minQuietSamples = Math.ceil(sampleRate * MIN_QUIET_SECONDS);
  const contextSamples = Math.round(sampleRate * CONTEXT_SECONDS);
  const ranges = [];
  let rangeStart;
  let lastActiveEnd = 0;

  for (let start = 0; start < audio.length; start += frameSamples) {
    const end = Math.min(audio.length, start + frameSamples);
    let squared = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = audio[index];
      squared += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(squared / (end - start));
    const nearSilent = rms <= QUIET_RMS && peak <= QUIET_PEAK;
    if (nearSilent) continue;

    if (rangeStart === undefined) {
      // Short quiet starts remain intact. Only long quiet spans are trimmed.
      rangeStart = start >= minQuietSamples ? Math.max(0, start - contextSamples) : 0;
    } else if (start - lastActiveEnd >= minQuietSamples) {
      ranges.push({ start: rangeStart, end: Math.min(audio.length, lastActiveEnd + contextSamples) });
      rangeStart = Math.max(0, start - contextSamples);
    }
    lastActiveEnd = end;
  }
  if (rangeStart !== undefined) {
    const end = audio.length - lastActiveEnd >= minQuietSamples
      ? Math.min(audio.length, lastActiveEnd + contextSamples) : audio.length;
    ranges.push({ start: rangeStart, end });
  }
  return ranges;
}
