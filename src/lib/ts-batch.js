// Line-oriented batch conversion for the ts-batch tool page. Each line is
// auto-detected: pure digits go timestamp → date, anything else is tried as a
// local date string. Unrecognized lines are kept verbatim with a marker so
// the output stays aligned with the input, line for line.
import { timestampToDate, dateToTimestamp } from './codec-time.js';

const NUMERIC = /^[+-]?\d+$/;
export const UNKNOWN_MARK = '无法识别';

export function convertLine(line) {
  const value = String(line).trim();
  if (!value) return '';
  if (NUMERIC.test(value)) {
    try {
      return `${value} → ${timestampToDate(value).text}`;
    } catch {
      return `${value} → ${UNKNOWN_MARK}`;
    }
  }
  try {
    const { seconds, milliseconds } = dateToTimestamp(value);
    return `${value} → ${seconds} 秒 · ${milliseconds} 毫秒`;
  } catch {
    return `${value} → ${UNKNOWN_MARK}`;
  }
}

export function convertLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map(convertLine).join('\n');
}
