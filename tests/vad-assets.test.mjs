import test from 'node:test';
import assert from 'node:assert/strict';
import { VAD_ASSET, loadVadAsset } from '../src/vad-assets.js';
const origin = 'https://site.invalid';
async function withGlobals(overrides, run) {
  const old = Object.fromEntries(Object.keys(overrides).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, overrides);
  try { await run(); } finally { for (const key of Object.keys(overrides)) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; } }
}
test('same-origin pinned VAD model cannot fetch an unrelated URL', async () => {
  let requests = 0;
  await withGlobals({ location: { origin, href: origin+'/' }, fetch: async () => { requests++; } }, async () => {
    await assert.rejects(loadVadAsset('https://other.invalid/models-vad/'), /当前网页/);
    assert.equal(requests, 0);
  });
});
test('HTML cache entry is evicted and HTTP denial is never cached as a model', async () => {
  let deleted = 0, fetched = 0, stored = 0;
  await withGlobals({ location: { origin, href: origin+'/' }, caches: { open: async () => ({ match: async () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }), delete: async () => { deleted++; }, put: async () => { stored++; } }) }, fetch: async (url, options) => { fetched++; assert.equal(url, origin+'/models-vad/'+VAD_ASSET.name); assert.equal(options.method, 'GET'); return new Response('blocked', { status: 403 }); } }, async () => {
    await assert.rejects(loadVadAsset(origin+'/models-vad/'), /HTTP 403/);
    assert.equal(deleted, 1); assert.equal(fetched, 1); assert.equal(stored, 0);
  });
});
test('correct byte length alone is insufficient: corrupt ONNX content is rejected', async () => {
  let stored = 0;
  await withGlobals({ location: { origin, href: origin+'/' }, caches: { open: async () => ({ match: async () => undefined, put: async () => { stored++; } }) }, fetch: async () => new Response(new Uint8Array(VAD_ASSET.bytes)) }, async () => {
    await assert.rejects(loadVadAsset(origin+'/models-vad/'), /校验失败/);
    assert.equal(stored, 0);
  });
});
