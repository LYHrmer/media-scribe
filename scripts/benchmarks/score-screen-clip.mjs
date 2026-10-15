// Score real OCR through production fusion. References stay local and are never
// passed to the OCR/ASR workers or published in the metric-only output.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fuseVideoCaptions } from '../../src/video-captions.js';
import { scoreTranscript } from './score-transcripts.mjs';
const [framesPath, ocrPath, casesPath, outputPath, baselinePath, asrPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: FRAMES_JSON OCR_JSON LOCAL_CASES_JSON OUTPUT_JSON [BASELINE_FUSED_JSON] [ASR_JSON]');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const frames = await json(framesPath), ocr = await json(ocrPath), reference = (await json(casesPath)).cases[0];
const observations = ocr.results.map(row => {
  const frame = frames.find(item => item.name === row.name);
  if (!frame) throw Error('Missing frame metadata');
  return { time: frame.time, width: frame.width, height: frame.height, texts: row.result.texts };
});
const duration = Math.ceil(Math.max(...frames.map(f => f.time)));
const fused = fuseVideoCaptions(observations, { duration, sampleInterval: .5 });
const summarize = result => ({
  score: scoreTranscript(reference.reference, result.segments.map(s => s.text).join(''), reference.language),
  subtitle_segment_count: result.segments.length,
  candidate_counts: Object.fromEntries([...new Set(result.candidates.map(c => c.category))].map(category => [category, result.candidates.filter(c => c.category === category).length])),
});
const report = {
  scope: 'Real compiled OCR + WASM; ffmpeg-extracted frames. Caption reference manually read from source video before inference. Not independent audio ground truth, browser/mobile QA, or a held-out accuracy set.',
  frame_count: frames.length, clip_duration_seconds: duration,
  source_start_seconds: Math.min(...frames.map(f => f.source_time - f.time)),
  reference_sha256: createHash('sha256').update(reference.reference).digest('hex'),
  worker: ocr.worker, wasm: ocr.wasm,
  before: baselinePath ? summarize(await json(baselinePath)) : null,
  after: summarize(fused),
  audio: asrPath ? (await json(asrPath)).cases.map(row => ({ id: row.id, pcm_sha256: row.pcm_sha256, score: row.score, seconds: row.seconds })) : [],
};
await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ before: report.before?.score.character_errors, after: report.after.score.character_errors,
  reference_characters: report.after.score.reference_character_count, audio: report.audio.map(x => x.score.character_errors) }));
