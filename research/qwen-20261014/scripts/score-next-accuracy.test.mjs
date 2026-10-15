import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { charTokens, wordTokens, editCounts, lexicalScore, summarize, scoreRun } from './score-next-accuracy.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const counts = (r, h) => {
  const { substitutions, deletions, insertions, errors } = editCounts([...r], [...h]);
  return { substitutions, deletions, insertions, errors };
};

test('Independent edit controls distinguish substitutions, deletions and insertions', () => {
  assert.deepEqual(counts('abc', 'axc'), { substitutions: 1, deletions: 0, insertions: 0, errors: 1 });
  assert.deepEqual(counts('abc', 'ac'), { substitutions: 0, deletions: 1, insertions: 0, errors: 1 });
  assert.deepEqual(counts('ac', 'abc'), { substitutions: 0, deletions: 0, insertions: 1, errors: 1 });
  assert.deepEqual(counts('kitten', 'sitting'), { substitutions: 2, deletions: 0, insertions: 1, errors: 3 });
  assert.deepEqual(counts('abc', ''), { substitutions: 0, deletions: 3, insertions: 0, errors: 3 });
  assert.equal(editCounts([], ['x']).rate, null);
});

test('Canonical normalization is preserved without word repair or number equivalence', () => {
  assert.deepEqual(charTokens('Ａ，北 京！'), ['a', '北', '京']);
  assert.deepEqual(wordTokens('DON’T stop，3.5'), ['don', 't', 'stop', '3', '5']);
  assert.equal(lexicalScore('北 京，Ａ', '北京a!', 'chinese').rate, 0);
  assert.equal(lexicalScore('一二三', '123', 'chinese').errors, 3);
  assert.equal(lexicalScore('hello um world', 'hello world', 'english').deletions, 1);
  assert.equal(lexicalScore('I go', 'I went', 'english').substitutions, 1);
  assert.equal(lexicalScore('same', 'same same same', 'english').rate, 2);
});

test('Weighted and per-speaker means use different, stated denominators', () => {
  const row = (speaker, errors, reference_tokens) => ({ status: 'complete', participant_id: speaker, score: { errors, reference_tokens, substitutions: errors, deletions: 0, insertions: 0 } });
  const out = summarize([row('A', 1, 2), row('A', 0, 2), row('B', 0, 6)], true);
  assert.equal(out.weighted_rate, 0.1);
  assert.equal(out.speaker_mean_rate, 0.125);
  assert.equal(out.expected_speakers, 2);
});

function fixture() {
  const ids = ['meli-next-holdout-f99a-en', 'meli-next-holdout-m89a-en'];
  const input = { cases: ids.map((id, i) => ({ id, language: 'english', pcm_path: `/fake/${i}.f32`, pcm_sha256: sha(String(i)), sample_rate: 16000, audio_seconds: 20, split: 'holdout' })) };
  const refs = { cases: ids.map(id => ({ id, language: 'english', reference: 'hello world', reference_sha256: sha('hello world'), split: 'holdout' })) };
  const result = { status: 'complete', cases: input.cases.map(c => ({ id: c.id, language: c.language, pcm_sha256: c.pcm_sha256, status: 'complete', text: 'hello world' })) };
  return { input, refs, result };
}

test('An empty successful transcript is deletions; a failed transcript is never scored', () => {
  const { input, refs, result } = fixture();
  result.cases[0].text = '';
  result.cases[1] = { ...result.cases[1], status: 'error', error: 'resource failure', text: 'leftover partial text' };
  result.status = 'failed';
  const out = scoreRun(input, refs, result, { format: 'native' });
  assert.equal(out.status, 'incomplete');
  assert.equal(out.cases[0].score.deletions, 2);
  assert.equal(out.cases[1].score, null);
  const group = out.groups.find(g => g.split === 'holdout' && g.language === 'english');
  assert.equal(group.weighted_rate, null); assert.equal(group.speaker_mean_rate, null);
  assert.equal(group.completed_subset_only.weighted_rate, 1);
  assert.equal(group.failed_or_missing_cases, 1);
});

test('Missing cases prevent a full-set accuracy claim even when top status says complete', () => {
  const { input, refs, result } = fixture(); result.cases.pop();
  const out = scoreRun(input, refs, result, { format: 'native' });
  assert.equal(out.status, 'incomplete'); assert.equal(out.cases[1].status, 'missing');
  const group = out.groups.find(g => g.expected_cases);
  assert.equal(group.full_set_errors, null); assert.equal(group.weighted_rate, null);
});

test('Incomplete runs, mismatched PCM, leaked references and unknown IDs are rejected', () => {
  let f = fixture(); f.result.status = 'running';
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'native' }), /not terminal/);
  f = fixture(); f.result.cases[0].pcm_sha256 = sha('wrong');
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'native' }), /PCM SHA mismatch/);
  f = fixture(); f.result.cases[0].reference = 'hello world';
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'native' }), /not blind/);
  f = fixture(); f.result.cases[0].id = 'private-lyric';
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'native' }), /outside inference scope/);
});

test('Successful runs retain punctuation N/A and do not mutate any input', () => {
  const f = fixture(), before = JSON.stringify(f);
  const out = scoreRun(f.input, f.refs, f.result, { format: 'native' });
  assert.equal(out.status, 'complete');
  assert(out.cases.every(c => c.punctuation.status === 'not_applicable'));
  assert.equal(JSON.stringify(f), before);
  assert.equal(out.groups.find(g => g.expected_cases).weighted_rate, 0);
});

test('SenseVoice scoring requires observed exit evidence, not just existing JSON', () => {
  const f = fixture();
  f.result = { model_sha256: sha('model'), runtime_sha256: sha('runtime'), fingerprints: {}, requests: [], cases: f.result.cases.map(c => ({ id: c.id, pcm_sha256: c.pcm_sha256, result: { text: c.text } })) };
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'sensevoice' }), /runner-exit-code/);
  assert.equal(scoreRun(f.input, f.refs, f.result, { format: 'sensevoice', runnerExitCode: 0 }).status, 'complete');
  assert.equal(scoreRun(f.input, f.refs, f.result, { format: 'sensevoice', runnerExitCode: 1 }).status, 'incomplete');
});

test('Embedded nonzero worker return codes block complete scores and conflicting exit claims are rejected', () => {
  const f = fixture(); f.result.worker_returncode = 1;
  const out = scoreRun(f.input, f.refs, f.result, { format: 'native' });
  assert.equal(out.status, 'incomplete');
  assert.equal(out.completion_evidence.successful, false);
  assert.equal(out.groups.find(g => g.expected_cases).weighted_rate, null);
  assert.equal(out.groups.find(g => g.expected_cases).speaker_mean_rate, null);
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'native', runnerExitCode: 0 }), /conflicts/);
  f.result.worker_returncode = 0;
  assert.throws(() => scoreRun(f.input, f.refs, f.result, { format: 'native', runnerExitCode: 1 }), /conflicts/);
  assert.equal(scoreRun(f.input, f.refs, f.result, { format: 'native', runnerExitCode: 0 }).status, 'complete');
});

test('Official truncation remains visible and all repeated output is scored without repair', () => {
  const f = fixture(); f.result.worker_returncode = 0;
  f.result.cases[0] = { ...f.result.cases[0], text: 'hello world hello world', truncated: true,
    generated_token_count: 512, generation_at_requested_limit: true, eos_seen: false, text_policy: 'Raw generated tokens' };
  const out = scoreRun(f.input, f.refs, f.result, { format: 'native', runnerExitCode: 0 });
  assert.equal(out.status, 'complete');
  assert.equal(out.cases[0].generation_diagnostics.truncated, true);
  assert.equal(out.cases[0].generation_diagnostics.generated_token_count, 512);
  assert.equal(out.cases[0].text, 'hello world hello world');
  assert.equal(out.cases[0].score.insertions, 2);
  assert.equal(out.cases[0].score.rate, 1);
  assert.equal(out.groups.find(g => g.expected_cases).weighted_rate, 0.5);
});
