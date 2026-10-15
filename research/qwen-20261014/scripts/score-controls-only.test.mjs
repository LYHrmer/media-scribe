import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scoreControls, controlCompletion } from './score-controls-only.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');
function fixture() {
  const ids = ['zh-clean', 'en-jfk', 'zh-fast', 'zh-noisy-digits', 'en-noisy-dialogue', 'silence', 'noise', 'user-lyrics'];
  const input = { cases: ids.map(id => ({ id, language: id.startsWith('en-') ? 'english' : 'chinese', pcm_path: `/fake/${id}.f32`, pcm_sha256: sha(id), sample_rate: 16000, audio_seconds: 5, split: id === 'user-lyrics' ? 'previously-seen-private-development' : 'development-control' })) };
  const scorer = { cases: input.cases.map(c => ({ ...c, reference: ['silence', 'noise'].includes(c.id) ? '' : 'a' })) };
  const candidate = { status: 'complete', worker_returncode: 0, cases: scorer.cases.map(c => ({ id: c.id, language: c.language, pcm_sha256: c.pcm_sha256, status: 'complete', text: c.reference })) };
  const baseline = { status: 'complete', assembly_provenance: {}, cases: candidate.cases.map(c => ({ ...c, source_inference: { source_result_sha256: sha('source') } })) };
  return { input, scorer, candidate, baseline };
}
test('Known-empty controls use false positives, never an invented zero denominator CER', () => {
  const f = fixture(); f.candidate.cases.find(c => c.id === 'noise').text = 'invented words';
  const r = scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 0 });
  assert.equal(r.negative_controls.candidate_false_positives, 1);
  assert.equal(r.negative_controls.baseline_false_positives, 0);
  assert.equal(r.cases.find(c => c.id === 'noise').candidate.score, null);
  assert.equal(r.cases.find(c => c.id === 'silence').candidate.rate, null);
  assert.equal(r.speech_summaries.reduce((n, g) => n + g.expected_cases, 0), 6);
  assert.equal(r.speech_summaries.find(g => g.split === 'previously-seen-private-development').expected_cases, 1);
});
test('Truncated repeated text is retained and scored, official processed alternative is ignored', () => {
  const f = fixture(); Object.assign(f.candidate.cases.find(c => c.id === 'en-jfk'), { text: 'a a a', official_processed_text: 'a', truncated: true, generation_at_requested_limit: true });
  const r = scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 0 });
  const c = r.cases.find(c => c.id === 'en-jfk');
  assert.equal(c.candidate.score.insertions, 2); assert.equal(c.candidate.score.rate, 2);
  assert.equal(c.candidate.generation.truncated, true); assert.equal(c.outcome, 'regressed');
});
test('Failure or conflicting exit evidence blocks complete control accuracy', () => {
  assert.throws(() => controlCompletion({ status: 'complete', worker_returncode: 1 }, 0), /Conflicting/);
  assert.equal(controlCompletion({ status: 'complete', worker_returncode: 1 }, null).successful, false);
  const f = fixture(); f.candidate.worker_returncode = 1;
  const r = scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 1 });
  assert.equal(r.status, 'incomplete'); assert.equal(r.negative_controls.candidate_false_positives, null);
  assert(r.speech_summaries.every(g => g.candidate.weighted_rate === null));
  f.input.cases[0].id = 'meli-f00a-en';
  assert.throws(() => scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 1 }));
});
test('Digit equivalence is secondary and does not silently fold Traditional Chinese', () => {
  const f = fixture(); f.scorer.cases[0].reference = '9点'; f.baseline.cases[0].text = '9点';
  f.candidate.cases[0].text = '九点';
  let r = scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 0 });
  assert.equal(r.cases[0].candidate.score.rate, 0.5);
  assert.equal(r.cases[0].candidate.secondary_metrics.digit_equivalent_cer, 0);
  f.candidate.cases[0].text = '九點';
  r = scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 0 });
  assert.equal(r.cases[0].candidate.score.rate, 1);
  assert.equal(r.cases[0].candidate.secondary_metrics.digit_equivalent_cer, 0.5);
});
test('A failed baseline row cannot leave the report marked complete', () => {
  const f = fixture(); f.baseline.cases[0].status = 'error'; f.baseline.cases[0].error = 'lost baseline';
  const r = scoreControls(f.input, f.scorer, f.candidate, f.baseline, { runnerExitCode: 0 });
  assert.equal(r.status, 'incomplete');
  assert.equal(r.speech_summaries.find(g => g.language === 'chinese').candidate.weighted_rate, null);
});
