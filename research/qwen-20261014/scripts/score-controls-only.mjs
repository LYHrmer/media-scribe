#!/usr/bin/env node
// Separate post-inference control scoring. No model, media upload, or MELI pooling.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lexicalScore, charTokens } from './score-next-accuracy.mjs';
import { scoreTranscript } from '../../../scripts/benchmarks/score-transcripts.mjs';
const sha = x => createHash('sha256').update(x).digest('hex');
const IDS = ['zh-clean', 'en-jfk', 'zh-fast', 'zh-noisy-digits', 'en-noisy-dialogue', 'silence', 'noise', 'user-lyrics'];
const KEYS = ['id', 'language', 'pcm_path', 'pcm_sha256', 'sample_rate', 'audio_seconds', 'split'];
const NEGATIVES = new Set(['silence', 'noise']);
export function controlCompletion(result, runnerExitCode) {
  assert(['complete', 'failed'].includes(result.status), 'Candidate batch is not terminal');
  assert(runnerExitCode == null || Number.isInteger(runnerExitCode));
  const embedded = result.worker_returncode ?? null;
  assert(embedded == null || Number.isInteger(embedded));
  if (embedded != null && runnerExitCode != null) assert.equal(embedded, runnerExitCode, 'Conflicting embedded and observed exit codes');
  assert(embedded != null || runnerExitCode != null, 'Provide observed runner exit code if no embedded code exists');
  const code = embedded ?? runnerExitCode;
  return { embedded_worker_returncode: embedded, observed_runner_exit_code: runnerExitCode, effective_exit_code: code,
    terminal: true, successful: result.status === 'complete' && code === 0 };
}
function scoreOne(reference, row, language, id) {
  if (!row) return { status: 'missing', score: null };
  const generation = Object.fromEntries(['truncated', 'generation_at_requested_limit', 'generated_token_count', 'eos_seen',
    'last_token_is_eos', 'official_processing_changed_text', 'text_policy'].filter(k => k in row).map(k => [k, row[k]]));
  if (row.error || row.status !== 'complete') return { status: 'error', source_status: row.status, error: row.error ?? null, generation, score: null };
  assert.equal(typeof row.text, 'string', `Missing string text: ${id}`);
  const output = { status: 'complete', generation, text_sha256: sha(row.text), raw_nonempty_output: row.text.trim().length > 0,
    generated_lexical_characters: charTokens(row.text).length };
  if (NEGATIVES.has(id)) {
    assert.equal(charTokens(reference).length, 0, 'Known-empty control reference must remain empty');
    return { ...output, metric: 'false_positive_for_known_empty', false_positive: output.generated_lexical_characters > 0,
      score: null, rate: null, reason: 'No reference units: CER/WER is undefined, not 0%' };
  }
  assert(charTokens(reference).length > 0);
  if (language === 'chinese') {
    output.secondary_metrics = { digit_equivalent_cer: scoreTranscript(reference, row.text, language).digit_equivalent_cer,
      role: 'secondary_only', rule: 'Existing scorer maps 0–9 to 零一二三四五六七八九 and 幺 to 一 after ordinary normalization. No Traditional/Simplified conversion.',
      primary_cer_unchanged: true };
  }
  return { ...output, score: lexicalScore(reference, row.text, language) };
}
export function scoreControls(input, scorer, candidate, baseline, { runnerExitCode = null } = {}) {
  assert.deepEqual(Object.keys(input), ['cases']); assert.deepEqual(input.cases.map(c => c.id), IDS);
  for (const c of input.cases) { assert.deepEqual(Object.keys(c).sort(), [...KEYS].sort()); assert(path.isAbsolute(c.pcm_path)); }
  const state = controlCompletion(candidate, runnerExitCode);
  assert.equal(baseline.status, 'complete'); assert(baseline.assembly_provenance);
  assert.equal(new Set(candidate.cases.map(c => c.id)).size, candidate.cases.length);
  assert.deepEqual(baseline.cases.map(c => c.id), IDS);
  const references = new Map(scorer.cases.map(c => [c.id, c]));
  assert.equal(references.size, 8); assert.equal(scorer.cases.length, 8);
  const candidates = new Map(candidate.cases.map(c => [c.id, c]));
  const baselines = new Map(baseline.cases.map(c => [c.id, c]));
  const rows = input.cases.map(c => {
    const ref = references.get(c.id), cand = candidates.get(c.id), base = baselines.get(c.id);
    assert(ref); assert.equal(ref.pcm_sha256, c.pcm_sha256); assert.equal(ref.language, c.language);
    assert.equal(ref.split, c.split); assert.equal(base.pcm_sha256, c.pcm_sha256);
    assert(base.source_inference?.source_result_sha256);
    if (cand) { assert.equal(cand.pcm_sha256, c.pcm_sha256); assert.equal(cand.language, c.language); }
    const candidateScore = scoreOne(ref.reference, cand, c.language, c.id);
    const baselineScore = scoreOne(ref.reference, base, c.language, c.id);
    let delta = null, outcome = 'unavailable';
    if (candidateScore.status === 'complete' && baselineScore.status === 'complete') {
      if (NEGATIVES.has(c.id)) {
        delta = Number(candidateScore.false_positive) - Number(baselineScore.false_positive);
      } else delta = candidateScore.score.errors - baselineScore.score.errors;
      outcome = delta < 0 ? 'improved' : delta > 0 ? 'regressed' : 'tied';
    }
    return { id: c.id, language: c.language, split: c.split, pcm_sha256: c.pcm_sha256, reference_sha256: sha(ref.reference),
      audio_seconds: c.audio_seconds, negative_control: NEGATIVES.has(c.id), private_previously_seen: c.id === 'user-lyrics',
      baseline: baselineScore, candidate: candidateScore, error_or_false_positive_delta: delta, outcome,
      baseline_source: base.source_inference, punctuation: { status: 'not_evaluated', reason: 'This report scores lexical accuracy and negative-control emissions only.' } };
  });
  const summaries = [];
  for (const split of ['development-control', 'previously-seen-private-development']) for (const language of ['chinese', 'english']) {
    const group = rows.filter(c => c.split === split && c.language === language && !c.negative_control);
    if (!group.length) continue;
    const complete = state.successful && group.every(c => c.candidate.status === 'complete' && c.baseline.status === 'complete');
    const summarize = side => {
      const completed = group.filter(c => c[side].status === 'complete');
      const errors = completed.reduce((n, c) => n + c[side].score.errors, 0);
      const denominator = completed.reduce((n, c) => n + c[side].score.reference_tokens, 0);
      return { completed_cases: completed.length, observed_success_subset: { errors, reference_tokens: denominator, rate: denominator ? errors / denominator : null },
        full_set_errors: complete ? errors : null, full_set_reference_tokens: complete ? denominator : null, weighted_rate: complete && denominator ? errors / denominator : null };
    };
    summaries.push({ split, language, metric: language === 'english' ? 'WER' : 'CER', status: complete ? 'complete' : 'incomplete',
      expected_cases: group.length, baseline: summarize('baseline'), candidate: summarize('candidate'),
      speaker_mean_rate: null, speaker_mean_reason: 'Controls are not a verified independent speaker sample.' });
  }
  const negatives = rows.filter(c => c.negative_control);
  return { schema_version: 1, status: state.successful && rows.every(r => r.candidate.status === 'complete' && r.baseline.status === 'complete') ? 'complete' : 'incomplete',
    completion_evidence: state, cases: rows, speech_summaries: summaries,
    negative_controls: { expected_cases: 2, completed_cases: negatives.filter(c => c.candidate.status === 'complete').length,
      baseline_false_positives: negatives.every(c => c.baseline.status === 'complete') ? negatives.filter(c => c.baseline.false_positive).length : null,
      candidate_false_positives: state.successful && negatives.every(c => c.candidate.status === 'complete') ? negatives.filter(c => c.candidate.false_positive).length : null,
      cer_wer: null },
    policy: { scope: 'Exactly eight predeclared controls, no MELI. Private known lyric reported separately from public speech controls.',
      normalization: 'Same production scorer NFKC/lowercase/punctuation-whitespace rules; no number equivalence or repetition repair.',
      secondary_digits: 'Chinese speech cases also retain the existing digit_equivalent_cer as a secondary metric only; it never replaces strict CER and does not fold Traditional/Simplified characters.',
      candidate_text: 'Use result.text exactly. Official processed_text is diagnostic only. Preserve and score truncated outputs without exclusions.',
      failure: 'Missing/error/nonzero-exit cases cannot produce full-set accuracy. Successful subset counts are explicit.',
      system_difference: 'Chinese default, including silence/noise, includes VAD and punctuation; direct official/native Qwen has no VAD. Negative-control differences are system-level, not an isolated acoustic-model comparison.',
      english_baseline: 'Historical actual default Small q4f16 Worker output, cross-checked for identical PCM and text against later captures.',
      reference_limitations: 'Vendor/public developer controls and previously seen private lyrics are not new independent interview holdouts.' } };
}
async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]; assert(['--input', '--source-input', '--scorer', '--results', '--baseline', '--output', '--runner-exit-code'].includes(key)); assert(process.argv[i + 1]); assert(!(key in args)); args[key] = process.argv[i + 1]; }
  for (const k of ['--input', '--scorer', '--results', '--baseline', '--output']) assert(args[k], `Required ${k}`);
  const readKeys = ['--input', '--scorer', '--results', '--baseline']; if (args['--source-input']) readKeys.push('--source-input');
  const bytes = Object.fromEntries(await Promise.all(readKeys.map(async k => [k, await fs.readFile(path.resolve(args[k]))])));
  const documents = Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, JSON.parse(b)]));
  const result = documents['--results'];
  const expectedSHA = result.input_manifest_sha256 ?? result.fingerprint?.input_manifest_sha256;
  if (expectedSHA) {
    const sourceKey = args['--source-input'] ? '--source-input' : '--input';
    assert.equal(sha(bytes[sourceKey]), expectedSHA, 'Candidate source input manifest SHA mismatch');
    const source = documents[sourceKey]; assert.deepEqual(Object.keys(source), ['cases']);
    const sourceById = new Map(source.cases.map(c => [c.id, c]));
    assert.equal(sourceById.size, source.cases.length);
    for (const c of documents['--input'].cases) assert.deepEqual(sourceById.get(c.id), c, 'Control differs from actual source input manifest');
    assert(result.cases.every(c => sourceById.has(c.id)), 'Unknown candidate result outside source inference scope');
  }
  const code = args['--runner-exit-code'] == null ? null : Number(args['--runner-exit-code']);
  const report = scoreControls(documents['--input'], documents['--scorer'], result, documents['--baseline'], { runnerExitCode: code });
  report.provenance = Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k.slice(2).replaceAll('-', '_') + '_sha256', sha(b)]));
  report.provenance.scoring_script_sha256 = sha(await fs.readFile(fileURLToPath(import.meta.url)));
  report.provenance.lexical_scoring_script_sha256 = sha(await fs.readFile(new URL('./score-next-accuracy.mjs', import.meta.url)));
  const output = path.resolve(args['--output']); assert(!readKeys.some(k => path.resolve(args[k]) === output));
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, status: report.status, speech_summaries: report.speech_summaries, negative_controls: report.negative_controls,
    cases: report.cases.map(c => ({ id: c.id, baseline_errors: c.baseline.score?.errors ?? null, candidate_errors: c.candidate.score?.errors ?? null,
      baseline_fp: c.baseline.false_positive ?? null, candidate_fp: c.candidate.false_positive ?? null, truncated: c.candidate.generation?.truncated ?? null, outcome: c.outcome })) }, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Control scoring failed:', error.message); process.exitCode = 1; });
}
