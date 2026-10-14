// Base64 / URL / Unix-timestamp helpers for the codec tool page.
// Base64 goes through TextEncoder/TextDecoder so non-ASCII text survives;
// String.fromCharCode is chunked because spreading a large byte array
// overflows the call stack.

const BASE64_CHUNK = 0x8000;

export function base64Encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64Decode(encoded) {
  let binary;
  try {
    binary = atob(String(encoded).replace(/\s+/g, ''));
  } catch {
    throw new Error('Base64 内容无效，无法解码');
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function urlEncode(text) {
  return encodeURIComponent(String(text));
}

export function urlDecode(text) {
  try {
    return decodeURIComponent(String(text));
  } catch {
    throw new Error('URL 编码内容无效，无法解码');
  }
}

// Seconds-based timestamps stay below 1e11 until the year 5138, so anything
// at or above that magnitude is treated as milliseconds.
const MILLIS_THRESHOLD = 1e11;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function timestampToDate(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) throw new Error('时间戳必须是数字');
  const milliseconds = Math.abs(value) >= MILLIS_THRESHOLD ? Math.trunc(value) : Math.trunc(value) * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error('时间戳超出可表示范围');
  return { milliseconds, text: formatLocal(date) };
}

export function dateToTimestamp(input) {
  const normalized = String(input).trim().replace('T', ' ');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(normalized);
  if (!m) throw new Error('日期格式应为 YYYY-MM-DD HH:mm:ss（时间部分可省略）');
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = m;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (Number.isNaN(date.getTime())) throw new Error('日期无效');
  return { seconds: Math.floor(date.getTime() / 1000), milliseconds: date.getTime() };
}
