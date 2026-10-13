import test from 'node:test';
import assert from 'node:assert/strict';
import { punctuationTokens, insertPredictedPunctuation, punctuationSegments, needsPunctuation } from '../src/punctuation-text.js';

test('punctuation tokenization preserves unknown names, case and UTF-16 source offsets', () => {
  const words = punctuationTokens('你好 OpenAI 3.14 API', new Map([['<unk>', 0], ['你', 1], ['好', 2], ['api', 3]]));
  assert.deepEqual(words.map(word => word.text), ['你', '好', 'OpenAI', '3', '14', 'API']);
  assert.equal(words[2].id, 0);
  assert.equal(words.at(-1).id, 3);
  assert.equal(words.at(-1).end, '你好 OpenAI 3.14 API'.length);
  assert.equal(needsPunctuation('English words only'), false);
});

test('predictions may add marks but cannot delete existing punctuation, names or spaces', () => {
  const raw = '今天，下雨了\n明天见 OpenAI';
  const words = punctuationTokens(raw, new Map([['<unk>', 0]]));
  const predictions = words.map(() => 2);
  const result = insertPredictedPunctuation(raw, words, predictions);
  assert.ok(result.includes('天，'));
  assert.equal(result.includes('天，，'), false);
  assert.ok(result.includes('\n'));
  assert.ok(result.includes(' OpenAI。'));
  let cursor = 0;
  for (const char of result) if (char === raw[cursor]) cursor++;
  assert.equal(cursor, raw.length, 'the complete original is an unchanged subsequence');
});

test('added punctuation maps to exact subtitle character boundaries without changing timing', () => {
  const raw = '今天下雨了出门记得带伞';
  const result = '今天下雨了，出门记得带伞。';
  const segments = [{ start: 0, end: 1, text: '今天下雨了' }, { start: 1, end: 2, text: '出门记得带伞' }];
  assert.deepEqual(punctuationSegments(raw, result, segments), [
    { start: 0, end: 1, text: '今天下雨了，' }, { start: 1, end: 2, text: '出门记得带伞。' },
  ]);
  assert.deepEqual(segments.map(segment => segment.text), ['今天下雨了', '出门记得带伞']);
});

test('mismatched subtitle words are not silently rewritten, and lexical mutation is rejected', () => {
  assert.equal(punctuationSegments('实际原文', '实际原文。', [{ start: 0, end: 1, text: '不同文本' }]), null);
  assert.throws(() => punctuationSegments('原文', '改文。', []), /改变了原文/);
  assert.throws(() => punctuationSegments('你，好', '你好。', []), /未保留原文/);
});

test('existing punctuation and paragraph spacing survive subtitle projection', () => {
  const segments = [{ start: 0, end: 1, text: '你好，世界' }, { start: 1, end: 2, text: '再见' }];
  assert.deepEqual(punctuationSegments('你好，世界\n再见', '你好，世界。\n再见。', segments).map(segment => segment.text), ['你好，世界。', '再见。']);
});
