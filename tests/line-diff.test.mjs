import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, DEFAULT_MAX_CHARS } from '../src/lib/line-diff.js';

function reconstruct(ops, keep) {
  return ops.filter(op => op.type === 'same' || op.type === keep).map(op => op.text).join('\n');
}

test('identical texts produce only same ops', () => {
  const { ok, ops, added, removed } = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(ok, true);
  assert.deepEqual(ops.map(op => op.type), ['same', 'same', 'same']);
  assert.equal(added + removed, 0);
});

test('insertions, deletions and replacements round-trip both sides', () => {
  const a = '开头\n旧的一行\n保留\n结尾';
  const b = '开头\n新的一行\n再加一行\n保留\n结尾';
  const { ops } = diffLines(a, b);
  assert.equal(reconstruct(ops, 'del'), a);
  assert.equal(reconstruct(ops, 'add'), b);
  assert.ok(ops.some(op => op.type === 'del' && op.text === '旧的一行'));
  assert.ok(ops.some(op => op.type === 'add' && op.text === '新的一行'));
});

test('common prefix and suffix stay same even when the middle empties', () => {
  const { ops } = diffLines('同\n甲\n同尾', '同\n同尾');
  assert.deepEqual(ops.map(op => op.type), ['same', 'del', 'same']);
});

test('empty sides are handled', () => {
  assert.deepEqual(diffLines('', 'x\ny').ops.map(op => op.type), ['add', 'add']);
  assert.deepEqual(diffLines('x\ny', '').ops.map(op => op.type), ['del', 'del']);
  assert.equal(diffLines('', '').ops.length, 0);
});

test('normalizes CRLF before comparing', () => {
  const { added, removed } = diffLines('a\r\nb', 'a\nb');
  assert.equal(added + removed, 0);
});

test('rejects inputs over the character cap', () => {
  const big = 'x'.repeat(DEFAULT_MAX_CHARS);
  const result = diffLines(big, big);
  assert.equal(result.ok, false);
  assert.match(result.message, /超过上限/);
});

test('huge changed regions fall back to a coarse whole-block diff', () => {
  const a = Array.from({ length: 3100 }, (_, i) => `甲${i}`).join('\n');
  const b = Array.from({ length: 3100 }, (_, i) => `乙${i}`).join('\n');
  const { ok, ops, coarse } = diffLines(a, b);
  assert.equal(ok, true);
  assert.equal(coarse, true);
  assert.equal(reconstruct(ops, 'del'), a);
  assert.equal(reconstruct(ops, 'add'), b);
});
