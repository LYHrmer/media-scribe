// Pure counters for the text-stats tool page. "Words" follows the common
// CJK convention: every Han character counts as one word, plus each run of
// latin letters/digits as one. Only BMP Han ranges are counted (extension B+
// astral ideographs are rare in day-to-day text).
const CJK_RE = /[一-鿿㐀-䶿]/g;
const LATIN_WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’_-][A-Za-z0-9À-ɏ]+)*/g;

export const READING_WORDS_PER_MINUTE = 400;

export function analyzeText(text) {
  const value = String(text);
  const chars = [...value].length;
  const bytes = new TextEncoder().encode(value).length;
  const normalized = value.replace(/\r\n?/g, '\n');
  const lineList = normalized.split('\n');
  if (lineList[lineList.length - 1] === '') lineList.pop();
  const lines = value === '' ? 0 : lineList.length;
  const paragraphs = value.trim() === ''
    ? 0
    : normalized.split(/\n[ \t]*\n/).filter(p => p.trim() !== '').length;
  const cjk = (value.match(CJK_RE) || []).length;
  const latinWords = (value.match(LATIN_WORD_RE) || []).length;
  const words = cjk + latinWords;
  return { chars, bytes, lines, paragraphs, cjk, latinWords, words };
}

export function readingTimeText(words) {
  if (words < READING_WORDS_PER_MINUTE) return '少于 1 分钟';
  return `约 ${Math.ceil(words / READING_WORDS_PER_MINUTE)} 分钟`;
}
