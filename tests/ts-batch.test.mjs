import test from 'node:test';
import assert from 'node:assert/strict';
import { convertLine, convertLines, UNKNOWN_MARK } from '../src/lib/ts-batch.js';
import { dateToTimestamp } from '../src/lib/codec-time.js';

test('numeric lines convert timestamp → date (timezone-agnostic round-trip)', () => {
  const { seconds } = dateToTimestamp('2026-10-14 12:34:56');
  assert.equal(convertLine(String(seconds)), `${seconds} → 2026-10-14 12:34:56`);
  // milliseconds get the same treatment
  assert.equal(convertLine(`${seconds}000`), `${seconds}000 → 2026-10-14 12:34:56`);
});

test('date lines convert date → both timestamp units', () => {
  const { seconds, milliseconds } = dateToTimestamp('2026-10-14 12:34:56');
  assert.equal(convertLine('2026-10-14 12:34:56'), `2026-10-14 12:34:56 → ${seconds} 秒 · ${milliseconds} 毫秒`);
  assert.equal(seconds * 1000, milliseconds);
});

test('unrecognized lines are kept with a marker', () => {
  assert.equal(convertLine('abc'), `abc → ${UNKNOWN_MARK}`);
  assert.equal(convertLine('2026年10月14日'), `2026年10月14日 → ${UNKNOWN_MARK}`);
});

test('empty lines stay empty and order is preserved', () => {
  const { seconds } = dateToTimestamp('2026-10-14 12:34:56');
  const out = convertLines(`1760000000\n\n2026-10-14 12:34:56\nxyz`);
  const lines = out.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^1760000000 → \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(lines[1], '');
  assert.equal(lines[2], `2026-10-14 12:34:56 → ${seconds} 秒 · ${seconds}000 毫秒`);
  assert.equal(lines[3], `xyz → ${UNKNOWN_MARK}`);
});

test('CRLF input is normalized', () => {
  assert.equal(convertLines('a\r\nb').split('\n').length, 2);
});
