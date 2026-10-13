import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPunctuationAsset, validatePunctuationManifest, PUNCTUATION_CACHE } from '../src/punctuation-assets.js';

const model = { name: 'model.zh-compact.int8.onnx', bytes: 7637864, sha256: '807302f35c81326bd2a0e3f0b1b99077dbd270a9776d22d0b2080bdd6b9c0dae' };
const tokens = { name: 'tokens.json', bytes: 97004, sha256: 'cb7369ce808e03f9a3b6c3ce3eae16fc2e4dd2aed2ffc49c2b9f108a642c0140' };

test('punctuation manifests cannot redirect asset requests or replace their pinned hashes', () => {
  assert.equal(validatePunctuationManifest({ model, tokens }).model, model);
  for (const changed of [{ name: 'https://other.invalid/collect' }, { name: '../model.onnx' }, { bytes: 0 }, { bytes: model.bytes + 1 }, { sha256: 'a'.repeat(64) }]) {
    assert.throws(() => validatePunctuationManifest({ model: { ...model, ...changed }, tokens }), /目录不匹配/);
  }
});

test('cached HTML is evicted, retried from network and never replaces a model', async () => {
  const previousFetch = globalThis.fetch, previousCaches = globalThis.caches;
  let deleted = 0, network = 0, stored = 0;
  globalThis.caches = { open: async name => {
    assert.equal(name, PUNCTUATION_CACHE);
    return { match: async () => new Response('<html>blocked</html>', { headers: { 'Content-Type': 'text/html' } }), delete: async () => { deleted++; }, put: async () => { stored++; } };
  } };
  globalThis.fetch = async (url, options) => { network++; assert.equal(url, 'https://site.invalid/models-punctuation/tokens.json'); assert.equal(options.cache, 'reload'); return new Response('Forbidden', { status: 403 }); };
  try {
    await assert.rejects(loadPunctuationAsset('https://site.invalid/models-punctuation/', tokens), /HTTP 403/);
    assert.equal(deleted, 1); assert.equal(network, 1); assert.equal(stored, 0);
  } finally { globalThis.fetch = previousFetch; globalThis.caches = previousCaches; }
});

test('denied browser storage still permits network fallback but invalid bytes are rejected', async () => {
  const previousFetch = globalThis.fetch, previousCaches = globalThis.caches;
  let network = 0;
  globalThis.caches = { open: async () => { throw new Error('Storage denied'); } };
  globalThis.fetch = async () => { network++; return new Response(new Uint8Array(10)); };
  try {
    await assert.rejects(loadPunctuationAsset('https://site.invalid/models-punctuation/', tokens), /大小校验失败/);
    assert.equal(network, 1);
  } finally { globalThis.fetch = previousFetch; globalThis.caches = previousCaches; }
});
