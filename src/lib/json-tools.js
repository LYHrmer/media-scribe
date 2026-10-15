// JSON formatting/validation helpers for the JSON tool page.
// Error locations come from JSON.parse messages, which differ per engine:
// V8 reports "at position N" (recent versions append "(line X column Y)"),
// Firefox "at line X column Y of the JSON data", Safari varies. Extract what
// we can and always fall back to the raw message.

function codepointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(codepointCompare).map(key => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

export function locateJsonError(text, message) {
  const byLine = /line (\d+) column (\d+)/i.exec(message);
  if (byLine) return { line: Number(byLine[1]), column: Number(byLine[2]) };
  const byPosition = /position (\d+)/i.exec(message);
  if (byPosition) {
    const position = Number(byPosition[1]);
    const before = String(text).slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    return { line, column };
  }
  return {};
}

function parseOrReport(text) {
  // A leading BOM (Windows Notepad's UTF-8 default) breaks JSON.parse with a
  // confusing message; strip it before parsing so error positions still
  // refer to the string the user sees.
  const clean = String(text).replace(/^﻿/, '');
  try {
    return { ok: true, value: JSON.parse(clean) };
  } catch (error) {
    return { ok: false, message: error.message, ...locateJsonError(clean, error.message) };
  }
}

export function formatJson(text, { indent = 2, sortKeys = false, minify = false } = {}) {
  const parsed = parseOrReport(String(text));
  if (!parsed.ok) return parsed;
  const value = sortKeys ? sortKeysDeep(parsed.value) : parsed.value;
  return { ok: true, result: minify ? JSON.stringify(value) : JSON.stringify(value, null, indent) };
}

export function validateJson(text) {
  const parsed = parseOrReport(String(text));
  return parsed.ok ? { ok: true } : parsed;
}
