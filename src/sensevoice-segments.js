// Bound encoder memory on long media, preserving every input sample exactly
// once. A nearby quiet boundary is preferable to cutting a word at 30 seconds.
export function splitSenseRanges(audio, ranges, sampleRate = 16000) {
  const maximum = Math.round(30 * sampleRate), window = Math.round(0.04 * sampleRate);
  const result = [];
  for (const range of ranges) {
    let start = range.start;
    while (range.end - start > maximum) {
      const latest = start + maximum;
      let end = latest, quietest = Infinity;
      for (let position = latest - 4 * sampleRate; position <= latest - window; position += window) {
        let power = 0;
        for (let i = position; i < position + window; i++) power += audio[i] * audio[i];
        // Prefer later positions for equally quiet windows; no sample is dropped.
        if (power <= quietest) { quietest = power; end = position + Math.floor(window / 2); }
      }
      result.push({ start, end }); start = end;
    }
    if (range.end > start) result.push({ start, end: range.end });
  }
  return result;
}

export function normalizeSensePunctuation(result) {
  const rawText = String(result.text || '');
  // SenseVoice can emit a comma immediately before its sentence stop. Remove
  // only that adjacent comma run; retain question/exclamation marks, ellipses,
  // quotes and whitespace. The worker keeps the untouched model text as rawText.
  const text = rawText.replace(/，+(?=。)/gu, '').replace(/。{2,}/gu, '。');
  if (text === rawText) return result;
  if (!Array.isArray(result.tokens) || !Array.isArray(result.timestamps)
    || result.tokens.length !== result.timestamps.length || result.tokens.some(token => typeof token !== 'string')
    || result.tokens.join('').trim() !== rawText.trim()) return { ...result, text };
  const joined = result.tokens.join('');
  const removedOffsets = new Set();
  for (const match of joined.matchAll(/，+(?=。)/gu)) {
    for (let index = match.index; index < match.index + match[0].length; index++) removedOffsets.add(index);
  }
  const tokens = [], timestamps = [];
  let previous = '', sourceOffset = 0;
  for (let i = 0; i < result.tokens.length; i++) {
    let token = '';
    for (const char of result.tokens[i]) {
      const removed = removedOffsets.has(sourceOffset);
      sourceOffset += char.length;
      if (removed) continue;
      if (char !== '。' || previous !== '。') token += char;
      previous = char;
    }
    if (token) { tokens.push(token); timestamps.push(result.timestamps[i]); }
  }
  return { ...result, text, tokens, timestamps };
}

export function senseResultSegments(result, duration, offset = 0) {
  const text = String(result.text || '').trim();
  if (!text || duration < 0.001) return { segments: [], approximate: false };
  const { tokens, timestamps } = result;
  const fallback = () => ({ segments: [{ start: offset, end: offset + duration, text }], approximate: true });
  if (!Array.isArray(tokens) || !Array.isArray(timestamps) || !tokens.length || tokens.length !== timestamps.length
    || tokens.some(t => typeof t !== 'string') || tokens.join('').trim() !== text
    || timestamps.some((t, i) => !Number.isFinite(t) || t < 0 || t >= duration || (i && t < timestamps[i - 1]))) return fallback();
  const segments = [];
  let first = 0;
  let previousToken = '';
  for (let i = 0; i < tokens.length; i++) {
    // A decimal point may be its own CTC token or follow digits in one token.
    // Inspect adjacent characters, without changing any recognized characters.
    const before = tokens[i].length > 1 ? tokens[i].at(-2) : previousToken.at(-1);
    const decimalPoint = tokens[i].endsWith('.') && /\p{N}/u.test(before || '')
      && /^\p{N}/u.test(tokens[i + 1] || '');
    const boundary = (/[。！？.!?]$/u.test(tokens[i]) && !decimalPoint) || i === tokens.length - 1
      || (i - first >= 50 && /[，,；;]/u.test(tokens[i])) || timestamps[i + 1] - timestamps[i] > 1.2;
    if (tokens[i]) previousToken = tokens[i];
    if (!boundary) continue;
    const part = tokens.slice(first, i + 1).join('').trim();
    const start = timestamps[first], end = Math.min(duration, timestamps[i + 1] ?? (timestamps[i] + 0.18));
    if (part) {
      if (Math.round(end * 1000) <= Math.round(start * 1000)) return fallback();
      // Late punctuation tokens belong to the preceding caption. They are not
      // a separate spoken sentence and must not create a punctuation-only cue.
      if (/^[\p{P}\s]+$/u.test(part) && segments.length) segments.at(-1).text += part;
      else segments.push({ start: offset + start, end: offset + end, text: part });
    }
    first = i + 1;
  }
  return segments.length ? { segments, approximate: false } : fallback();
}
