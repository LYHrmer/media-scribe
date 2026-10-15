// Regex engine for the regex-tester tool page. Everything lives in one
// function so the page can re-run live on every keystroke; the zero-width
// guard and iteration cap keep pathological patterns from looping forever.
export const MAX_MATCHES = 500;

export function runRegex(pattern, flags, text, { maxMatches = MAX_MATCHES } = {}) {
  const unique = [...new Set(String(flags))].join('');
  const effectiveFlags = unique.includes('g') ? unique : `${unique}g`;
  let regex;
  try {
    regex = new RegExp(pattern, effectiveFlags);
  } catch (error) {
    return { ok: false, message: `正则表达式无效：${error.message}` };
  }
  const source = String(text);
  const matches = [];
  let truncated = false;
  // A zero-width match advances lastIndex by one character, so total
  // iterations stay bounded by source length plus real matches.
  const maxIterations = source.length + maxMatches + 10;
  let iterations = 0;
  let m;
  while ((m = regex.exec(source)) !== null) {
    matches.push({ index: m.index, match: m[0], groups: m.slice(1), named: m.groups ?? null });
    if (matches.length >= maxMatches) { truncated = true; break; }
    if (regex.lastIndex === m.index) regex.lastIndex += 1;
    iterations += 1;
    if (iterations > maxIterations) { truncated = true; break; }
  }
  return { ok: true, matches, truncated };
}
