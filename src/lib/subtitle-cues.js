// Subtitle parsing and manipulation for the subtitle toolbox page.
// Rendering reuses renderSrt/renderVtt from ../exports.js, whose validation
// was designed for transcription output (strictly increasing starts, cues
// must survive ms-rounding, empty text is dropped silently). Real subtitle
// files are messier, so sanitizeCues() repairs what it can and collects
// human-readable warnings before anything reaches those renderers.
import { renderSrt, renderVtt } from '../exports.js';

function parseTimestamp(raw) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(String(raw).trim());
  if (!m) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4].padEnd(3, '0'));
  if (seconds > 59 || (m[1] !== undefined && minutes > 59)) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

// exports.js escapes & < > on render, so input must undo exactly those three.
// &amp; runs last so "&amp;lt;" decodes to "&lt;" (literal), keeping
// parse → render round-trips stable.
function unescapeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function detectFormat(text) {
  return text.slice(0, 64).trimStart().startsWith('WEBVTT') ? 'vtt' : 'srt';
}

// One cue per blank-line-separated block. The timing line is the first line
// containing '-->'; anything before it (SRT index, VTT cue identifier) is
// ignored, and VTT cue settings after the end timestamp are dropped.
// Blocks without '-->' (WEBVTT header, NOTE comments) are skipped silently;
// blocks whose timing line cannot be parsed count as skipped.
function parseCueBlock(block) {
  const lines = block.split('\n');
  const timingIndex = lines.findIndex(line => line.includes('-->'));
  if (timingIndex === -1) return null;
  const [startRaw, restRaw] = lines[timingIndex].split('-->').map(part => part.trim());
  const endRaw = restRaw.split(/\s+/)[0];
  const start = parseTimestamp(startRaw);
  const end = parseTimestamp(endRaw);
  if (start === null || end === null) return { invalid: true };
  const text = lines.slice(timingIndex + 1).join('\n').trim();
  return { start, end, text: unescapeEntities(text) };
}

export function parseSubtitle(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const format = detectFormat(normalized);
  const cues = [];
  let skipped = 0;
  for (const block of normalized.split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const cue = parseCueBlock(block);
    if (cue === null) continue;
    if (cue.invalid) { skipped += 1; continue; }
    cues.push(cue);
  }
  return { format, cues, skipped };
}

// Repairs what real-world files throw at exports.js's invariants: sorts by
// start time, clamps negative starts, drops empty/untimed cues — each with a
// Chinese warning. Overlaps are kept but reported.
export function sanitizeCues(rawCues) {
  let droppedEmpty = 0;
  let droppedBadTime = 0;
  let clamped = 0;
  let wasUnsorted = false;
  const cues = [];
  rawCues.forEach((cue, index) => {
    let { start, end } = cue;
    const text = cue.text.trim();
    if (index > 0 && start < rawCues[index - 1].start) wasUnsorted = true;
    if (!text) { droppedEmpty += 1; return; }
    if (start < 0) {
      if (end <= 0) { droppedBadTime += 1; return; }
      start = 0;
      clamped += 1;
    }
    if (!(end > start)) { droppedBadTime += 1; return; }
    start = Math.round(start * 1000) / 1000;
    end = Math.round(end * 1000) / 1000;
    if (Math.round(end * 1000) - Math.round(start * 1000) < 1) { droppedBadTime += 1; return; }
    cues.push({ start, end, text });
  });
  cues.sort((a, b) => a.start - b.start);
  let overlaps = 0;
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].start < cues[i - 1].end) overlaps += 1;
  }
  const warnings = [];
  if (wasUnsorted) warnings.push('原文件时间乱序，已按开始时间重新排序');
  if (droppedEmpty) warnings.push(`丢弃了 ${droppedEmpty} 条无文字字幕`);
  if (droppedBadTime) warnings.push(`丢弃了 ${droppedBadTime} 条时间无效的字幕`);
  if (clamped) warnings.push(`${clamped} 条起点为负的字幕已改为从 0 开始`);
  if (overlaps) warnings.push(`有 ${overlaps} 条字幕与前一条时间重叠，已原样保留`);
  return { cues, warnings };
}

function renderByFormat(cues, format) {
  return format === 'vtt' ? renderVtt(cues) : renderSrt(cues);
}

function skippedWarning(skipped) {
  return skipped ? [`${skipped} 个字幕块无法解析，已跳过`] : [];
}

export function convertSubtitle(text) {
  const { format, cues, skipped } = parseSubtitle(text);
  const { cues: clean, warnings } = sanitizeCues(cues);
  if (clean.length === 0) throw new Error('没有解析出任何有效字幕，请检查文件内容');
  return {
    from: format,
    to: format === 'srt' ? 'vtt' : 'srt',
    text: renderByFormat(clean, format === 'srt' ? 'vtt' : 'srt'),
    count: clean.length,
    warnings: [...skippedWarning(skipped), ...warnings],
  };
}

export function shiftSubtitle(text, offsetMillis) {
  if (!Number.isFinite(offsetMillis) || offsetMillis === 0) {
    throw new Error('平移量必须是非零数字（毫秒，可为负）');
  }
  const { format, cues, skipped } = parseSubtitle(text);
  const offset = offsetMillis / 1000;
  const shifted = cues.map(cue => ({ start: cue.start + offset, end: cue.end + offset, text: cue.text }));
  const { cues: clean, warnings } = sanitizeCues(shifted);
  if (clean.length === 0) throw new Error('平移后没有剩余的有效字幕');
  return {
    format,
    text: renderByFormat(clean, format),
    count: clean.length,
    warnings: [...skippedWarning(skipped), ...warnings],
  };
}

export const MERGE_GAP_SECONDS = 1;

export function mergeSubtitles(textA, textB) {
  const a = parseSubtitle(textA);
  const b = parseSubtitle(textB);
  const cleanA = sanitizeCues(a.cues);
  const cleanB = sanitizeCues(b.cues);
  if (cleanA.cues.length === 0 || cleanB.cues.length === 0) {
    throw new Error('合并需要两段输入各自至少含有一条有效字幕');
  }
  const offset = cleanA.cues[cleanA.cues.length - 1].end + MERGE_GAP_SECONDS - cleanB.cues[0].start;
  const merged = [
    ...cleanA.cues,
    ...cleanB.cues.map(cue => ({ start: cue.start + offset, end: cue.end + offset, text: cue.text })),
  ];
  return {
    format: a.format,
    text: renderByFormat(merged, a.format),
    count: merged.length,
    warnings: [
      `第二段已整体平移 ${offset.toFixed(1)} 秒，接在第一段之后（间隔 ${MERGE_GAP_SECONDS} 秒）`,
      ...skippedWarning(a.skipped + b.skipped),
      ...cleanA.warnings,
      ...cleanB.warnings,
    ],
  };
}

export function splitSubtitle(text, atSeconds) {
  if (!Number.isFinite(atSeconds) || atSeconds <= 0) {
    throw new Error('切分点必须是大于 0 的秒数');
  }
  const { format, cues, skipped } = parseSubtitle(text);
  const { cues: clean, warnings } = sanitizeCues(cues);
  const first = clean.filter(cue => cue.start < atSeconds);
  const second = clean.filter(cue => cue.start >= atSeconds);
  if (first.length === 0 || second.length === 0) {
    throw new Error('切分点某一侧没有字幕，请调整切分时间');
  }
  return {
    format,
    part1: { text: renderByFormat(first, format), count: first.length },
    part2: { text: renderByFormat(second, format), count: second.length },
    warnings: [...skippedWarning(skipped), ...warnings],
  };
}
