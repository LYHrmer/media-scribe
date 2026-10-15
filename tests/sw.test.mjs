import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const CACHE_NAME = 'tingxie-static-v0.5.5';
const ORIGIN = 'https://example.test';

// Execute the shipped event handlers. Cache storage and network are isolated;
// Response is real, including its body cloning and HTTP error semantics.
function harness({ reply, failOpen = false, failPut = false, failDelete = false } = {}) {
  const listeners = new Map();
  const entries = new Map();
  const calls = { fetch: [], open: [], put: [], deleted: [], match: [], removedCaches: [] };
  const cache = {
    async match(request) {
      calls.match.push(request.url);
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      calls.put.push(request.url);
      if (failPut) throw new Error('QuotaExceededError');
      entries.set(request.url, response.clone());
    },
    async delete(request) {
      calls.deleted.push(request.url);
      if (failDelete) throw new Error('Storage unavailable');
      return entries.delete(request.url);
    },
  };
  const sandbox = {
    URL,
    Response,
    self: {
      location: { origin: ORIGIN },
      addEventListener(type, handler) { listeners.set(type, handler); },
      async skipWaiting() { calls.skipWaiting = true; },
      clients: { async claim() { calls.claim = true; } },
    },
    caches: {
      async open(name) {
        calls.open.push(name);
        if (failOpen) throw new Error('Storage unavailable');
        return cache;
      },
      async keys() { return ['unrelated-cache', 'tingxie-static-v0.3.1', 'tingxie-static-v0.5.4', CACHE_NAME]; },
      async delete(name) { calls.removedCaches.push(name); return true; },
    },
    async fetch(request) {
      calls.fetch.push(request.url);
      return reply ? reply(request, calls.fetch.length) : new Response('asset', { headers: { 'content-type': 'text/javascript' } });
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'sw.js' });
  return {
    calls, entries,
    async request(path, overrides = {}) {
      let result;
      listeners.get('fetch')({
        request: { url: new URL(path, ORIGIN).href, method: 'GET', mode: 'cors', ...overrides },
        respondWith(promise) { assert.equal(result, undefined); result = promise; },
      });
      return result === undefined ? null : await result;
    },
    async lifecycle(type) {
      let pending;
      listeners.get(type)({ waitUntil(promise) { pending = promise; } });
      await pending;
    },
  };
}

test('legitimate WASM and module responses are cached and reused without another download', async () => {
  const h = harness({ reply: request => new Response(request.url.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109]) : 'export const ready = true;', {
    headers: { 'content-type': request.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' },
  }) });
  for (const path of ['/vendor/runtime.wasm', '/assets/library.mjs', '/assets/main.js']) {
    const initial = await h.request(path);
    const cached = await h.request(path);
    assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), new Uint8Array(await initial.arrayBuffer()));
  }
  assert.equal(h.calls.fetch.length, 3);
  assert.equal(h.calls.put.length, 3);
  assert(h.calls.open.every(name => name === CACHE_NAME));
});

test('successful HTML at every supported asset extension is returned but never cached', async () => {
  for (const extension of ['js', 'css', 'mjs', 'wasm', 'svg', 'ico']) {
    const h = harness({ reply: () => new Response('<html>hosting error</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
    const response = await h.request(`/asset.${extension}`);
    assert.equal(response.status, 200, 'the service worker does not alter network status');
    assert.equal(await response.text(), '<html>hosting error</html>');
    await h.request(`/asset.${extension}`);
    assert.equal(h.calls.fetch.length, 2);
    assert.equal(h.calls.put.length, 0);
    assert.equal(h.entries.size, 0);
  }
});

test('already cached HTML cannot be served as a runtime and is replaced by a genuine response', async () => {
  const h = harness({ reply: () => new Response('export const recovered = true;', { headers: { 'content-type': 'text/javascript' } }) });
  const url = `${ORIGIN}/vendor/runtime.mjs`;
  h.entries.set(url, new Response('<html>old bad cache</html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(await (await h.request('/vendor/runtime.mjs')).text(), 'export const recovered = true;');
  assert.deepEqual(h.calls.deleted, [url]);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(await (await h.request('/vendor/runtime.mjs')).text(), 'export const recovered = true;');
  assert.equal(h.calls.fetch.length, 1);
});

test('HTTP 403 asset responses are preserved and never retained', async () => {
  const h = harness({ reply: () => new Response('<html>Access denied</html>', { status: 403, headers: { 'content-type': 'text/html' } }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await h.request('/assets/library.js');
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '<html>Access denied</html>');
  }
  assert.equal(h.calls.fetch.length, 2);
  assert.equal(h.calls.put.length, 0);
});

test('navigation remains network first, caches a valid page, and falls back only on a network error', async () => {
  const h = harness({ reply: (_request, count) => {
    if (count === 1) return new Response('<html>current app</html>', { headers: { 'content-type': 'text/html' } });
    if (count === 2) return new Response('<html>Access denied</html>', { status: 403 });
    throw new Error('Offline');
  } });
  const navigate = () => h.request('/app/', { mode: 'navigate' });
  assert.equal(await (await navigate()).text(), '<html>current app</html>');
  assert.equal((await navigate()).status, 403, 'a cached page does not override a network denial');
  assert.equal(await (await navigate()).text(), '<html>current app</html>');
  assert.equal(h.calls.fetch.length, 3);
  assert.equal(h.calls.put.length, 1);
  const absent = harness({ reply: () => { throw new Error('Offline'); } });
  assert.equal((await absent.request('/app/', { mode: 'navigate' })).type, 'error');
});

test('optional storage failures do not block a network response or return a cached HTML runtime', async () => {
  for (const options of [{ failOpen: true }, { failPut: true }, { failDelete: true }]) {
    const h = harness({ ...options, reply: () => new Response('module bytes', { headers: { 'content-type': 'text/javascript' } }) });
    if (options.failDelete) h.entries.set(`${ORIGIN}/runtime.js`, new Response('<html>invalid</html>', { headers: { 'content-type': 'text/html' } }));
    assert.equal(await (await h.request('/runtime.js')).text(), 'module bytes');
    assert.equal(h.calls.fetch.length, 1);
  }
});

test('model JSON, model chunks, user media, POST, other origins and non-HTTPS requests are untouched', async () => {
  const h = harness();
  for (const [path, overrides] of [
    ['/models-v2/Xenova/whisper-small/config.json', {}],
    ['/models-v2/encoder.onnx.part-0.bin', {}],
    ['/recording.mp3', {}],
    ['/assets/main.js', { method: 'POST' }],
    ['https://other.test/assets/main.js', {}],
    ['http://example.test/assets/main.js', {}],
  ]) assert.equal(await h.request(path, overrides), null);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.open.length, 0);
  assert.equal(h.calls.match.length, 0);
});

test('activation removes only obsolete app caches and claims clients', async () => {
  const h = harness();
  await h.lifecycle('install');
  await h.lifecycle('activate');
  assert.equal(h.calls.skipWaiting, true);
  assert.equal(h.calls.claim, true);
  assert.deepEqual(h.calls.removedCaches, ['tingxie-static-v0.3.1', 'tingxie-static-v0.5.4']);
});
