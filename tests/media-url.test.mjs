import test from 'node:test';
import assert from 'node:assert/strict';
import { importMediaUrl, parseMediaUrl } from '../src/media-url.js';

const wav = new Uint8Array(48);
wav.set(new TextEncoder().encode('RIFF'), 0);
wav.set(new TextEncoder().encode('WAVE'), 8);
const response = (bytes = wav, headers = { 'content-type': 'audio/wav' }) => new Response(bytes, { headers });

test('share text accepts one HTTPS link and preserves signed query characters', () => {
  assert.equal(parseMediaUrl('听一下 https://example.com/a.wav?token=ab%2Bcd!').href, 'https://example.com/a.wav?token=ab%2Bcd!');
  for (const input of ['', 'javascript:alert(1)', 'http://example.com/a.wav', 'https://u:p@example.com/a.wav', 'https://a.com/a https://b.com/b']) assert.throws(() => parseMediaUrl(input));
});

test('platform pages and segmented streams are rejected before network access', async () => {
  for (const input of ['https://www.bilibili.com/video/BV123', 'https://v.douyin.com/abc', 'https://example.com/a.m3u8', 'https://example.com/watch.html']) {
    await assert.rejects(importMediaUrl(input, { fetchImpl: () => { assert.fail('must not fetch a known unsupported page'); } }), /网页|分段/);
  }
});

test('streamed media imports into a File with progress and no credentials or referrer', async () => {
  const progress = [];
  const file = await importMediaUrl('https://example.com/recording.wav?signature=private', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://example.com/recording.wav?signature=private');
      assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'cors');
      assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.method, 'GET');
      assert.equal(options.cache, 'no-store'); assert.equal(options.body, undefined);
      return response(wav, { 'content-type': 'audio/wav', 'content-length': String(wav.length) });
    }, onProgress: value => progress.push(value),
  });
  assert.equal(file.name, 'recording.wav'); assert.equal(file.size, 48); assert.equal(file.type, 'audio/wav');
  assert.ok(file.lastModified > 0); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), wav);
  assert.equal(progress.at(-1).loaded, 48); assert.equal(progress.at(-1).total, 48);
});

test('extensionless binary media is sniffed, and M4A is kept audio-only', async () => {
  const f = await importMediaUrl('https://example.com/download?id=2', { fetchImpl: async () => response(wav, {}) });
  assert.equal(f.name, 'download.wav'); assert.equal(f.type, 'audio/wav');
  const mp4 = new Uint8Array(24); mp4.set(new TextEncoder().encode('ftyp'), 4);
  const a = await importMediaUrl('https://example.com/voice.m4a', { fetchImpl: async () => response(mp4, { 'content-type': 'application/octet-stream' }) });
  assert.equal(a.type, 'audio/mp4');
});

test('HTML disguised as MP4 and playlists are never added as media', async () => {
  for (const [body, type, expected] of [
    ['<html><body>Sign in</body></html>', 'video/mp4', /网页/],
    ['#EXTM3U\n#EXTINF:5,\npart.ts', 'application/octet-stream', /分段/],
    ['<MPD/>', 'application/dash+xml', /分段/],
    ['{"error":"login"}', 'application/json', /网页/],
  ]) await assert.rejects(importMediaUrl('https://example.com/fake.mp4', { fetchImpl: async () => response(body, { 'content-type': type }) }), expected);
});

test('both declared and streamed oversized files stop with a clear error', async () => {
  await assert.rejects(importMediaUrl('https://example.com/a.wav', { maxBytes: 20, fetchImpl: async () => response(wav, { 'content-length': '48' }) }), /超过/);
  let canceled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(wav); }, cancel() { canceled = true; } });
  await assert.rejects(importMediaUrl('https://example.com/a.wav', { maxBytes: 20, fetchImpl: async () => new Response(body) }), /超过/);
  assert.equal(canceled, true);
});

test('aborted transfers do not return a File and cancel their stream', async () => {
  const abort = new AbortController(); let canceled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(wav); }, cancel() { canceled = true; } });
  await assert.rejects(importMediaUrl('https://example.com/a.wav', { signal: abort.signal, fetchImpl: async () => new Response(body),
    onProgress: ({ loaded }) => { if (loaded) abort.abort(); } }), { name: 'AbortError' });
  assert.equal(canceled, true);
});

test('timeouts, access denial, missing files and network failures remain distinct', async () => {
  await assert.rejects(importMediaUrl('https://example.com/a.wav', { idleTimeoutMs: 10,
    fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }), /长时间/);
  for (const [status, expected] of [[403, /拒绝/], [404, /不存在/], [206, /部分/]]) {
    await assert.rejects(importMediaUrl('https://example.com/a.wav', { fetchImpl: async () => new Response('error', { status }) }), expected);
  }
  await assert.rejects(importMediaUrl('https://example.com/a.wav', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /跨站/);
  await assert.rejects(importMediaUrl('https://example.com/a.wav', { fetchImpl: async () => response(new Uint8Array()) }), /空文件/);
});
