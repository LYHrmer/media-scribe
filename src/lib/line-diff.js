// Line-based text diff for the diff tool page.
// Strategy: normalize newlines, trim the common prefix/suffix of lines, then
// run a DP-based LCS on the changed middle. Middle regions over MAX_MIDDLE_LINES
// lines fall back to "delete everything, add everything" (coarse flag) instead
// of an O(m*n) table that could exhaust memory.

export const DEFAULT_MAX_CHARS = 200000;
export const MAX_MIDDLE_LINES = 3000;

// Line model: a trailing newline terminates the last line instead of starting
// an empty one, so '' is zero lines and 'a\n' is one — diffing against an
// empty side must not invent a spurious empty-line op.
function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function middleDiff(midA, midB) {
  const m = midA.length;
  const n = midB.length;
  if (m === 0) return { ops: midB.map(text => ({ type: 'add', text })) };
  if (n === 0) return { ops: midA.map(text => ({ type: 'del', text })) };
  if (m > MAX_MIDDLE_LINES || n > MAX_MIDDLE_LINES) {
    return {
      coarse: true,
      ops: [
        ...midA.map(text => ({ type: 'del', text })),
        ...midB.map(text => ({ type: 'add', text })),
      ],
    };
  }
  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * width + j] = midA[i] === midB[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (midA[i] === midB[j]) { ops.push({ type: 'same', text: midA[i] }); i += 1; j += 1; } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: 'del', text: midA[i] }); i += 1; } else { ops.push({ type: 'add', text: midB[j] }); j += 1; }
  }
  while (i < m) { ops.push({ type: 'del', text: midA[i] }); i += 1; }
  while (j < n) { ops.push({ type: 'add', text: midB[j] }); j += 1; }
  return { ops };
}

export function diffLines(textA, textB, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const total = String(textA).length + String(textB).length;
  if (total > maxChars) {
    return { ok: false, message: `两段文本合计 ${total} 个字符，超过上限 ${maxChars}，请分段对比` };
  }
  const a = splitLines(textA);
  const b = splitLines(textB);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  const middle = middleDiff(a.slice(start, endA + 1), b.slice(start, endB + 1));
  const ops = [
    ...a.slice(0, start).map(text => ({ type: 'same', text })),
    ...middle.ops,
    ...a.slice(endA + 1).map(text => ({ type: 'same', text })),
  ];
  return {
    ok: true,
    ops,
    coarse: middle.coarse === true,
    added: ops.filter(op => op.type === 'add').length,
    removed: ops.filter(op => op.type === 'del').length,
  };
}
