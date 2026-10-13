// Integration smoke: the actual Vite Worker and actual ORT WASM run in a browser-
// shaped VM. Transport is mapped to dist; this does not claim real-browser QA.
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';

const dist = path.resolve(process.argv[2] || 'dist');
const filename = (await readdir(path.join(dist, 'assets'))).find(name => /^punctuation\.worker-.*\.js$/u.test(name));
if (!filename) throw new Error('Build the application first: punctuation Worker is missing.');
const cache = new Map();
const fetched = [];
const cacheApi = { match: async key => cache.get(String(key))?.clone(), put: async (key, value) => cache.set(String(key), value.clone()), delete: async key => cache.delete(String(key)) };
const mappedFile = address => {
  const pathname = new URL(address).pathname;
  const offset = pathname.search(/\/(?:models-punctuation|vendor\/ort|assets)\//u);
  if (offset < 0) throw new Error(`Unexpected request: ${pathname}`);
  const filename = path.resolve(dist, pathname.slice(offset + 1));
  if (!filename.startsWith(dist + path.sep)) throw new Error('Invalid dist path');
  return filename;
};

async function workerVm() {
  let listener, resolveEvent;
  const self = { constructor: { name: 'DedicatedWorkerGlobalScope' }, location: { origin: 'https://test.invalid', href: `https://test.invalid/assets/${filename}` }, caches: { open: async () => cacheApi },
    addEventListener(type, callback) { if (type === 'message') listener = callback; },
    postMessage(event) { if (event.type === 'result' || event.type === 'error') resolveEvent(event); },
  };
  const context = vm.createContext({ self, location: self.location, caches: self.caches, crypto: webcrypto, console,
    navigator: { hardwareConcurrency: 1 }, Response, Request, Headers, URL, Blob, TextEncoder, TextDecoder,
    WebAssembly, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval, performance, ReadableStream,
    Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
    importScripts() { throw new Error('Unexpected importScripts'); },
    fetch: async request => {
      const address = String(request.url || request);
      if (address.startsWith('data:')) return fetch(address);
      fetched.push(address);
      const file = mappedFile(address);
      return new Response(await readFile(file), { headers: { 'Content-Type': file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    },
  });
  const modules = new Map();
  const load = async address => {
    if (modules.has(address)) return modules.get(address);
    const module = new vm.SourceTextModule(await readFile(mappedFile(address), 'utf8'), {
      context, identifier: address, initializeImportMeta: meta => { meta.url = address; },
      importModuleDynamically: async (specifier, ref) => {
        const imported = await load(new URL(specifier, ref.identifier).href);
        if (imported.status === 'linked') await imported.evaluate();
        return imported;
      },
    });
    modules.set(address, module);
    await module.link(async (specifier, ref) => load(new URL(specifier, ref.identifier).href));
    return module;
  };
  const entry = await load(self.location.href);
  await entry.evaluate();
  let id = 0;
  return async text => {
    const event = new Promise(resolve => { resolveEvent = resolve; });
    await listener({ data: { id: ++id, type: 'punctuate', text } });
    const result = await event;
    if (result.type === 'error') throw new Error(result.message);
    return result.text;
  };
}

const start = performance.now();
const punctuate = await workerVm();
const cases = [
  ['开放时间早上9点至下午5点', '开放时间早上9点至下午5点。'],
  ['今天下雨了出门的时候记得带伞', '今天下雨了，出门的时候记得带伞。'],
  ['请问这趟车几点出发在哪里检票', '请问这趟车几点出发，在哪里检票？'],
  ['今天下雨了出门的时候记得带伞。', '今天下雨了，出门的时候记得带伞。'],
  ['Pure English text stays unchanged.', 'Pure English text stays unchanged.'],
];
const rows = [];
for (const [input, expected] of cases) {
  const output = await punctuate(input);
  assert.equal(output, expected);
  rows.push({ input, output });
}
const coldAssetFetches = fetched.filter(url => /\/(?:tokens\.json|model\.zh-compact\.int8\.onnx)$/u.test(url)).length;
assert.equal(coldAssetFetches, 2);
const secondWorker = await workerVm();
assert.equal(await secondWorker(cases[0][0]), cases[0][1]);
assert.equal(fetched.filter(url => /\/(?:tokens\.json|model\.zh-compact\.int8\.onnx)$/u.test(url)).length, 2, 'second Worker validates and reuses Cache API model bytes');
console.log(JSON.stringify({ worker: filename, cases: rows, cacheReuse: true, elapsedSeconds: (performance.now() - start) / 1000,
  scope: 'Actual Vite Worker + ORT WASM; HTTP and Cache API simulated. No browser UI/media-decoder claim.' }, null, 2));
