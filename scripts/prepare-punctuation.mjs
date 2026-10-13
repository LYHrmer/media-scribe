import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const upstream = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2';
const archiveHash = 'c0d5aa5f8eeb686032345e180bedf39319dc2e0556781c6264bcadba8328a6e1';
const originalHash = '65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1';
const cache = path.resolve(process.env.PUNCTUATION_CACHE_DIR || '.cache/punctuation');
const output = path.resolve('public/models-punctuation');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Preserve every unknown protobuf field byte-for-byte. Only the input lookup
// table and its vocabulary metadata change; all transformer weights stay exact.
function varint(value) {
  const bytes = [];
  do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low + (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function* fields(bytes) {
  let cursor = 0;
  const read = () => {
    let value = 0, multiplier = 1, byte;
    do { if (cursor >= bytes.length) throw new Error('Truncated ONNX protobuf'); byte = bytes[cursor++]; value += (byte & 127) * multiplier; multiplier *= 128; } while (byte & 128);
    return value;
  };
  while (cursor < bytes.length) {
    const start = cursor, tag = read(), number = Math.floor(tag / 8), wire = tag % 8;
    let payload;
    if (wire === 0) read();
    else if (wire === 1) cursor += 8;
    else if (wire === 5) cursor += 4;
    else if (wire === 2) { const size = read(); payload = bytes.subarray(cursor, cursor + size); cursor += size; }
    else throw new Error(`Unsupported protobuf wire type: ${wire}`);
    if (cursor > bytes.length) throw new Error('Invalid ONNX protobuf length');
    yield { number, wire, payload, raw: bytes.subarray(start, cursor) };
  }
}
const binaryField = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
const stringField = (number, text) => binaryField(number, Buffer.from(text));
const rewrite = (bytes, transform) => Buffer.concat([...fields(bytes)].map(field => transform(field) ?? field.raw));
const metadata = bytes => Object.fromEntries([...fields(bytes)].filter(field => field.number === 14).map(field => {
  const entries = [...fields(field.payload)];
  return [entries.find(entry => entry.number === 1).payload.toString(), entries.find(entry => entry.number === 2).payload.toString()];
}));

await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const archive = path.join(cache, 'official.tar.bz2');
let downloaded;
try { downloaded = await readFile(archive); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(upstream, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Punctuation model download failed: HTTP ${response.status}`);
  downloaded = Buffer.from(await response.arrayBuffer());
  if (hash(downloaded) !== archiveHash) throw new Error('Punctuation archive hash mismatch');
  await writeFile(archive + '.tmp', downloaded); await rename(archive + '.tmp', archive);
}
if (hash(downloaded) !== archiveHash) throw new Error('Punctuation archive hash mismatch');
const folder = 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8';
execFileSync('tar', ['--no-same-owner', '-xjf', archive, '-C', cache, `${folder}/model.int8.onnx`]);
const original = await readFile(path.join(cache, folder, 'model.int8.onnx'));
if (hash(original) !== originalHash) throw new Error('Original punctuation ONNX hash mismatch');
const meta = metadata(original);
const tokens = meta.tokens.split('|');
if (tokens.length !== 272727) throw new Error('Unexpected original punctuation vocabulary');
const keep = tokens.flatMap((token, id) => ([...token].length === 1 || (/^[\x00-\x7f]*$/u.test(token) && token.length <= 3) || /^<.*>$/u.test(token)) ? [id] : []);
const compactTokens = keep.map(id => tokens[id]);
let changed = 0;
const compact = rewrite(original, field => {
  if (field.number === 7) return binaryField(7, rewrite(field.payload, entry => {
    if (entry.number !== 5) return;
    const parts = [...fields(entry.payload)];
    if (parts.find(part => part.number === 8)?.payload.toString() !== 'embed.weight_quantized') return;
    const weights = parts.find(part => part.number === 9)?.payload;
    if (weights?.length !== 272727 * 256) throw new Error('Unexpected embedding shape');
    const rows = Buffer.alloc(keep.length * 256);
    keep.forEach((id, index) => weights.copy(rows, index * 256, id * 256, (id + 1) * 256));
    let dimension = 0;
    changed++;
    return binaryField(5, rewrite(entry.payload, part => {
      if (part.number === 1 && dimension++ === 0) return Buffer.concat([varint(8), varint(keep.length)]);
      if (part.number === 9) return binaryField(9, rows);
    }));
  }));
  if (field.number === 14) {
    const key = [...fields(field.payload)].find(entry => entry.number === 1)?.payload.toString();
    const value = key === 'tokens' ? compactTokens.join('|') : key === 'vocab_size' ? String(keep.length) : null;
    if (value !== null) return binaryField(14, rewrite(field.payload, entry => entry.number === 2 ? stringField(2, value) : undefined));
  }
});
if (changed !== 1 || compactTokens.length !== 16292 || compact.length !== 7637864
  || hash(compact) !== '807302f35c81326bd2a0e3f0b1b99077dbd270a9776d22d0b2080bdd6b9c0dae') throw new Error('Unexpected compact punctuation model');
const tokenBytes = Buffer.from(JSON.stringify(compactTokens));
const modelName = 'model.zh-compact.int8.onnx';
await writeFile(path.join(output, modelName), compact);
await writeFile(path.join(output, 'tokens.json'), tokenBytes);
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ upstream, originalSha256: originalHash,
  model: { name: modelName, bytes: compact.length, sha256: hash(compact) },
  tokens: { name: 'tokens.json', bytes: tokenBytes.length, sha256: hash(tokenBytes) },
  punctuations: meta.punctuations.split('|'),
  note: 'All original single Unicode characters, ASCII tokens of length <= 3, and special tokens retained. Other words map to the original unknown token. Transformer parameters are unchanged.',
}, null, 2) + '\n');
console.log(`Prepared compact punctuation model: ${compact.length} bytes, ${compactTokens.length} tokens`);
