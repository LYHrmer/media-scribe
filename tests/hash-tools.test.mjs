import test from 'node:test';
import assert from 'node:assert/strict';
import { hashBuffer, normalizeHash, compareHash, formatBytes, HASH_ALGOS } from '../src/lib/hash-tools.js';

const encode = text => new TextEncoder().encode(text).buffer;

test('hashBuffer matches the published vectors for "abc"', async () => {
  const expected = {
    'SHA-256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'SHA-1': 'a9993e364706816aba3e25717850c26c9cd0d89d',
    'SHA-512': 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...HASH_ALGOS].sort());
  for (const algo of HASH_ALGOS) {
    assert.equal(await hashBuffer(encode('abc'), algo), expected[algo]);
  }
});

test('normalizeHash strips whitespace and case', () => {
  assert.equal(normalizeHash('  BA78 16bf\n'), 'ba7816bf');
});

test('compareHash reports match, mismatch, invalid and idle', () => {
  const actual = 'ba7816bf';
  assert.equal(compareHash(actual, 'BA78 16BF'), 'match');
  assert.equal(compareHash(actual, 'ba7816be'), 'mismatch');
  assert.equal(compareHash(actual, 'xyz!'), 'invalid');
  assert.equal(compareHash(actual, '  '), 'idle');
});

test('formatBytes picks sensible units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(120 * 1024 * 1024), '120 MB');
});
