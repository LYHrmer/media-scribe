import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  timestampToDate,
  dateToTimestamp,
} from '../src/lib/codec-time.js';

test('base64 round-trips unicode text', () => {
  const text = '你好，世界 👋 café';
  assert.equal(base64Decode(base64Encode(text)), text);
});

test('base64 handles inputs larger than one chunk', () => {
  const text = '数据'.repeat(20000);
  assert.equal(base64Decode(base64Encode(text)), text);
});

test('base64Decode rejects invalid input with a Chinese message', () => {
  assert.throws(() => base64Decode('!!!不是base64!!!'), /Base64 内容无效/);
});

test('base64Decode tolerates whitespace in the input', () => {
  const encoded = base64Encode('多行\n内容');
  const wrapped = `${encoded.slice(0, 4)}\n${encoded.slice(4)}`;
  assert.equal(base64Decode(wrapped), '多行\n内容');
});

test('url-safe base64 encodes without + / = and decodes both alphabets', () => {
  const standard = base64Encode('>>>???');
  assert.ok(standard.includes('+') || standard.includes('/'));
  const safe = base64Encode('>>>???', { urlSafe: true });
  assert.ok(!/[+/=]/.test(safe));
  assert.equal(base64Decode(safe), '>>>???');
  assert.equal(base64Decode(standard), '>>>???');
  // padding is restored for url-safe input that drops it
  assert.equal(base64Decode(base64Encode('a', { urlSafe: true })), 'a');
  assert.equal(base64Encode('a', { urlSafe: true }), 'YQ');
});

test('url round-trips Chinese and reserved characters', () => {
  const text = '中文 &a=b?c=d';
  assert.equal(urlDecode(urlEncode(text)), text);
});

test('urlDecode rejects malformed percent sequences', () => {
  assert.throws(() => urlDecode('%zz'), /URL 编码内容无效/);
});

test('timestamp auto-detects seconds vs milliseconds', () => {
  const viaSeconds = timestampToDate(1700000000);
  const viaMillis = timestampToDate(1700000000000);
  assert.equal(viaSeconds.text, viaMillis.text);
});

test('timestamp ↔ date round-trips regardless of timezone', () => {
  const original = '2026-10-14 12:34:56';
  const { seconds } = dateToTimestamp(original);
  assert.equal(timestampToDate(seconds).text, original);
});

test('dateToTimestamp accepts T separator and omitted time', () => {
  const withT = dateToTimestamp('2026-10-14T12:00:00');
  const withSpace = dateToTimestamp('2026-10-14 12:00:00');
  assert.equal(withT.seconds, withSpace.seconds);
  const dateOnly = dateToTimestamp('2026-10-14');
  assert.equal(timestampToDate(dateOnly.seconds).text, '2026-10-14 00:00:00');
});

test('rejects garbage input with Chinese messages', () => {
  assert.throws(() => timestampToDate('abc'), /时间戳必须是数字/);
  assert.throws(() => dateToTimestamp('2026年10月14日'), /日期格式应为/);
});
