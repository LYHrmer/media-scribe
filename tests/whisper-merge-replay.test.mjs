import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WhisperTokenizer, env } from '@huggingface/transformers';
import { transcribeWithSafeTimestampMerge } from '../src/whisper-nonoverlap-wrapper.js';

// Real Transformers.js decoder and longest-common-sequence implementation.
// Only the finite English token vocabulary is replaced by a verified fixture;
// no downloaded tokenizer, model, audio, network or source evaluation is used.
const fixture = JSON.parse(await readFile(new URL('./whisper-merge-replay.fixture.json', import.meta.url)));
assert.equal(env.version, fixture.provenance.transformers_version);
const plain = value => JSON.parse(JSON.stringify(value));
const scope = { model: 'Xenova/whisper-small', transformersVersion: env.version };
const pipelineOptions = { ...fixture.decode_options, language: 'english', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };

function createTokenizer() {
  const tokenizer = Object.create(WhisperTokenizer.prototype);
  Object.defineProperties(tokenizer, {
    timestamp_begin: { value: fixture.timestamp_begin },
    all_special_ids: { value: Object.freeze(fixture.all_special_ids.slice()) },
    decode: { value(tokens, options = {}) {
      assert.notEqual(options.decode_with_timestamps, true, 'This finite fixture does not replace timestamp rendering');
      return Array.from(tokens, Number)
        .filter(id => !options.skip_special_tokens || !fixture.all_special_ids.includes(id))
        .map(id => {
          assert.ok(Object.hasOwn(fixture.token_pieces, id), `Unrecorded token ${id}`);
          return fixture.token_pieces[id];
        }).join('');
    } },
  });
  return tokenizer;
}

function windows(endTimestampToken) {
  return Object.freeze(fixture.sequences.map((row, index) => Object.freeze({
    tokens: Object.freeze(row.tokens.map(id => BigInt(index === 0 && endTimestampToken !== undefined && id === 51352 ? endTimestampToken : id))),
    stride: Object.freeze(row.stride.slice()),
  })));
}

async function scopedReplay(tokenizer, sequences, options = pipelineOptions, selectedScope = scope) {
  const audio = Object.freeze({ fixture: 'No acoustic inference is performed' });
  let called = 0;
  const transcriber = async (receivedAudio, receivedOptions) => {
    called++;
    assert.strictEqual(receivedAudio, audio);
    assert.strictEqual(receivedOptions, options);
    return tokenizer._decode_asr(sequences, receivedOptions);
  };
  transcriber.tokenizer = tokenizer;
  const output = await transcribeWithSafeTimestampMerge(transcriber, audio, options, selectedScope);
  assert.equal(called, 1);
  assert.strictEqual(tokenizer._decode_asr, WhisperTokenizer.prototype._decode_asr, 'the cached tokenizer is restored after this job');
  assert.equal(Object.hasOwn(tokenizer, '_decode_asr'), false);
  return plain(output);
}

test('fixture token pieces match all complete decode strings verified with the original full tokenizer', () => {
  const tokenizer = createTokenizer();
  assert.equal(fixture.provenance.reference_used, false);
  assert.equal(fixture.license.name, 'CC BY-NC-SA 4.0');
  assert.equal(fixture.decode_checks.length, 12);
  for (const check of fixture.decode_checks) {
    assert.equal(tokenizer.decode(check.tokens, check.options || {}), check.text);
  }
});

test('actual 3.8.1 decoder reproduces the recorded missing words and every original subtitle chunk', () => {
  const tokenizer = createTokenizer();
  const sequences = windows();
  assert.deepEqual(sequences.map(row => row.stride), [[30, 0, 5], [14.6899375, 5, 0]]);
  assert.strictEqual(tokenizer.findLongestCommonSequence, WhisperTokenizer.prototype.findLongestCommonSequence);
  const output = tokenizer._decode_asr(sequences, fixture.decode_options);
  assert.deepEqual(plain(output), fixture.expected_original);
  assert.equal(output[1].chunks.length, 3);
  assert.doesNotMatch(output[0], /reading and writing/);
  assert.doesNotMatch(output[0], /my pronunciation/);
});

test('actual scoped production helper preserves both disjoint passages and exact corrected subtitle times without mutating inputs', async () => {
  const tokenizer = createTokenizer();
  const sequences = windows();
  const before = structuredClone(sequences);
  const options = Object.freeze({ ...pipelineOptions });
  const output = await scopedReplay(tokenizer, sequences, options);
  assert.deepEqual(output, fixture.expected_corrected);
  assert.equal(output[1].chunks.length, 5);
  assert.match(output[0], /reading and writing/);
  assert.match(output[0], /my pronunciation/);
  assert.deepEqual(output[1].chunks[1].timestamp, [8.4, 19.76]);
  assert.deepEqual(output[1].chunks[2].timestamp, [20, 21]);
  assert.deepEqual(sequences, before);
  assert.deepEqual(options, pipelineOptions);
  assert.deepEqual(plain(tokenizer._decode_asr(sequences, fixture.decode_options)), fixture.expected_original, 'later unguarded calls still use the original decoder');
});

test('the same actual decoder fixture stays untouched outside English Small timestamp transcription', async () => {
  for (const [options, selectedScope, expected] of [
    [{ ...pipelineOptions, language: 'chinese' }, scope, fixture.expected_original],
    [pipelineOptions, { ...scope, model: 'Xenova/whisper-tiny' }, fixture.expected_original],
    [{ ...pipelineOptions, task: 'translate' }, scope, fixture.expected_original],
    [{ ...pipelineOptions, return_timestamps: false }, scope, fixture.expected_text_mode],
  ]) {
    assert.deepEqual(await scopedReplay(createTokenizer(), windows(), options, selectedScope), expected);
  }
});

test('actual physical overlap and the exact 20-second boundary retain the real decoder behavior', async () => {
  for (const endSeconds of [20, 24]) {
    const tokenizer = createTokenizer();
    const sequences = windows(fixture.timestamp_begin + Math.round(endSeconds / 0.02));
    const before = structuredClone(sequences);
    const original = plain(tokenizer._decode_asr(sequences, fixture.decode_options));
    assert.deepEqual(await scopedReplay(tokenizer, sequences), original);
    assert.deepEqual(sequences, before);
  }
});
