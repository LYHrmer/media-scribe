import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installModelAssetFetch } from '../src/model-assets.js';
import { MODEL_IDS, MODEL_FILES, getModelFiles, PART_BYTES, prepareModelAssets } from '../scripts/prepare-models.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const BASE = 'https://test.example/app/models-v2/';
const PATH = 'Xenova/whisper-tiny/onnx/encoder_model_quantized.onnx';
const MODEL_URL = new URL(PATH, BASE).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture({ bytes = Uint8Array.from([0x08, 0x09, 0x12, 0x04, 0, 255, 10, 8]), pathName = PATH } = {}) {
  const filename = pathName.split('/').at(-1);
  const chunks = [bytes.slice(0, 3), bytes.slice(3)];
  const manifest = {
    version: 1,
    bytes: bytes.length,
    sha256: hash(bytes),
    parts: chunks.map((chunk, i) => ({ file: `${filename}.part-${i}.bin`, bytes: chunk.length, sha256: hash(chunk) })),
  };
  const modelUrl = new URL(pathName, BASE);
  const calls = [];
  const replies = new Map([
    [`${modelUrl}.manifest.json`, () => new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })],
    ...chunks.map((chunk, i) => [new URL(manifest.parts[i].file, new URL('./', modelUrl)).href,
      () => new Response(chunk, { headers: { 'content-type': 'application/octet-stream' } })]),
  ]);
  const fetchImpl = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init, input });
    if (!replies.has(url)) throw new Error(`Unexpected fetch: ${url}`);
    return replies.get(url)(url, init);
  };
  const adapter = installModelAssetFetch(BASE, { fetchImpl, install: false });
  return { adapter, manifest, replies, calls, bytes, chunks, modelUrl: modelUrl.href };
}

test('ONNX is joined byte for byte and has correct progress length', async () => {
  const f = fixture();
  const response = await f.adapter.fetch(new Request(MODEL_URL));
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  const reader = response.body.getReader();
  const first = await reader.read();
  const second = await reader.read();
  assert.deepEqual(first.value, f.chunks[0]);
  assert.deepEqual(second.value, f.chunks[1]);
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, 'https://test.example');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'same-origin');
  }
});

test('Tiny q8 and Small q4f16 use their own same-origin assets', async () => {
  assert.deepEqual(MODEL_IDS, ['Xenova/whisper-tiny', 'Xenova/whisper-small']);
  assert.deepEqual(getModelFiles('Xenova/whisper-tiny'), MODEL_FILES);
  for (const [model, precision] of [['tiny', 'quantized'], ['small', 'q4f16']]) {
    for (const file of [`encoder_model_${precision}`, `decoder_model_merged_${precision}`]) {
      const f = fixture({ pathName: `Xenova/whisper-${model}/onnx/${file}.onnx` });
      const response = await f.adapter.fetch(f.modelUrl);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes);
    }
  }
});

test('runtime WASM, required config, external URLs and unrelated requests pass through untouched', async () => {
  const calls = [];
  const wasmBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const returnedResponse = new Response(wasmBytes);
  const { fetch } = installModelAssetFetch(BASE, {
    install: false,
    fetchImpl: async (input, init) => { calls.push({ input, init }); return returnedResponse; },
  });
  const init = { method: 'GET', headers: { 'x-test': 'retained' } };
  const inputs = [
    'https://test.example/app/vendor/ort/ort-wasm-simd-threaded.wasm',
    new URL('Xenova/whisper-tiny/config.json', BASE),
    'https://huggingface.co/Xenova/whisper-tiny/resolve/main/onnx/encoder_model_quantized.onnx',
    'https://test.example/unrelated/model.onnx',
    new Request('https://test.example/unrelated/status', { method: 'POST', body: 'unrelated' }),
  ];
  for (const input of inputs) assert.equal(await fetch(input, init), returnedResponse);
  assert.deepEqual(calls, inputs.map(input => ({ input, init })));
  assert.deepEqual(new Uint8Array(await returnedResponse.arrayBuffer()), wasmBytes);
});

test('optional metadata is a local 404 so static SPA fallback cannot break model initialization', async () => {
  const calls = [];
  const { fetch } = installModelAssetFetch(BASE, {
    install: false,
    fetchImpl: async input => { calls.push(input); return new Response('<html>SPA</html>', { headers: { 'content-type': 'text/html' } }); },
  });
  for (const model of ['tiny', 'small']) {
    for (const filename of ['processor_config.json', 'special_tokens_map.json', 'added_tokens.json']) {
      const response = await fetch(new URL(`Xenova/whisper-${model}/${filename}`, BASE));
      assert.equal(response.status, 404);
      assert.equal(await response.text(), '');
    }
  }
  assert.equal(calls.length, 0);
  // Files outside the exact supported model directories remain untouched.
  const unrelated = new URL('Xenova/unrelated/processor_config.json', BASE).href;
  assert.equal((await fetch(unrelated)).status, 200);
  assert.deepEqual(calls, [unrelated]);
});

test('required model JSON rejects a successful HTML response while preserving valid fetch input and init', async () => {
  const configUrl = new URL('Xenova/whisper-tiny/config.json', BASE).href;
  const { fetch } = installModelAssetFetch(BASE, {
    install: false,
    fetchImpl: async () => new Response('<html>SPA fallback</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  await assert.rejects(fetch(configUrl), /MODEL_ASSET_FAILED/);
  const input = new Request(configUrl);
  const init = { signal: new AbortController().signal, headers: { 'x-test': 'preserved' } };
  const goodResponse = new Response('{"model_type":"whisper"}', { headers: { 'content-type': 'application/json' } });
  const good = installModelAssetFetch(BASE, { install: false, fetchImpl: async (actualInput, actualInit) => {
    assert.equal(actualInput, input);
    assert.equal(actualInit, init);
    return goodResponse;
  } });
  assert.equal(await good.fetch(input, init), goodResponse);
});

test('denied config, manifest and model parts preserve status and describe site access failure', async () => {
  for (const status of [401, 403]) {
    const denied = () => new Response('<html>blocked</html>', { status, headers: { 'content-type': 'text/html' } });
    const config = installModelAssetFetch(BASE, { install: false, fetchImpl: denied });
    await assert.rejects(config.fetch(new URL('Xenova/whisper-small/config.json', BASE)), error =>
      error.message.startsWith('MODEL_ASSET_FAILED:') && error.message.includes(`HTTP ${status}`) && error.message.includes('网站资源访问被拒绝'));
    const manifest = fixture();
    manifest.replies.set(`${MODEL_URL}.manifest.json`, denied);
    await assert.rejects(manifest.adapter.fetch(MODEL_URL), new RegExp(`网站资源访问被拒绝.*HTTP ${status}`));
    const part = fixture();
    part.replies.set(new URL(part.manifest.parts[0].file, new URL('./', MODEL_URL)).href, denied);
    const response = await part.adapter.fetch(MODEL_URL);
    await assert.rejects(response.arrayBuffer(), new RegExp(`网站资源访问被拒绝.*HTTP ${status}`));
    assert.equal(part.calls.length, 2, 'a denied part stops remaining downloads');
  }
});

test('required configuration HTTP failures are rejected before library parsing', async () => {
  for (const status of [404, 503]) {
    const adapter = installModelAssetFetch(BASE, { install: false, fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(adapter.fetch(new URL('Xenova/whisper-tiny/config.json', BASE)), new RegExp(`HTTP ${status}`));
  }
});

test('supported model endpoint rejects all non-GET methods without any network request', async () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    await assert.rejects(f.adapter.fetch(MODEL_URL, { method }), /MODEL_ASSET_FAILED/);
  }
  await assert.rejects(f.adapter.fetch(new Request(MODEL_URL, { method: 'POST', body: 'never sent' })), /MODEL_ASSET_FAILED/);
  assert.equal(f.calls.length, 0);
});

test('unexpected model names and URL modifiers are rejected without fetch', async () => {
  const f = fixture();
  for (const url of [
    new URL('Xenova/whisper-large/onnx/encoder_model_quantized.onnx', BASE),
    new URL('Xenova/whisper-base/onnx/encoder_model_quantized.onnx', BASE),
    new URL('Xenova/whisper-tiny/onnx/encoder_model_q4f16.onnx', BASE),
    new URL('Xenova/whisper-tiny/onnx/decoder_model_merged_q4f16.onnx', BASE),
    new URL('Xenova/whisper-small/onnx/encoder_model_quantized.onnx', BASE),
    new URL('Xenova/whisper-small/onnx/decoder_model_merged_quantized.onnx', BASE),
    new URL('Xenova/whisper-tiny/onnx/unexpected.onnx', BASE),
    `${MODEL_URL}?source=external`,
    `${MODEL_URL}#unexpected`,
  ]) await assert.rejects(f.adapter.fetch(url), /MODEL_ASSET_FAILED/);
  assert.equal(f.calls.length, 0);
});

test('malicious part paths, wrong sequence, duplicate parts and oversized parts are refused', async () => {
  for (const partFile of ['https://evil.example/model.bin', '../secret', '/model.bin', 'part.bin?query=1',
    'encoder_model_quantized.onnx.part-1.bin', 'encoder_model_quantized.onnx.part-0.bin#hash']) {
    const f = fixture();
    f.manifest.parts[0].file = partFile;
    await assert.rejects(f.adapter.fetch(MODEL_URL), /MODEL_ASSET_FAILED/);
    assert.equal(f.calls.length, 1);
  }
  const oversized = fixture();
  oversized.manifest.parts[0].bytes = PART_BYTES + 1;
  oversized.manifest.bytes = oversized.manifest.parts.reduce((sum, p) => sum + p.bytes, 0);
  await assert.rejects(oversized.adapter.fetch(MODEL_URL), /MODEL_ASSET_FAILED/);
  const duplicate = fixture();
  duplicate.manifest.parts[1].file = duplicate.manifest.parts[0].file;
  await assert.rejects(duplicate.adapter.fetch(MODEL_URL), /MODEL_ASSET_FAILED/);
});

test('manifest requires correct version, safe lengths, total length and SHA256 values', async () => {
  for (const mutate of [
    m => { m.version = 2; },
    m => { m.bytes = 1.5; },
    m => { m.bytes = 0; },
    m => { m.bytes += 1; },
    m => { m.bytes = 513 * 1024 * 1024; },
    m => { m.sha256 = 'not-a-hash'; },
    m => { m.parts = []; },
    m => { m.parts[0].bytes = 0; },
    m => { m.parts[0].sha256 = ''; },
  ]) {
    const f = fixture();
    mutate(f.manifest);
    await assert.rejects(f.adapter.fetch(MODEL_URL), /MODEL_ASSET_FAILED/);
    assert.equal(f.calls.length, 1);
  }
});

test('truncated parts, damaged bytes, HTML and mismatched whole model hash fail safely', async () => {
  for (const problem of ['truncated', 'damaged', 'html', 'whole-hash']) {
    const f = fixture();
    const partUrl = new URL(f.manifest.parts[0].file, new URL('./', MODEL_URL)).href;
    if (problem === 'truncated') f.replies.set(partUrl, () => new Response(f.chunks[0].slice(1)));
    if (problem === 'damaged') f.replies.set(partUrl, () => new Response(Uint8Array.from([1, 2, 3])));
    if (problem === 'html') f.replies.set(partUrl, () => new Response(f.chunks[0], { headers: { 'content-type': 'text/html' } }));
    if (problem === 'whole-hash') f.manifest.sha256 = '0'.repeat(64);
    const response = await f.adapter.fetch(MODEL_URL);
    await assert.rejects(response.arrayBuffer(), /MODEL_ASSET_FAILED/);
  }
});

test('HTTP errors, network failures, malformed JSON and HTML manifests fail safely', async () => {
  for (const reply of [
    () => new Response('missing', { status: 404 }),
    () => new Response('upstream', { status: 503 }),
    () => { throw new TypeError('fetch failed'); },
    () => new Response('<!doctype html><html>SPA fallback</html>'),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => new Response('invalid JSON'),
  ]) {
    const f = fixture();
    f.replies.set(`${MODEL_URL}.manifest.json`, reply);
    await assert.rejects(f.adapter.fetch(MODEL_URL), /MODEL_ASSET_FAILED/);
  }
  const f = fixture();
  f.replies.set(new URL(f.manifest.parts[0].file, new URL('./', MODEL_URL)).href, () => new Response('', { status: 502 }));
  const response = await f.adapter.fetch(MODEL_URL);
  await assert.rejects(response.arrayBuffer(), /MODEL_ASSET_FAILED/);
});

function trackAbortListeners(signal) {
  const listeners = new Set();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.add(listener);
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.delete(listener);
    return remove(type, listener, options);
  };
  return listeners;
}

function holdFirstPart(f) {
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  let aborted = 0;
  const partUrl = new URL(f.manifest.parts[0].file, new URL('./', MODEL_URL)).href;
  f.replies.set(partUrl, (_url, { signal }) => new Promise((_resolve, reject) => {
    announce(signal);
    const stop = () => { aborted++; reject(signal.reason); };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }));
  return { started, get aborted() { return aborted; } };
}

test('cancelling the response aborts a pending part fetch and stops later downloads', async () => {
  for (const withCallerSignal of [false, true]) {
    const f = fixture();
    const pending = holdFirstPart(f);
    const caller = new AbortController();
    const listeners = trackAbortListeners(caller.signal);
    const response = await f.adapter.fetch(MODEL_URL, withCallerSignal ? { signal: caller.signal } : undefined);
    const reader = response.body.getReader();
    const read = reader.read();
    const partSignal = await pending.started;
    await reader.cancel('stopped by user');
    assert.equal(partSignal.aborted, true);
    assert.equal(partSignal.reason, 'stopped by user');
    assert.equal(pending.aborted, 1);
    assert.deepEqual(await read, { done: true, value: undefined });
    assert.equal(f.calls.length, 2, 'only the manifest and first part were requested');
    assert.equal(caller.signal.aborted, false, 'cancelling this response must not cancel other caller operations');
    assert.equal(listeners.size, 0);
  }
});

test('init and Request abort signals interrupt in-flight model downloads', async () => {
  for (const requestSignal of [false, true]) {
    const f = fixture();
    const pending = holdFirstPart(f);
    const caller = new AbortController();
    const response = requestSignal
      ? await f.adapter.fetch(new Request(MODEL_URL, { signal: caller.signal }))
      : await f.adapter.fetch(MODEL_URL, { signal: caller.signal });
    const partSignal = await pending.started;
    const read = response.arrayBuffer();
    const rejected = assert.rejects(read, /MODEL_ASSET_FAILED/);
    const reason = new Error('caller stopped downloading');
    caller.abort(reason);
    await rejected;
    assert.equal(partSignal.aborted, true);
    assert.equal(partSignal.reason, reason);
    assert.equal(pending.aborted, 1);
    assert.equal(f.calls.length, 2);
  }
});

test('already-aborted requests do not download a manifest or register a listener', async () => {
  const f = fixture();
  const caller = new AbortController();
  caller.abort();
  const listeners = trackAbortListeners(caller.signal);
  await assert.rejects(f.adapter.fetch(MODEL_URL, { signal: caller.signal }), /MODEL_ASSET_FAILED/);
  assert.equal(f.calls.length, 0);
  assert.equal(listeners.size, 0);
});

test('failed manifests and part integrity checks remove caller abort listeners', async () => {
  for (const failure of ['manifest', 'part']) {
    const f = fixture();
    const caller = new AbortController();
    const listeners = trackAbortListeners(caller.signal);
    if (failure === 'manifest') f.replies.set(`${MODEL_URL}.manifest.json`, () => new Response('invalid JSON'));
    else f.replies.set(new URL(f.manifest.parts[0].file, new URL('./', MODEL_URL)).href,
      () => new Response(Uint8Array.from([1, 2, 3])));
    await assert.rejects(async () => {
      const response = await f.adapter.fetch(MODEL_URL, { signal: caller.signal });
      await response.arrayBuffer();
    }, /MODEL_ASSET_FAILED/);
    assert.equal(listeners.size, 0);
    assert.equal(f.calls[0].init.signal.aborted, true);
    assert.equal(caller.signal.aborted, false);
  }
});

test('allocation and response construction failures abort setup and detach caller listeners', async () => {
  for (const failure of ['allocation', 'response']) {
    const f = fixture();
    const caller = new AbortController();
    const listeners = trackAbortListeners(caller.signal);
    const original = { Uint8Array: globalThis.Uint8Array, Response: globalThis.Response };
    const setupError = new RangeError(`simulated ${failure} failure`);
    // Keep the manifest response native; only the assembled model's setup fails.
    const manifestResponse = new Response(JSON.stringify(f.manifest));
    f.replies.set(`${MODEL_URL}.manifest.json`, () => manifestResponse);
    let injected = 0;
    if (failure === 'allocation') {
      globalThis.Uint8Array = new Proxy(original.Uint8Array, {
        construct(target, args, newTarget) {
          if (args[0] === f.bytes.length) { injected++; throw setupError; }
          return Reflect.construct(target, args, newTarget);
        },
      });
    } else {
      globalThis.Response = new Proxy(original.Response, {
        construct(target, args, newTarget) {
          if (args[0] instanceof ReadableStream) { injected++; throw setupError; }
          return Reflect.construct(target, args, newTarget);
        },
      });
    }
    try {
      await assert.rejects(f.adapter.fetch(MODEL_URL, { signal: caller.signal }), error =>
        error.message.startsWith('MODEL_ASSET_FAILED:') && error.cause === setupError);
      assert.equal(injected, 1);
      assert.equal(listeners.size, 0);
      assert.equal(f.calls[0].init.signal.aborted, true);
      assert.equal(caller.signal.aborted, false);
      assert.equal(f.calls.length, 1, 'failed setup cannot start a model part download');
    } finally { Object.assign(globalThis, original); }
  }
});

test('successful downloads remove caller abort listeners and installation can restore global fetch', async () => {
  const f = fixture();
  const controller = new AbortController();
  const listeners = trackAbortListeners(controller.signal);
  const response = await f.adapter.fetch(MODEL_URL, { signal: controller.signal });
  await response.arrayBuffer();
  assert(f.calls.every(call => call.init.signal === f.calls[0].init.signal));
  assert.equal(listeners.size, 0);
  controller.abort();
  assert.equal(f.calls[0].init.signal.aborted, false, 'completed downloads detach from caller cancellation');
  const previous = globalThis.fetch;
  const installed = installModelAssetFetch(BASE, { fetchImpl: previous.bind(globalThis) });
  assert.equal(globalThis.fetch, installed.fetch);
  installed.restore();
  assert.equal(globalThis.fetch, previous);
});

test('cross-origin model root is rejected when a page origin is present', () => {
  const previous = globalThis.location;
  globalThis.location = { href: 'https://app.example/', origin: 'https://app.example' };
  try {
    assert.throws(() => installModelAssetFetch(BASE, { install: false }), /MODEL_ASSET_FAILED/);
    assert.throws(() => installModelAssetFetch('file:///models/', { install: false }), /MODEL_ASSET_FAILED/);
    assert.throws(() => installModelAssetFetch('https://app.example/models/?x=1', { install: false }), /MODEL_ASSET_FAILED/);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('build prepares real-sized split chunks, safe manifests and copied JSON with no network', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tingxie-model-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDir = path.join(directory, 'cache');
  const publicDir = path.join(directory, 'public');
  const modelId = 'Xenova/whisper-tiny';
  const largeModel = Buffer.alloc(PART_BYTES + 239, 0x08);
  largeModel[PART_BYTES] = 0xab;
  await mkdir(path.join(cacheDir, modelId, 'onnx'), { recursive: true });
  for (const filename of MODEL_FILES) await writeFile(path.join(cacheDir, modelId, filename),
    filename.endsWith('.json') ? '{"fixture":true}\n' : filename.includes('encoder') ? largeModel : Buffer.alloc(2048, 0x09));
  const results = await prepareModelAssets({
    cacheDir, publicDir, modelIds: [modelId],
    fetchImpl: () => { throw new Error('Existing model cache must not contact network'); },
  });
  assert.equal(results.length, 1);
  assert.equal(await readFile(path.join(publicDir, modelId, 'config.json'), 'utf8'), '{"fixture":true}\n');
  const manifest = JSON.parse(await readFile(path.join(publicDir, modelId, 'onnx/encoder_model_quantized.onnx.manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.bytes, largeModel.length);
  assert.equal(manifest.sha256, hash(largeModel));
  assert.deepEqual(manifest.parts.map(p => p.bytes), [PART_BYTES, 239]);
  const partBytes = await Promise.all(manifest.parts.map(async part => {
    const bytes = await readFile(path.join(publicDir, modelId, 'onnx', part.file));
    assert.equal(bytes.length, part.bytes);
    assert.equal(hash(bytes), part.sha256);
    return bytes;
  }));
  assert.deepEqual(Buffer.concat(partBytes), largeModel);
  assert((await readdir(path.join(publicDir, modelId, 'onnx'))).every(name => !name.endsWith('.onnx')));
  assert((await readdir(publicDir)).every(name => !name.startsWith('.prepare-')));
});

test('build supports Small and downloads only missing assets from the official model URL', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tingxie-model-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDir = path.join(directory, 'cache');
  const publicDir = path.join(directory, 'public');
  const obsoleteBase = path.join(publicDir, 'Xenova/whisper-base');
  const smallOnnxDir = path.join(publicDir, 'Xenova/whisper-small/onnx');
  await mkdir(obsoleteBase, { recursive: true });
  await writeFile(path.join(obsoleteBase, 'config.json'), '{"obsolete":true}');
  await mkdir(smallOnnxDir, { recursive: true });
  await writeFile(path.join(smallOnnxDir, 'encoder_model_quantized.onnx.part-0.bin'), 'old q8');
  await writeFile(path.join(smallOnnxDir, 'decoder_model_merged_quantized.onnx.manifest.json'), '{}');
  const urls = [];
  await prepareModelAssets({ cacheDir, publicDir, modelIds: ['Xenova/whisper-small'], fetchImpl: async url => {
    urls.push(url);
    return new Response(url.endsWith('.json') ? '{"fixture":true}' : Buffer.alloc(1024, 0x08));
  } });
  const smallFiles = getModelFiles('Xenova/whisper-small');
  assert.deepEqual(smallFiles.filter(file => file.endsWith('.onnx')), [
    'onnx/encoder_model_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx',
  ]);
  assert.deepEqual(urls, smallFiles.map(file => `https://huggingface.co/Xenova/whisper-small/resolve/main/${file}`));
  await assert.rejects(readdir(obsoleteBase), { code: 'ENOENT' });
  const smallOnnxFiles = await readdir(smallOnnxDir);
  assert.ok(smallOnnxFiles.length > 0);
  assert.ok(smallOnnxFiles.every(file => file.includes('_q4f16.onnx.')), 'old Small q8 assets are removed');
  await prepareModelAssets({ cacheDir, publicDir, modelIds: ['Xenova/whisper-small'], fetchImpl: () => { throw new Error('cached'); } });
  assert.equal(urls.length, 7);
});
