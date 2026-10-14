import test from 'node:test';
import assert from 'node:assert/strict';
import { createVadEvidence, observeVadProbability, decideVadSkip } from '../src/vad-engine.js';
const complete = { sampleCount: 32000, checkedFrames: 63, maxProbability: .01, allProbabilitiesFinite: true, longestConsecutiveWeakFrames: 0, hasStrongPeak: false };
const summarize = probabilities => { const e=createVadEvidence();for(const p of probabilities)observeVadProbability(e,p);return e; };
test('only complete finite evidence at least two seconds can become a candidate', () => {
  assert.equal(decideVadSkip(complete), true);
  for (const changes of [{ sampleCount: 31999 }, { checkedFrames: 62 }, { maxProbability: .5 }, { maxProbability: NaN }, { maxProbability: -.1 }, { allProbabilitiesFinite: false }]) assert.equal(decideVadSkip({ ...complete, ...changes }), false);
});
test('force speech and lyric/unknown modes retain audio even when evidence is weak', () => {
  for (const changes of [{ forceSpeech: true }, { contentMode: 'lyrics' }, { contentMode: 'unknown' }]) assert.equal(decideVadSkip({ ...complete, ...changes }), false);
});
test('one strong frame preserves voice but an isolated weak noise spike can remain a candidate', () => {
  assert.equal(decideVadSkip({...complete,...summarize([.001,.5,.001])}),false);
  assert.equal(decideVadSkip({...complete,...summarize([.001,.0503,.001])}),true);
});
test('two adjacent weak frames preserve low-probability singing; separated weak frames do not count as consecutive', () => {
  assert.equal(decideVadSkip({...complete,...summarize([.001,.05,.06,.001])}),false);
  assert.equal(decideVadSkip({...complete,...summarize([.06,.001,.06])}),true);
});
test('weak consistency carries across transport-chunk boundaries without resetting', () => {
  const e=createVadEvidence();for(const p of [.001,.06])observeVadProbability(e,p);
  assert.equal(e.longestConsecutiveWeakFrames,1);
  for(const p of [.07,.001])observeVadProbability(e,p);
  assert.equal(e.longestConsecutiveWeakFrames,2);assert.equal(decideVadSkip({...complete,...e}),false);
});
