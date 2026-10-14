// Validate model-predicted text boundaries for the pinned Whisper decoder.
// Timestamps are not proof of actual acoustic boundaries; ambiguous cases retain the original merge.
export function nonoverlapGuard({ output, next, timestampBegin, specialIds, precision,
  returnTimestamps, pendingTokens = false, skip = false }) {
  const reject = reason => ({ accepted: false, reason });
  if (returnTimestamps !== true) return reject('not-boolean-timestamps');
  if (pendingTokens || skip) return reject('previous-window-state-unresolved');
  if (!next || !Array.isArray(output?.stride) || !Array.isArray(next?.stride)
    || output.stride.length !== 3 || next.stride.length !== 3) return reject('window-metadata-missing');
  if ((!Array.isArray(output.tokens) && !ArrayBuffer.isView(output.tokens))
    || !Number.isSafeInteger(timestampBegin) || timestampBegin < 0 || typeof specialIds?.has !== 'function') return reject('invalid-token-metadata');
  if (![...output.stride, ...next.stride, precision].every(Number.isFinite) || precision <= 0) return reject('invalid-window-metadata');
  const [length, left, right] = output.stride;
  const [nextLength, nextLeft, nextRight] = next.stride;
  if (length <= 0 || nextLength <= 0 || left < 0 || right <= 0 || nextLeft < 0 || nextRight < 0
    || left + right >= length || nextLeft + nextRight >= nextLength) return reject('invalid-window-strides');
  // Original pipeline offsets advance by length-right-nextLeft. Do not change
  // any stride values or time_offset; this is the next physical audio origin.
  const nextStart = length - right - nextLeft;
  if (nextStart <= 0) return reject('nonforward-window');
  let lastTimestamp = -Infinity, start = null, hasText = false, completed = 0, finalEnd = null;
  for (const raw of output.tokens) {
    const token = Number(raw);
    if (!Number.isSafeInteger(token) || token < 0) return reject('invalid-token');
    if (specialIds.has(token)) continue;
    if (token >= timestampBegin && token <= timestampBegin + 1500) {
      const time = (token - timestampBegin) * precision;
      if (time < lastTimestamp || time < 0 || time > length + 1e-9) return reject('invalid-or-nonmonotone-timestamp');
      lastTimestamp = time;
      if (hasText) {
        if (start === null || time <= start) return reject('unclosed-or-zero-length-text');
        completed++; finalEnd = time; hasText = false; start = null;
      } else {
        start = time;
      }
    } else {
      if (token >= timestampBegin || start === null) return reject('text-without-valid-start');
      hasText = true;
    }
  }
  if (hasText || !completed || finalEnd === null) return reject('unclosed-or-missing-final-text');
  // Keep a full timestamp quantum of margin; equality stays on original path.
  // A trailing empty timestamp also must precede the same physical boundary.
  if (lastTimestamp + precision > nextStart + 1e-9) return reject('timestamps-reach-physical-overlap');
  return { accepted: true, finalTextEnd: finalEnd, lastTimestamp, nextPhysicalStart: nextStart,
    separationSeconds: nextStart - lastTimestamp, completedSegments: completed };
}

