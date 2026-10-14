function requireText(text) {
  if (typeof text !== 'string') throw new TypeError('导出的内容必须是文本。');
  return text.replace(/\r\n?/g, '\n');
}

export function renderTxt(text) {
  return `${requireText(text).trim()}\n`;
}

function validateSegments(segments) {
  if (!Array.isArray(segments)) throw new TypeError('缺少字幕时间段。');
  let lastStart = -1;
  return segments.map((segment, index) => {
    if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.start < lastStart) {
      throw new RangeError(`第 ${index + 1} 条字幕的时间无效。`);
    }
    // A nonzero interval must remain nonzero after rounding to milliseconds.
    if (Math.round(segment.end * 1000) <= Math.round(segment.start * 1000)) {
      throw new RangeError(`第 ${index + 1} 条字幕的时间过短。`);
    }
    lastStart = segment.start;
    return { start: segment.start, end: segment.end, text: requireText(segment.text).trim() };
  }).filter(segment => segment.text);
}

function timestamp(seconds, delimiter) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds % 3600000 / 60000);
  const secs = Math.floor(milliseconds % 60000 / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${delimiter}${String(ms).padStart(3, '0')}`;
}

function escapeSubtitleText(text) {
  // Whisper/user text is literal speech, never intentional subtitle markup.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n\s*\n/g, '\n');
}

export function renderSrt(segments) {
  return validateSegments(segments).map((segment, index) =>
    `${index + 1}\n${timestamp(segment.start, ',')} --> ${timestamp(segment.end, ',')}\n${escapeSubtitleText(segment.text)}\n`
  ).join('\n');
}

export function renderVtt(segments) {
  return `WEBVTT\n\n${validateSegments(segments).map(segment =>
    `${timestamp(segment.start, '.')} --> ${timestamp(segment.end, '.')}\n${escapeSubtitleText(segment.text)}\n`
  ).join('\n')}`;
}

export function renderJson(result) {
  if (!result || !Number.isFinite(result.duration) || result.duration < 0) {
    throw new TypeError('转写结果的时长无效。');
  }
  const segments = validateSegments(result.segments || []);
  if (segments.some(segment => segment.end > result.duration + 0.001)) {
    throw new RangeError('字幕时间超出了音频时长。');
  }
  const metadata = {};
  if (['audio', 'video_ocr'].includes(result.source)) metadata.source = result.source;
  if (typeof result.rawText === 'string') metadata.rawText = result.rawText;
  if (result.timing === 'approximate') metadata.timing = 'approximate';
  if (result.speechCheck?.deferred === true) metadata.speechCheck = { deferred: true };
  else if (result.speechCheck?.forced === true) metadata.speechCheck = { forced: true };
  if (Array.isArray(result.warnings)) metadata.warnings = result.warnings.filter(value => typeof value === 'string');
  return `${JSON.stringify({ text: requireText(result.text), duration: result.duration, segments, ...metadata }, null, 2)}\n`;
}

export function downloadText(text, filename, mime = 'text/plain') {
  requireText(text);
  if (typeof filename !== 'string' || !filename.trim()) throw new TypeError('文件名不能为空。');
  const safeFilename = filename.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Do not revoke synchronously: Safari needs the URL after click dispatch.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
