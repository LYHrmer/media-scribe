import test from 'node:test';
import assert from 'node:assert/strict';
import { runRegex, MAX_MATCHES } from '../src/lib/regex-tools.js';

test('collects matches with capture groups and offsets', () => {
  const { ok, matches } = runRegex('(\\d+)-(\\d+)', 'g', 'a1-2 b3-4');
  assert.equal(ok, true);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0], { index: 1, match: '1-2', groups: ['1', '2'], named: null });
  assert.equal(matches[1].index, 6);
});

test('named groups are exposed', () => {
  const { matches } = runRegex('(?<y>\\d{4})年', 'g', '2026年');
  assert.equal(matches[0].named.y, '2026');
});

test('missing g flag is added so all matches are found', () => {
  const { matches } = runRegex('a', '', 'aaa');
  assert.equal(matches.length, 3);
});

test('invalid patterns return a Chinese error instead of throwing', () => {
  const result = runRegex('(', 'g', 'x');
  assert.equal(result.ok, false);
  assert.match(result.message, /正则表达式无效/);
});

test('zero-width matches terminate instead of looping forever', () => {
  const { ok, matches } = runRegex('a*', 'g', 'bbb');
  assert.equal(ok, true);
  assert.equal(matches.length, 4); // empty match at each index, including the end
  assert.ok(matches.every(m => m.match === ''));
});

test('match count is capped and reported as truncated', () => {
  const result = runRegex('a', 'g', 'a'.repeat(MAX_MATCHES + 100));
  assert.equal(result.matches.length, MAX_MATCHES);
  assert.equal(result.truncated, true);
});
