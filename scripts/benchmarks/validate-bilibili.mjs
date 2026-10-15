// Real public media requests, the production importer, and full FFmpeg decode.
// Output contains public source pages and hashes, never signed CDN URLs.
// Usage: node scripts/benchmarks/validate-bilibili.mjs MANIFEST OUTPUT_DIR [HTTPS_ENDPOINT]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { importMediaUrl } from '../../src/media-url.js';
import { handleBilibili } from '../../server/bilibili.js';

const [manifestPath, outputPath, remoteEndpoint] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw Error('Expected MANIFEST OUTPUT_DIR [HTTPS_ENDPOINT]; requires Node >= 20 and ffmpeg/ffprobe.');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const output = path.resolve(outputPath); await mkdir(output, { recursive: true });
const endpoint = remoteEndpoint || 'https://local-validation.invalid/api/bilibili';
if (new URL(endpoint).protocol !== 'https:') throw Error('Endpoint must use HTTPS');
const report = { date: new Date().toISOString(), app_version: '0.5.7',
  scope: remoteEndpoint ? 'Production importer + deployed HTTP endpoint + complete FFmpeg decode in Node; not browser QA.'
    : 'Production importer + in-process production HTTP handler + real upstream fetch + complete FFmpeg decode; not a deployed or browser test.',
  cookies: false, samples: [] };
const fetchImpl = (url, options) => {
  const request = new Request(url, { ...options, headers: { ...options.headers, Origin: 'https://lyhrmer.github.io' } });
  return remoteEndpoint ? fetch(request) : handleBilibili(request);
};
for (const item of manifest.samples) {
  if (!/^sample-[0-9]+$/.test(item.id)) throw Error('Invalid sample identifier');
  const started = performance.now(), row = { id: item.id, source_url: item.source_url };
  try {
    const file = await importMediaUrl(item.source_url, { bilibiliService: endpoint, fetchImpl });
    const bytes = new Uint8Array(await file.arrayBuffer()), target = path.join(output, item.id + '.m4a');
    await writeFile(target, bytes);
    row.bytes = bytes.length; row.sha256 = createHash('sha256').update(bytes).digest('hex'); row.filename = file.name;
    row.probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,sample_rate,channels', '-of', 'json', target], { encoding: 'utf8', timeout: 20000 }));
    execFileSync('ffmpeg', ['-v', 'error', '-i', target, '-f', 'null', '-'], { timeout: 120000, stdio: 'pipe' });
    row.result = 'decoded';
  } catch (error) { row.result = 'failed'; row.error = String(error.message).slice(0, 400); }
  row.seconds = (performance.now() - started) / 1000;
  report.samples.push(row);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ id: row.id, result: row.result, bytes: row.bytes, error: row.error }));
}
if (report.samples.some(s => s.result !== 'decoded')) process.exitCode = 1;
