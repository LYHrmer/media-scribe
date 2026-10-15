import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText, readingTimeText, READING_WORDS_PER_MINUTE } from '../src/lib/text-stats.js';

test('empty input counts as all zeros', () => {
  assert.deepEqual(analyzeText(''), {
    chars: 0, bytes: 0, lines: 0, paragraphs: 0, cjk: 0, latinWords: 0, words: 0,
  });
});

test('pure Chinese counts every character as a word', () => {
  const stats = analyzeText('你好世界');
  assert.equal(stats.chars, 4);
  assert.equal(stats.bytes, 12);
  assert.equal(stats.cjk, 4);
  assert.equal(stats.latinWords, 0);
  assert.equal(stats.words, 4);
  assert.equal(stats.lines, 1);
  assert.equal(stats.paragraphs, 1);
});

test('english text counts whitespace-separated words', () => {
  const stats = analyzeText("it's a well-known fact");
  assert.equal(stats.latinWords, 4);
  assert.equal(stats.cjk, 0);
});

test('mixed text adds han characters and latin words together', () => {
  const stats = analyzeText('你好 hello world 测试');
  assert.equal(stats.cjk, 4);
  assert.equal(stats.latinWords, 2);
  assert.equal(stats.words, 6);
});

test('lines handle CRLF and ignore the trailing newline', () => {
  assert.equal(analyzeText('a\nb\n').lines, 2);
  assert.equal(analyzeText('a\r\nb').lines, 2);
  assert.equal(analyzeText('a').lines, 1);
});

test('paragraphs split on blank lines', () => {
  assert.equal(analyzeText('a\n\nb').paragraphs, 2);
  assert.equal(analyzeText('a\n  \nb').paragraphs, 2);
  assert.equal(analyzeText('a\nb').paragraphs, 1);
});

test('astral characters count as one char but four bytes', () => {
  const stats = analyzeText('👋');
  assert.equal(stats.chars, 1);
  assert.equal(stats.bytes, 4);
  assert.equal(stats.words, 0);
});

test('reading time uses the shared words-per-minute constant', () => {
  assert.equal(readingTimeText(0), '少于 1 分钟');
  assert.equal(readingTimeText(READING_WORDS_PER_MINUTE - 1), '少于 1 分钟');
  assert.equal(readingTimeText(READING_WORDS_PER_MINUTE * 2), '约 2 分钟');
  assert.equal(readingTimeText(READING_WORDS_PER_MINUTE * 2 + 1), '约 3 分钟');
});
