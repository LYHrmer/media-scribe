const HAN = /\p{Script=Han}/u;
const CONTENT = /[\p{L}\p{M}\p{N}]/u;
const PUNCTUATION = /[\p{P}]/u;
export const needsPunctuation = text => typeof text === 'string' && HAN.test(text);

/** Original offsets are retained: unknown words, case and whitespace stay exact. */
export function punctuationTokens(text, vocabulary) {
  const tokens = [];
  const unknown = vocabulary.get('<unk>');
  const pattern = /[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*|[^\x00-\x7f]/gu;
  for (const match of text.matchAll(pattern)) {
    const word = match[0];
    if (!CONTENT.test(word)) continue;
    tokens.push({ text: word, end: match.index + word.length,
      id: vocabulary.get(word) ?? vocabulary.get(word.toLowerCase()) ?? unknown });
  }
  return tokens;
}

export function insertPredictedPunctuation(text, tokens, predictions) {
  const marks = ['', '', '，', '。', '？', '、'];
  let output = '', cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const end = tokens[i].end;
    output += text.slice(cursor, end);
    cursor = end;
    const following = text.slice(end).match(/^\s*([^\s])/u)?.[1];
    // Existing punctuation belongs to the user/model, never replace it. Avoid
    // treating decimal points, quotes and parenthesized clauses as missing marks.
    if (following && PUNCTUATION.test(following)) continue;
    let mark = marks[predictions[i]] || '';
    if (i === tokens.length - 1 && (!mark || mark === '，' || mark === '、')) mark = '。';
    output += mark;
  }
  return output + text.slice(cursor);
}

/** Project inserted marks by exact content-character boundary, preserving times. */
export function punctuationSegments(rawText, punctuatedText, segments) {
  const content = text => [...text].filter(char => CONTENT.test(char)).join('');
  if (content(rawText) !== content(punctuatedText)) throw new Error('标点处理改变了原文内容，已保留原结果。');
  const additions = new Map();
  let oldIndex = 0, boundary = 0;
  const original = [...rawText];
  for (const char of punctuatedText) {
    if (char === original[oldIndex]) { oldIndex++; if (CONTENT.test(char)) boundary++; }
    else {
      if (!/[，。？、]/u.test(char)) throw new Error('标点处理未保留原文，已保留原结果。');
      additions.set(boundary, (additions.get(boundary) || '') + char);
    }
  }
  if (oldIndex !== original.length) throw new Error('标点处理未保留原文，已保留原结果。');
  if (content(segments.map(segment => segment.text).join('')) !== content(rawText)) return null;
  let count = 0;
  return segments.map(segment => {
    let text = '';
    const chars = [...segment.text];
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index];
      text += char;
      if (CONTENT.test(char)) {
        count++;
        if (additions.has(count) && !PUNCTUATION.test(chars[index + 1] || '')) text += additions.get(count);
      }
    }
    return { ...segment, text };
  });
}
