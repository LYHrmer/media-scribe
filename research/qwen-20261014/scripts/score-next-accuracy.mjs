#!/usr/bin/env node
// Post-inference only. Never imports a model, opens PCM, or starts inference.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreTranscript } from '../../../scripts/benchmarks/score-transcripts.mjs';

const LEGACY_PATH = fileURLToPath(new URL('../../../scripts/benchmarks/score-transcripts.mjs', import.meta.url));
const LEGACY_SHA = '3354f77301683386381df60cf898a69d59a51d266bad11eb7718dbf791f3f731';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inputKeys = ['id', 'language', 'pcm_path', 'pcm_sha256', 'sample_rate', 'audio_seconds', 'split'];

// Exact existing normalization. No synonym, phonetic, filler, number, or grammar repair.
export function charTokens(text) {
  return [...String(text).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')];
}
export function wordTokens(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\p{P}]/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

export function editCounts(reference, hypothesis) {
  const n = reference.length, m = hypothesis.length;
  assert((n + 1) * (m + 1) <= 25_000_000, 'Alignment is too large; report scoring failure, never silently truncate');
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
      dp[i - 1][j - 1] + Number(reference[i - 1] !== hypothesis[j - 1]));
  }
  let i = n, j = m, substitutions = 0, deletions = 0, insertions = 0, matches = 0;
  // Multiple minimum-cost alignments may exist. Stable tie order: diagonal, deletion, insertion.
  while (i || j) {
    if (i && j && dp[i][j] === dp[i - 1][j - 1] + Number(reference[i - 1] !== hypothesis[j - 1])) {
      if (reference[i - 1] === hypothesis[j - 1]) matches++; else substitutions++;
      i--; j--;
    } else if (i && dp[i][j] === dp[i - 1][j] + 1) { deletions++; i--; }
    else { assert(j && dp[i][j] === dp[i][j - 1] + 1); insertions++; j--; }
  }
  const errors = substitutions + deletions + insertions;
  assert.equal(errors, dp[n][m]);
  assert.equal(matches + substitutions + deletions, n);
  assert.equal(matches + substitutions + insertions, m);
  return { reference_tokens: n, hypothesis_tokens: m, matches, substitutions, deletions, insertions, errors, rate: n ? errors / n : null };
}

export function lexicalScore(reference, text, language) {
  assert.equal(typeof reference, 'string'); assert.equal(typeof text, 'string');
  assert(['chinese', 'english'].includes(language));
  const tokenize = language === 'english' ? wordTokens : charTokens;
  const score = editCounts(tokenize(reference), tokenize(text));
  const legacy = scoreTranscript(reference, text, language);
  assert.equal(score.errors, language === 'english' ? legacy.word_errors : legacy.character_errors, 'S/D/I must match existing scorer distance');
  assert.equal(score.reference_tokens, language === 'english' ? legacy.reference_word_count : legacy.reference_character_count);
  assert.equal(score.rate, language === 'english' ? legacy.wer : legacy.cer);
  return { metric: language === 'english' ? 'WER' : 'CER', ...score };
}

export function summarize(rows, runComplete) {
  const completed = rows.filter(row => row.status === 'complete');
  const sum = key => completed.reduce((n, row) => n + row.score[key], 0);
  const errors = sum('errors'), denominator = sum('reference_tokens');
  assert.equal(errors, sum('substitutions') + sum('deletions') + sum('insertions'));
  const speakers = new Map();
  for (const row of completed) {
    const value = speakers.get(row.participant_id) || { errors: 0, reference_tokens: 0 };
    value.errors += row.score.errors; value.reference_tokens += row.score.reference_tokens;
    speakers.set(row.participant_id, value);
  }
  const rates = [...speakers.values()].filter(s => s.reference_tokens).map(s => s.errors / s.reference_tokens);
  const complete = rows.length > 0 && runComplete && completed.length === rows.length;
  const observed = { errors, reference_tokens: denominator, substitutions: sum('substitutions'), deletions: sum('deletions'), insertions: sum('insertions'),
    weighted_rate: denominator ? errors / denominator : null,
    speaker_mean_rate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    scored_speakers: speakers.size };
  return { status: rows.length ? (complete ? 'complete' : 'incomplete') : 'not_applicable', expected_cases: rows.length,
    completed_cases: completed.length, failed_or_missing_cases: rows.length - completed.length,
    expected_speakers: new Set(rows.map(r => r.participant_id)).size,
    weighted_rate: complete ? observed.weighted_rate : null, speaker_mean_rate: complete ? observed.speaker_mean_rate : null,
    full_set_errors: complete ? observed.errors : null, full_set_reference_tokens: complete ? observed.reference_tokens : null,
    completed_subset_only: observed };
}

function assertInput(input) {
  assert.deepEqual(Object.keys(input), ['cases'], 'Inference manifest top level must contain only cases');
  assert(Array.isArray(input.cases) && input.cases.length > 0);
  for (const c of input.cases) {
    assert.deepEqual(Object.keys(c).filter(k => k !== 'duration_seconds').sort(), [...inputKeys].sort(), `Unexpected inference keys: ${c.id}`);
    assert(path.isAbsolute(c.pcm_path)); assert.equal(c.sample_rate, 16000);
    assert(/^[a-f0-9]{64}$/.test(c.pcm_sha256));
    assert(Number.isFinite(c.audio_seconds) && c.audio_seconds > 0);
    if ('duration_seconds' in c) assert.equal(c.duration_seconds, c.audio_seconds);
    assert(['development', 'holdout'].includes(c.split)); assert(['english', 'chinese'].includes(c.language));
  }
  assert.equal(new Set(input.cases.map(c => c.id)).size, input.cases.length, 'Duplicate inference IDs');
}

function completion(result, format, runnerExitCode, allowIncomplete) {
  const embeddedExitCode = result.worker_returncode ?? null;
  assert(embeddedExitCode == null || Number.isInteger(embeddedExitCode), 'Embedded worker_returncode must be an integer');
  if (embeddedExitCode != null && runnerExitCode != null) {
    assert.equal(runnerExitCode, embeddedExitCode, 'Observed CLI exit code conflicts with embedded worker_returncode');
  }
  const effectiveExitCode = embeddedExitCode ?? runnerExitCode;
  const exitSuccessful = effectiveExitCode == null || effectiveExitCode === 0;
  const exitEvidence = { embedded_worker_returncode: embeddedExitCode, observed_runner_exit_code: runnerExitCode,
    effective_exit_code: effectiveExitCode };
  if (format === 'assembled') {
    assert(['complete', 'failed'].includes(result.status) && result.assembly_provenance, 'Assembled result requires completion and source provenance');
    assert(result.cases.every(row => row.source_inference?.source_result_sha256), 'Each assembled row needs its original inference artifact hash');
    return { source: 'assembled inference records with per-case source artifact hashes', terminal: true,
      ...exitEvidence, successful: result.status === 'complete' && exitSuccessful };
  }
  if (format === 'native') {
    assert(['complete', 'failed', ...(allowIncomplete ? ['running'] : [])].includes(result.status), 'Native result is not terminal; wait for completion');
    return { source: 'native terminal status and available process exit evidence', terminal: result.status !== 'running',
      ...exitEvidence, successful: result.status === 'complete' && exitSuccessful };
  }
  if (format === 'compiled-worker') {
    assert(typeof result.completed_at === 'string' || allowIncomplete, 'Compiled result lacks completed_at; wait for completion');
    return { source: 'compiled Worker completed_at', terminal: !!result.completed_at,
      ...exitEvidence, successful: !!result.completed_at && exitSuccessful };
  }
  assert.equal(format, 'sensevoice');
  assert(runnerExitCode != null, 'SenseVoice has no terminal marker: provide the observed --runner-exit-code');
  assert(typeof result.model_sha256 === 'string' && typeof result.runtime_sha256 === 'string' && result.fingerprints && Array.isArray(result.requests));
  return { source: 'SenseVoice final-only file plus observed runner exit code', terminal: true, ...exitEvidence, successful: exitSuccessful };
}

export function scoreRun(input, references, result, { format, runnerExitCode = null, allowIncomplete = false } = {}) {
  assertInput(input);
  assert(Array.isArray(references.cases));
  assert.equal(new Set(references.cases.map(c => c.id)).size, references.cases.length, 'Duplicate scorer IDs');
  const referenceById = new Map(references.cases.map(c => [c.id, c]));
  const expectedById = new Map(input.cases.map(c => [c.id, c]));
  const state = completion(result, format, runnerExitCode, allowIncomplete);
  assert(Array.isArray(result.cases));
  assert.equal(new Set(result.cases.map(c => c.id)).size, result.cases.length, 'Duplicate result IDs');
  for (const row of result.cases) {
    assert(expectedById.has(row.id), `Result ID outside inference scope: ${row.id}`);
    assert(!('reference' in row) && !('reference_raw' in row), 'Reference-bearing result is not blind inference');
  }
  const resultById = new Map(result.cases.map(c => [c.id, c]));
  const rows = input.cases.map(c => {
    const ref = referenceById.get(c.id); assert(ref, `Missing scorer reference: ${c.id}`);
    assert.equal(ref.language, c.language); assert.equal(ref.split, c.split);
    assert.equal(sha(ref.reference), ref.reference_sha256, `Reference SHA mismatch: ${c.id}`);
    const matched = c.id.match(/^meli-.*?([fm]\d{2}[a-z])-(en|zh)$/i); assert(matched, `Not a known MELI case ID: ${c.id}`);
    assert.equal(matched[2], c.language === 'english' ? 'en' : 'zh');
    const base = { id: c.id, participant_id: matched[1].toUpperCase(), split: c.split, language: c.language,
      pcm_sha256: c.pcm_sha256, reference_sha256: ref.reference_sha256, audio_seconds: c.audio_seconds,
      punctuation: { status: 'not_applicable', reason: 'MELI references do not supply reliable ordinary punctuation gold' } };
    const row = resultById.get(c.id);
    if (!row) return { ...base, status: 'missing', score: null };
    const generation = Object.fromEntries(['truncated', 'generation_at_requested_limit', 'generated_token_count',
      'eos_seen', 'last_token_is_eos', 'official_processing_changed_text', 'text_policy']
      .filter(k => k in row).map(k => [k, row[k]]));
    if (Object.keys(generation).length) base.generation_diagnostics = generation;
    assert.equal(row.pcm_sha256, c.pcm_sha256, `Result PCM SHA mismatch: ${c.id}`);
    if (row.language != null) assert.equal(row.language, c.language);
    if (row.split != null) assert.equal(row.split, c.split);
    if (row.error || (row.status != null && row.status !== 'complete')) {
      return { ...base, status: ['pending', 'running'].includes(row.status) ? 'incomplete' : 'error', source_status: row.status ?? 'error', error: row.error ?? null, score: null };
    }
    const text = ['native', 'assembled'].includes(format) ? row.text : format === 'compiled-worker' ? row.output?.text : row.result?.text;
    if (typeof text !== 'string') return { ...base, status: 'invalid_output', error: 'Successful string transcript is missing', score: null };
    return { ...base, status: 'complete', text, score: lexicalScore(ref.reference, text, c.language) };
  });
  const runComplete = state.successful && rows.every(r => r.status === 'complete');
  const groups = [];
  for (const split of ['development', 'holdout']) for (const language of ['chinese', 'english']) {
    groups.push({ split, language, metric: language === 'chinese' ? 'CER' : 'WER',
      ...summarize(rows.filter(r => r.split === split && r.language === language), state.successful) });
  }
  return { schema_version: 1, status: runComplete ? 'complete' : 'incomplete', completion_evidence: state,
    observed_runner_exit_code: runnerExitCode, expected_cases: rows.length, completed_cases: rows.filter(r => r.status === 'complete').length,
    policy: { reference_use: 'post-inference scorer only', normalization: 'Exact current score-transcripts.mjs NFKC/lowercase/punctuation-whitespace rules',
      edit_alignment_tie_order: 'diagonal then deletion then insertion; total distance equals legacy scorer; S/D/I ties are not unique',
      weighting: 'Weighted=sum errors/sum reference units. Speaker mean=mean of per-speaker error/reference totals within each split and language.',
      incomplete_runs: 'No full-set CER/WER for failed, missing or nonterminal data; successful-subset figures explicitly separated.',
      truncation: 'Completed token-limit outputs are scored as generated, including repetitions and missing tails; truncated flags are retained and never used to exclude cases.',
      cross_language: 'Chinese CER and English WER are never pooled into one overall error rate.', punctuation: 'N/A for MELI' },
    groups, cases: rows };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (name === '--allow-incomplete') { args[name] = true; continue; }
    assert(['--input', '--scorer', '--results', '--output', '--result-format', '--runner-exit-code'].includes(name), `Unknown argument ${name}`);
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value for ${name}`);
    assert(!(name in args), `Duplicate argument ${name}`); args[name] = process.argv[++i];
  }
  for (const key of ['--input', '--scorer', '--results', '--output', '--result-format']) assert(args[key], `Required ${key}`);
  assert(['native', 'compiled-worker', 'sensevoice', 'assembled'].includes(args['--result-format']));
  const exitCode = args['--runner-exit-code'] == null ? null : Number(args['--runner-exit-code']);
  assert(exitCode == null || Number.isInteger(exitCode));
  const paths = ['--input', '--scorer', '--results'].map(k => path.resolve(args[k]));
  const destination = path.resolve(args['--output']); assert(!paths.includes(destination), 'Output cannot overwrite input/reference/results');
  const bytes = await Promise.all(paths.map(p => fs.readFile(p)));
  const [input, references, results] = bytes.map(b => JSON.parse(b));
  const legacyBytes = await fs.readFile(LEGACY_PATH); assert.equal(sha(legacyBytes), LEGACY_SHA, 'Legacy scoring source changed: review normalization before scoring');
  const expectedInputSHA = results.input_manifest_sha256 ?? results.fingerprint?.input_manifest_sha256;
  if (expectedInputSHA) assert.equal(expectedInputSHA, sha(bytes[0]), 'Results belong to a different input manifest');
  const report = scoreRun(input, references, results, { format: args['--result-format'], runnerExitCode: exitCode, allowIncomplete: !!args['--allow-incomplete'] });
  report.provenance = { input_manifest_sha256: sha(bytes[0]), scorer_manifest_sha256: sha(bytes[1]), inference_results_sha256: sha(bytes[2]),
    scoring_script_sha256: sha(await fs.readFile(fileURLToPath(import.meta.url))), legacy_scorer_sha256: LEGACY_SHA };
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: destination, status: report.status, expected_cases: report.expected_cases, completed_cases: report.completed_cases, groups: report.groups }, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Scoring failed:', error.message); process.exitCode = 1; });
}
