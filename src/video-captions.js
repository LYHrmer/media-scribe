// Scores below are OCR model scores and agreement, not probabilities that the
// spoken words are correct. No dictionary, lyric, or expected transcript is used.
const CONTENT = /[\p{L}\p{M}\p{N}]/u;
const HAN = /\p{Script=Han}/u;
const clamp = (value) => Number.isFinite(Number(value)) ? Math.min(1, Math.max(0, Number(value))) : 0;
const letters = (text) => Array.from(String(text).normalize('NFKC')).filter((char) => CONTENT.test(char));

export function ensureSentencePunctuation(value) {
  return String(value ?? '').split(/\r?\n/u).map((line) => {
    const text = line.trim();
    if (!text || /[.,!?;:，。！？；：…][\s"'”’」』）》）\]]*$/u.test(text)) return text;
    const mark = HAN.test(text) ? '。' : '.';
    return /["'”’」』）》）\]]$/u.test(text)
      ? text.replace(/(["'”’」』）》）\]]+)$/u, `${mark}$1`) : `${text}${mark}`;
  }).join('\n');
}

function bounds(box, frame) {
  let points;
  if (Array.isArray(box) && Array.isArray(box[0])) points = box;
  else if (Array.isArray(box) && box.length === 4) points = [[box[0], box[1]], [box[2], box[3]]];
  else if (box && typeof box === 'object') points = [[box.x, box.y], [box.x + box.width, box.y + box.height]];
  if (!points?.length || points.some((point) => !point.every(Number.isFinite))) return null;
  const scaleX = Number(frame.width) > 0 ? frame.width : 1;
  const scaleY = Number(frame.height) > 0 ? frame.height : 1;
  const xs = points.map((point) => point[0] / scaleX);
  const ys = points.map((point) => point[1] / scaleY);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return { left, right, top, bottom, width: right - left, height: bottom - top,
    x: (left + right) / 2, y: (top + bottom) / 2 };
}

function samePosition(a, b) {
  if (!a || !b) return true;
  return Math.abs(a.x - b.x) <= Math.max(a.width, b.width, 1e-6) * 2.5
    && Math.abs(a.y - b.y) <= Math.max(a.height, b.height, 1e-6) * 2.5;
}

function sameRectangle(a, b) {
  if (!a || !b) return false;
  const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 && intersection / union >= 0.65;
}

function persistentReadings(observations, frameCount, options) {
  const groups = [];
  for (const item of observations) {
    if (!item.box) continue;
    const key = item.chars.join('');
    let group = groups.find((candidate) => candidate.key === key
      && Math.abs(item.box.x - candidate.box.x) <= Math.max(candidate.box.width, 1e-6) * 0.25
      && Math.abs(item.box.y - candidate.box.y) <= Math.max(candidate.box.height, 1e-6) * 0.25);
    if (!group) {
      group = { key, box: item.box, items: [], frames: new Set(), start: item.time, end: item.time };
      groups.push(group);
    }
    group.items.push(item); group.frames.add(item.frameKey);
    group.start = Math.min(group.start, item.time); group.end = Math.max(group.end, item.time);
  }
  // Sparse sampling deliberately creates separate short tracks. Screen logos
  // must still be assessed across the full sampling schedule, not per pair.
  return groups.filter((group) => group.frames.size >= 3
    && group.frames.size / Math.max(1, frameCount) >= 0.8
    && (Math.min(options.duration, group.end + options.sampleInterval) - group.start) / options.duration >= 0.8);
}

// Alignment is also used for voting; a gap represents missing visual evidence.
function align(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
      rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
  }
  const pairs = [];
  let i = a.length, j = b.length;
  while (i || j) {
    if (i && j && rows[i][j] === rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1])) {
      pairs.push([--i, --j]);
    } else if (i && rows[i][j] === rows[i - 1][j] + 1) pairs.push([--i, null]);
    else pairs.push([null, --j]);
  }
  return { distance: rows[a.length][b.length], pairs: pairs.reverse() };
}

function similarity(a, b) {
  return 1 - align(a, b).distance / Math.max(a.length, b.length, 1);
}

function observation(frame, item) {
  const raw = String(item?.text ?? '').trim().slice(0, 320);
  const chars = letters(raw);
  if (!chars.length) return null;
  const confidence = clamp(item.confidence ?? item.mean_model_score);
  const evidence = (Array.isArray(item.characters) ? item.characters : []).flatMap((entry) => {
    const text = entry.character ?? entry.text ?? '';
    return letters(text).map((char) => ({ char, score: clamp(entry.confidence ?? entry.model_score) }));
  });
  // Per-character scores are used only when they align with the actual string.
  const scores = evidence.map((entry) => entry.char).join('') === chars.join('')
    ? evidence.map((entry) => entry.score) : chars.map(() => confidence);
  return { raw, chars, scores, confidence, time: Number(frame.time),
    frameKey: Number(frame.time).toFixed(6), box: bounds(item.box, frame), source: item.source ?? 'ocr' };
}

function punctuation(raw) {
  const after = [''];
  let index = 0;
  for (const char of Array.from(raw)) {
    if (CONTENT.test(char)) {
      for (let n = letters(char).length; n > 0; n -= 1) after[++index] = '';
    }
    else after[index] += char;
  }
  return after;
}

function vote(entries, fallback = '') {
  const byFrame = new Map();
  for (const entry of entries) {
    if (!entry.char) continue;
    const frame = byFrame.get(entry.frameKey) ?? new Map();
    frame.set(entry.char, Math.max(frame.get(entry.char) ?? 0, entry.score));
    byFrame.set(entry.frameKey, frame);
  }
  const totals = new Map();
  for (const frame of byFrame.values()) {
    // Several models/colour variants from one frame are correlated evidence.
    const divisor = Math.max(1, [...frame.values()].reduce((sum, value) => sum + value, 0));
    for (const [char, score] of frame) {
      const total = totals.get(char) ?? { character: char, weight: 0, support: 0, confidence: 0 };
      total.weight += score / divisor;
      total.support += Number(score >= 0.55);
      total.confidence = Math.max(total.confidence, score);
      totals.set(char, total);
    }
  }
  const alternatives = [...totals.values()].sort((a, b) => b.weight - a.weight
    || Number(b.character === fallback) - Number(a.character === fallback));
  const best = alternatives[0];
  const sum = alternatives.reduce((total, item) => total + item.weight, 0);
  return { best, alternatives, agreement: sum ? best.weight / sum : 0 };
}

function fuseTrack(track, options) {
  const byFrame = new Map();
  for (const item of track.items) {
    const group = byFrame.get(item.frameKey) ?? [];
    group.push(item); byFrame.set(item.frameKey, group);
  }
  const frameGroups = [...byFrame.values()];
  let anchor = track.items[0], bestMedoid = -Infinity;
  for (const item of track.items) {
    const score = frameGroups.reduce((total, group) => total
      + Math.max(...group.map((other) => similarity(item.chars, other.chars) * other.confidence)), 0)
      + item.confidence * 0.1;
    if (score > bestMedoid) { bestMedoid = score; anchor = item; }
  }
  const columns = anchor.chars.map(() => []);
  const insertions = Array.from({ length: anchor.chars.length + 1 }, () => new Map());
  for (const item of track.items) {
    let cursor = 0, rank = 0;
    for (const [a, b] of align(anchor.chars, item.chars).pairs) {
      if (a !== null) { cursor = a + 1; rank = 0; }
      if (b === null) continue;
      const entry = { char: item.chars[b], score: item.scores[b], frameKey: item.frameKey };
      if (a !== null) columns[a].push(entry);
      else {
        const entries = insertions[cursor].get(rank) ?? [];
        entries.push(entry); insertions[cursor].set(rank++, entries);
      }
    }
  }
  const marks = punctuation(anchor.raw);
  const uncertainCharacters = [];
  const uncertainInsertions = [];
  const agreements = [];
  let text = marks[0] ?? '';
  const add = (entries, fallback, insertion = false) => {
    const choice = vote(entries, fallback);
    if (!choice.best) return;
    const best = choice.best;
    // A lone inserted glyph is retained only as a review candidate, with its
    // exact competing visual readings. No language rule supplies missing words.
    const safe = best.confidence >= 0.55 && choice.agreement >= 0.65
      && best.support >= options.minSupport;
    if (!safe) {
      const uncertainty = { character: best.character, confidence: best.confidence,
        alternatives: choice.alternatives.map(({ character, confidence, support }) => ({ character, confidence, support })) };
      if (insertion) uncertainInsertions.push({ ...uncertainty,
        contentBoundary: letters(text).length, isInsertion: true });
      else uncertainCharacters.push({ ...uncertainty, index: Array.from(text).length, isInsertion: false });
    }
    // An unconfirmed insertion is evidence of an unreadable/missing glyph,
    // not permission to splice every single-frame hallucination into the text.
    if (!insertion || safe) text += best.character;
    agreements.push(choice.agreement);
  };
  for (let index = 0; index <= anchor.chars.length; index += 1) {
    for (const entries of insertions[index].values()) add(entries, '', true);
    if (index < anchor.chars.length) { add(columns[index], anchor.chars[index]); text += marks[index + 1] ?? ''; }
  }
  const rawChars = Array.from(text);
  const finalText = ensureSentencePunctuation(text);
  const finalChars = Array.from(finalText);
  const outputPositions = finalChars.flatMap((char, index) => CONTENT.test(char) ? [index] : []);
  const inputPositions = new Map();
  let contentIndex = 0;
  for (let index = 0; index < rawChars.length; index += 1) if (CONTENT.test(rawChars[index])) {
    inputPositions.set(index, outputPositions[contentIndex++]);
  }
  for (const item of uncertainCharacters) item.index = inputPositions.get(item.index);
  for (const item of uncertainInsertions) item.boundary = item.contentBoundary
    ? outputPositions[item.contentBoundary - 1] + 1 : outputPositions[0] ?? 0;
  const support = frameGroups.length;
  const meanScore = frameGroups.reduce((sum, group) => sum + Math.max(...group.map((item) => item.confidence)), 0) / support;
  const agreement = agreements.reduce((sum, value) => sum + value, 0) / Math.max(1, agreements.length);
  const confidence = meanScore * agreement;
  const start = Math.min(...track.items.map((item) => item.time));
  const end = Math.min(options.duration, Math.max(...track.items.map((item) => item.time)) + options.sampleInterval);
  const rawAlternatives = new Map();
  for (const item of track.items) {
    const existing = rawAlternatives.get(item.raw) ?? { text: item.raw, confidence: 0, frames: new Set(), sources: new Set() };
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.frames.add(item.frameKey); existing.sources.add(item.source); rawAlternatives.set(item.raw, existing);
  }
  const alternatives = [...rawAlternatives.values()].map(({ text, confidence, frames, sources }) => ({
    text, confidence, support: frames.size, sources: [...sources],
  })).sort((a, b) => b.confidence - a.confidence);
  const warnings = [];
  if (uncertainCharacters.length || uncertainInsertions.length) warnings.push('部分字形的分数低或多帧读数不一致，请核对备选文字。');
  if (support === 1) warnings.push('只在一个采样画面中读到这段文字。');
  const reliable = !uncertainCharacters.length && !uncertainInsertions.length
    && confidence >= options.minConfidence
    && support >= options.minSupport;
  return { start, end, text: finalText, confidence, support,
    source: 'video_ocr', timeSource: 'video_frames', scoreKind: 'ocr_model_agreement', reliable,
    observedText: anchor.raw,
    alternatives, uncertainCharacters, uncertainInsertions,
    uncertaintyText: 'text', uncertaintyIndexUnit: 'codepoint', warnings,
    reason: reliable ? null : 'needs_review' };
}

/** Fuse screen text only. A reliable screen reading does not verify the audio. */
export function fuseVideoCaptions(frames, settings = {}) {
  const input = (Array.isArray(frames) ? frames : []).filter((frame) => Number.isFinite(Number(frame?.time)) && Number(frame.time) >= 0)
    .slice().sort((a, b) => Number(a.time) - Number(b.time));
  const sampleInterval = Number(settings.sampleInterval) > 0 ? Number(settings.sampleInterval) : 0.5;
  const duration = Number(settings.duration) > 0 ? Number(settings.duration)
    : (input.length ? Number(input.at(-1).time) + sampleInterval : 0);
  const options = { sampleInterval, duration, minConfidence: clamp(settings.minConfidence ?? 0.65),
    minSupport: Math.max(2, Math.floor(Number(settings.minSupport) || 2)),
    maxGapSeconds: Number(settings.maxGapSeconds) > 0 ? Number(settings.maxGapSeconds) : Math.max(3, sampleInterval * 1.5) };
  const tracks = [];
  const observations = [];
  for (const frame of input) for (const item of Array.isArray(frame.texts) ? frame.texts : []) {
    const current = observation(frame, item);
    if (!current || current.confidence < 0.35 || current.time >= duration) continue;
    observations.push(current);
    let chosen = null, best = -Infinity;
    for (const track of tracks) {
      const last = track.items.at(-1);
      if (current.time - last.time > options.maxGapSeconds || !samePosition(current.box, last.box)) continue;
      const sharedFrameRegion = track.items.some((other) => other.frameKey === current.frameKey
        && sameRectangle(current.box, other.box));
      const score = sharedFrameRegion ? 1.1
        : Math.max(...track.items.slice(-8).map((other) => similarity(current.chars, other.chars)));
      const threshold = Math.min(current.chars.length, last.chars.length) <= 4 ? 0.8 : 0.58;
      if (score >= threshold && score > best) { chosen = track; best = score; }
    }
    if (chosen) chosen.items.push(current);
    else tracks.push({ items: [current] });
  }
  const frameCount = new Set(input.filter((frame) => Number(frame.time) < duration).map((frame) => Number(frame.time).toFixed(6))).size;
  const persistent = persistentReadings(observations, frameCount, options);
  const persistentCandidates = new Map();
  const segments = [], candidates = [];
  for (const track of tracks) {
    const result = fuseTrack(track, options);
    if (!(result.end > result.start)) continue;
    if (result.support === 1 && Math.max(...track.items.map((item) => item.confidence)) < options.minConfidence) continue;
    const stationary = persistent.find((group) => group.key === letters(result.text).join('')
      && track.items.some((item) => group.items.includes(item)));
    if (stationary) {
      result.reliable = false; result.reason = 'static_text';
      const warning = '文字在全片大多数采样画面中固定出现，可能是标识或常驻文字，请确认。';
      if (!result.warnings.includes(warning)) result.warnings.push(warning);
      const existing = persistentCandidates.get(stationary);
      if (existing) {
        existing.start = Math.min(existing.start, result.start); existing.end = Math.max(existing.end, result.end);
        existing.confidence = Math.max(existing.confidence, result.confidence);
        continue;
      }
      result.support = stationary.frames.size;
      persistentCandidates.set(stationary, result);
    }
    if (!result.reliable) candidates.push(result);
    else {
      const duplicate = segments.find((segment) => letters(segment.text).join('') === letters(result.text).join('')
        && result.start <= segment.end && segment.start <= result.end);
      if (duplicate) {
        duplicate.start = Math.min(duplicate.start, result.start); duplicate.end = Math.max(duplicate.end, result.end);
        duplicate.confidence = Math.max(duplicate.confidence, result.confidence);
      } else segments.push(result);
    }
  }
  segments.sort((a, b) => a.start - b.start);
  candidates.sort((a, b) => a.start - b.start);
  return { reliable: segments.length > 0, segments, candidates,
    warnings: candidates.length ? ['还有画面文字需要核对，未自动混入已确认的字幕。'] : [] };
}
