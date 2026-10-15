// Screen classification and ASR agreement are evidence, never ground truth.
// No lyric dictionary, expected transcript, forced-alignment score, or remote API.
const HAN = /\p{Script=Han}/u;
const clean = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const words = value => String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const role = /^(?:(?:本集|本期)?(?:总?编剧|总?导演|联合导演|执行导演|艺术指导|美术指导|摄影指导|音乐总监|制作监督|总?监制|总?策划|总?制片人|出品人|领衔主演|主演|演员表|配音|作词|作曲|编曲|演唱|特别鸣谢)|written by|directed by|director|screenplay|producer|executive producer|cast|starring|music by|lyrics by)(?:\s*[:：]\s*[\p{L}\p{N}·、，, &.-]{1,48})?$/iu;
const labelText = value => String(value ?? '').trim().replace(/[。.!！?？]+$/u, '').trim();
const overlaps = (a, b) => Math.min(a.end, b.end) > Math.max(a.start, b.start);
const validBox = b => b && ['left','right','top','bottom','width','height','x','y'].every(k => Number.isFinite(b[k]))
  && b.left >= 0 && b.top >= 0 && b.right <= 1 && b.bottom <= 1 && b.width > 0 && b.height > 0;
const nameShape = value => /^(?:[\p{Script=Han}·]{2,5}(?:[、，\s]+[\p{Script=Han}·]{2,5}){0,3}|[\p{Script=Latin}.'’-]+(?:\s+[\p{Script=Latin}.'’-]+){1,3})$/u.test(labelText(value));
const handleShape = value => /^@+[\p{L}\p{N}_·.-]{2,32}$/u.test(labelText(value));

function neighbouringCredit(item, heading) {
  // A role word anywhere in the video must not suppress an unrelated subtitle.
  if (!overlaps(item, heading) || !nameShape(item.observedText ?? item.text)) return false;
  const a = item.box, b = heading.box;
  if (!validBox(a) || !validBox(b)) return false;
  const sameRow = Math.abs(a.y - b.y) <= Math.max(a.height, b.height) * 0.65
    && a.left >= b.right - b.width * 0.1 && a.left - b.right <= Math.max(0.12, b.width);
  const horizontalOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  // Tilted credit cards can have overlapping axis-aligned boxes. Compare their
  // centres and column overlap rather than requiring disjoint top/bottom edges.
  const below = a.y >= b.y + Math.min(a.height, b.height) * 0.5
    && a.top - b.bottom <= Math.max(a.height, b.height) * 3.2
    && (Math.abs(a.x - b.x) <= Math.max(a.width, b.width) * 0.55
      || horizontalOverlap >= Math.min(a.width, b.width) * 0.25);
  // Distant text at the bottom of a credits screen stays a separate candidate.
  return sameRow || below;
}

export function classifyScreenTracks(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const headings = list.filter(item => role.test(labelText(item.observedText ?? item.text)));
  return list.map(item => {
    const heading = headings.includes(item) || headings.some(other => neighbouringCredit(item, other));
    if (!heading && handleShape(item.observedText ?? item.text)) return { ...item, category: 'screen_label',
      reliable: false, reason: 'probable_handle', warnings: [...(item.warnings || []), '疑似画面账号标识；不代表正在说的话，可回放核对。'] };
    const category = heading ? 'credits' : item.reason === 'static_text' ? 'static' : item.reliable ? 'subtitle' : 'uncertain';
    return { ...item, category, ...(heading ? { reliable: false, reason: 'probable_credit',
      warnings: [...(item.warnings || []), '疑似演职员信息；分类可能有误，可回放核对。'] } : {}) };
  });
}

function tokens(value) { return HAN.test(value) ? Array.from(clean(value)) : words(value); }
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}
function sequenceAt(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, j) => token === haystack[i + j])) return true;
  }
  return false;
}

export function reviewCaptionEvidence(candidates, result) {
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  return (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const base = { ...candidate };
    // Never inherit agreement from an earlier transcription/retry.
    delete base.audioEvidence;
    if (['credits', 'static', 'screen_label'].includes(candidate.category) || ['probable_credit','static_text','probable_handle'].includes(candidate.reason)) return base;
    const query = tokens(String(candidate.text || ''));
    const minimum = HAN.test(candidate.text || '') ? 4 : 3;
    const valid = Number.isFinite(candidate.start) && Number.isFinite(candidate.end) && candidate.end > candidate.start;
    if (!valid || query.length < minimum || query.length > 160 || !candidate.reliable || result?.timing === 'approximate') {
      return { ...base, audioEvidence: { status: 'unverified', reason: !valid || result?.timing === 'approximate' ? 'timing' : 'visual_or_short' } };
    }
    const local = segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start
      && s.end - s.start <= Math.min(18, Math.max(8, candidate.end - candidate.start + 2))
      && s.start < candidate.end + 0.75 && s.end > candidate.start - 0.75);
    if (!local.length) return { ...base, audioEvidence: { status: 'unverified', reason: 'no_local_speech' } };
    // Bound work for long/malformed results. Comparison never supplies text to ASR.
    const audioText = local.map(s => s.text).join(' ').slice(0, 1200);
    const spoken = tokens(audioText);
    const match = sequenceAt(spoken, query);
    const similarity = 1 - distance(query, spoken) / Math.max(query.length, spoken.length, 1);
    return { ...base, audioEvidence: { status: match ? 'match' : similarity >= 0.6 ? 'different' : 'unverified',
      reason: match ? 'local_asr_agreement' : 'local_asr_difference', text: audioText,
      start: Math.min(...local.map(s => s.start)), end: Math.max(...local.map(s => s.end)) } };
  });
}

export function captionLabel(candidate) {
  if (candidate.reason === 'probable_handle' || candidate.category === 'screen_label') return '疑似账号标识';
  if (candidate.reason === 'probable_credit' || candidate.category === 'credits') return '疑似演职员信息';
  if (candidate.reason === 'static_text' || candidate.category === 'static') return '固定画面文字';
  if (candidate.audioEvidence?.status === 'match') return '与对应时段的语音识别一致';
  if (candidate.audioEvidence?.status === 'different') return '画面与语音识别有差异';
  if (candidate.reason === 'needs_review') return '画面字形待确认';
  return '画面文字，声音尚未确认';
}
