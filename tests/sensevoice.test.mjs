import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSenseRanges, senseResultSegments, normalizeSensePunctuation } from '../src/sensevoice-segments.js';
import { SENSEVOICE_ASSETS, validateSenseManifest } from '../src/sensevoice-assets.js';
import { renderSrt } from '../src/exports.js';

test('long audio is covered exactly once with bounded chunks and quiet boundaries', () => {
  const audio = new Float32Array(16000 * 71).fill(0.3);
  audio.fill(0, 16000 * 28, 16000 * 28.3);
  const ranges = splitSenseRanges(audio, [{ start: 0, end: audio.length }]);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges.at(-1).end, audio.length);
  assert(ranges[0].end >= 16000 * 28 && ranges[0].end < 16000 * 28.4);
  for (let i = 0; i < ranges.length; i++) {
    assert(ranges[i].end - ranges[i].start <= 30 * 16000);
    assert(ranges[i].end > ranges[i].start);
    if (i) assert.equal(ranges[i].start, ranges[i - 1].end);
  }
});

test('short audio ranges stay intact and separate silence gaps retain offsets', () => {
  const ranges = [{ start: 100, end: 50000 }, { start: 80000, end: 99000 }];
  assert.deepEqual(splitSenseRanges(new Float32Array(100000), ranges), ranges);
});

test('CTC tokens produce sentence cues without changing characters or inventing precise times', () => {
  const out = senseResultSegments({ text: '你好。再见。', tokens: ['你','好','。','再','见','。'], timestamps: [0.1,0.3,0.5,1.5,1.7,1.9] }, 2.1, 5);
  assert.equal(out.approximate, false);
  assert.equal(out.segments.map(s => s.text).join(''), '你好。再见。');
  assert.equal(out.segments[0].start, 5.1);
  assert.equal(out.segments[1].start, 6.5);
  assert.doesNotThrow(() => renderSrt(out.segments));
  const bad = [undefined, [0.2], [0.2,0.1], [NaN,0.4], [0.2,3], [0.1,0.1]];
  for (const timestamps of bad) {
    const result = senseResultSegments({ text: '一。二', tokens: ['一。','二'], timestamps }, 2, 10);
    assert.equal(result.approximate, true);
    assert.deepEqual(result.segments, [{ start: 10, end: 12, text: '一。二' }]);
  }
});

test('mismatched token text falls back to the unmodified full transcript', () => {
  const result = senseResultSegments({ text: '123。', tokens: ['一','二','三','。'], timestamps: [0.1,0.2,0.3,0.4] }, 1);
  assert.equal(result.approximate, true);
  assert.equal(result.segments[0].text, '123。');
});

test('CTC sentence boundaries preserve decimal numbers across token splits', () => {
  for (const tokens of [
    ['It is ', '2', '.', '5', ' meters', '.', ' Yes.'],
    ['It is ', '2.', '5', ' meters', '.', ' Yes.'],
    ['It is ', '2.5', ' meters.', ' Yes.'],
    ['数值是', '0', '.', '05', '。', '结束。'],
    ['数值是', '0.', '05', '。', '结束。'],
    ['数值是', '0.05', '。', '结束。'],
  ]) {
    const text = tokens.join('');
    const timestamps = tokens.map((_, i) => 0.1 + i * 0.2);
    const result = senseResultSegments({ text, tokens, timestamps }, 3, 5);
    assert.equal(result.approximate, false);
    assert.equal(result.segments.length, 2, text);
    assert.equal(result.segments[0].text, text.startsWith('It') ? 'It is 2.5 meters.' : '数值是0.05。');
    assert.equal(result.segments.map(segment => segment.text).join('').replace(/\s/gu, ''), text.replace(/\s/gu, ''));
    assert.doesNotThrow(() => renderSrt(result.segments));
  }
});

test('a period after a number remains a sentence boundary before whitespace or a word', () => {
  for (const suffix of [' Next.', 'Next.', ' 5 more.']) {
    const tokens = ['It was 2', '.', suffix];
    const result = senseResultSegments({ text: tokens.join(''), tokens, timestamps: [0.1, 0.5, 1] }, 2);
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].text, 'It was 2.');
    assert.equal(result.segments[1].text, suffix.trim());
  }
});

test('model manifest rejects wrong weights, excessive allocation and path traversal', () => {
  const asset = SENSEVOICE_ASSETS.tokens;
  const make = () => ({ version: 1, bytes: asset.bytes, sha256: asset.sha256, parts: [{ file: 'tokens.txt.part-0.gz.bin', bytes: asset.bytes, compressedBytes: 100, sha256: 'a'.repeat(64) }] });
  assert.equal(validateSenseManifest(make(), asset).bytes, asset.bytes);
  for (const alter of [x => x.bytes++, x => x.sha256 = 'b'.repeat(64), x => x.parts[0].file = '../other', x => x.parts[0].bytes++, x => x.parts[0].compressedBytes = 1e9, x => x.parts[0].sha256 = 'bad']) {
    const m = make(); alter(m); assert.throws(() => validateSenseManifest(m, asset));
  }
});

test('inconsistent compressed model is rejected and cannot poison the next attempt', async () => {
  const { loadSenseAsset } = await import('../src/sensevoice-assets.js');
  const { gzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');
  const old = { location: globalThis.location, caches: globalThis.caches, fetch: globalThis.fetch };
  const asset = SENSEVOICE_ASSETS.tokens;
  const gzip = gzipSync(new Uint8Array(asset.bytes));
  const m = { version: 1, bytes: asset.bytes, sha256: asset.sha256, parts: [{ file: 'tokens.txt.part-0.gz.bin', bytes: asset.bytes, compressedBytes: gzip.length, sha256: createHash('sha256').update(gzip).digest('hex') }] };
  const cache = new Map(); let gets = 0;
  globalThis.location = { origin: 'https://test.invalid', href: 'https://test.invalid/' };
  globalThis.caches = { open: async () => ({ match: async k => cache.get(k)?.clone(), put: async (k,r) => cache.set(k,r.clone()), delete: async k => cache.delete(k) }) };
  globalThis.fetch = async (url, options) => {
    gets++; assert.equal(options.method, 'GET'); assert.equal(new URL(url).origin, 'https://test.invalid');
    return new Response(url.endsWith('.json') ? JSON.stringify(m) : gzip);
  };
  try {
    await assert.rejects(loadSenseAsset('https://elsewhere.invalid/models/', asset), /当前网页/);
    assert.equal(gets, 0);
    await assert.rejects(loadSenseAsset('https://test.invalid/models/', asset), /整体校验失败/);
    assert.equal(cache.size, 0);
    const before = gets;
    await assert.rejects(loadSenseAsset('https://test.invalid/models/', asset), /整体校验失败/);
    assert.equal(gets, before + 2, 'retry downloads a clean manifest and part');
    globalThis.fetch = async () => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    await assert.rejects(loadSenseAsset('https://test.invalid/models/', asset), /HTTP 403/);
    assert.equal(cache.size, 0);
  } finally { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
});

test('a valid gzip with short expanded bytes clears cached parts and manifest before retry', async () => {
  const { loadSenseAsset } = await import('../src/sensevoice-assets.js');
  const { gzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');
  const old = { location: globalThis.location, caches: globalThis.caches, fetch: globalThis.fetch };
  const asset = SENSEVOICE_ASSETS.tokens;
  const base = 'https://test.invalid/models/';
  const manifestUrl = `${base}${asset.name}.manifest.json`;
  const partUrl = `${base}${asset.name}.part-0.gz.bin`;
  const makeManifest = gzip => ({ version: 1, bytes: asset.bytes, sha256: asset.sha256,
    parts: [{ file: `${asset.name}.part-0.gz.bin`, bytes: asset.bytes, compressedBytes: gzip.length,
      sha256: createHash('sha256').update(gzip).digest('hex') }] });
  const shortGzip = gzipSync(new Uint8Array(asset.bytes - 1));
  const cache = new Map([
    [manifestUrl, new Response(JSON.stringify(makeManifest(shortGzip)))],
    [partUrl, new Response(shortGzip)],
  ]);
  const requests = [];
  globalThis.location = { origin: 'https://test.invalid', href: 'https://test.invalid/' };
  globalThis.caches = { open: async () => ({ match: async k => cache.get(k)?.clone(),
    put: async (k, r) => cache.set(k, r.clone()), delete: async k => cache.delete(k) }) };
  // The replacement is synthetic too: it has a correct expanded length, but
  // must still fail the pinned real-asset hash instead of bypassing integrity.
  const fullGzip = gzipSync(new Uint8Array(asset.bytes));
  globalThis.fetch = async url => {
    requests.push(url);
    return new Response(url === manifestUrl ? JSON.stringify(makeManifest(fullGzip)) : fullGzip);
  };
  try {
    await assert.rejects(loadSenseAsset(base, asset), /解压不完整/);
    assert.deepEqual(requests, [], 'first attempt reproduces a verified but inconsistent cache');
    assert.equal(cache.size, 0, 'both the stale manifest and compressed part must be discarded');
    await assert.rejects(loadSenseAsset(base, asset), /整体校验失败/);
    assert.deepEqual(requests, [manifestUrl, partUrl], 'retry obtains new bytes and advances past decompression');
    assert.equal(cache.size, 0, 'whole-model integrity remains mandatory');
  } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
});

test('repeated Chinese full stops are cleaned without changing words, decimals or ellipses', () => {
  const result = { text: '9.5点……好。。', tokens: ['9.5','点','……','好','。','。'], timestamps: [0.1,0.2,0.3,0.4,0.6,0.8] };
  const cleaned = normalizeSensePunctuation(result);
  assert.equal(cleaned.text, '9.5点……好。');
  assert.equal(cleaned.tokens.join(''), cleaned.text);
  assert.equal(result.text, '9.5点……好。。', 'original model output remains available');
  const late = senseResultSegments({ text: '你好。', tokens: ['你','好','。'], timestamps: [0.1,0.3,2] }, 3);
  assert.equal(late.segments.length, 1);
  assert.equal(late.segments[0].text, '你好。');
});

test('SenseVoice comma-stop artifact is removed across token boundaries with surviving timestamps intact', () => {
  // Entirely synthetic text and alignment preserve repetition and split
  // punctuation without publishing a private recording's transcription.
  const text = '今今天图书开放，。';
  for (const tokens of [
    ['今今天', '图书开放', '，', '。'],
    ['今今天', '图书开放，', '。'],
    ['今今天', '图书开放', '，。'],
  ]) {
    const timestamps = tokens.map((_, index) => index * 0.3);
    const original = { text, tokens, timestamps };
    const before = structuredClone(original);
    const cleaned = normalizeSensePunctuation(original);
    assert.equal(cleaned.text, '今今天图书开放。');
    assert.equal(cleaned.tokens.join(''), cleaned.text);
    assert.deepEqual(original, before);
    const retained = tokens.map((token, index) => ({ token: token.replace(/，/gu, ''), time: timestamps[index] })).filter(item => item.token);
    assert.deepEqual(cleaned.tokens, retained.map(item => item.token));
    assert.deepEqual(cleaned.timestamps, retained.map(item => item.time));
    const cues = senseResultSegments(cleaned, 2);
    assert.equal(cues.approximate, false);
    assert.equal(cues.segments.map(segment => segment.text).join(''), cleaned.text);
  }
});

test('comma-stop normalization preserves valid punctuation, quoted text, spacing, digits and words', () => {
  for (const text of ['为什么？！', '真的吗！？', '等一下……', '等一下...', '他说：“你好。”',
    '9.5点，开始。', '你好，\n。', '你好， 。', '你好，”。', '甲,。', '甲，.', '甲、。']) {
    const result = { text, tokens: [text], timestamps: [0] };
    assert.equal(normalizeSensePunctuation(result), result, text);
  }
  const result = { text: '😀他说：“好，。”再见，，。。', tokens: ['😀他说：“好，', '。”再见，', '，。', '。'], timestamps: [0, 0.3, 0.6, 0.9] };
  const cleaned = normalizeSensePunctuation(result);
  assert.equal(cleaned.text, '😀他说：“好。”再见。');
  assert.equal(cleaned.tokens.join(''), cleaned.text);
  assert.deepEqual(cleaned.timestamps, [0, 0.3, 0.6]);
  assert.deepEqual(normalizeSensePunctuation(cleaned), cleaned);
  assert.equal(cleaned.text.replace(/[，。]/gu, ''), result.text.replace(/[，。]/gu, ''));
});

test('unusable token metadata cannot be invented by punctuation cleanup', () => {
  for (const extra of [{}, { tokens: ['另一个文本'], timestamps: [0] },
    { tokens: ['你好，', '。'], timestamps: [0] }, { tokens: ['你好，', null], timestamps: [0, 1] }]) {
    const original = { text: '你好，。', ...extra };
    const before = structuredClone(original);
    const cleaned = normalizeSensePunctuation(original);
    assert.equal(cleaned.text, '你好。');
    assert.deepEqual(original, before);
    assert.equal(senseResultSegments(cleaned, 2).approximate, true);
  }
});
