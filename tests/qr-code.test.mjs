import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeQr,
  rsBlocksFor,
  dataCapacityBits,
  bchTypeInfo,
  bchTypeNumber,
  ECL_BITS,
  TOTAL_CODEWORDS,
} from '../src/lib/qr-code.js';

const at = (qr, r, c) => qr.modules[r * qr.size + c];

test('RS table totals match the published codeword counts for all 160 entries', () => {
  for (let v = 1; v <= 40; v += 1) {
    for (const ecl of ['L', 'M', 'Q', 'H']) {
      const total = rsBlocksFor(v, ecl).reduce((sum, b) => sum + b.totalCount, 0);
      assert.equal(total, TOTAL_CODEWORDS[v - 1], `v${v}-${ecl} total`);
      const data = dataCapacityBits(v, ecl) / 8;
      assert.ok(data < total, `v${v}-${ecl} data < total`);
    }
  }
});

test('byte-mode capacities match the spec anchors (v1 / v10 / v40)', () => {
  const capacity = (v, ecl) => dataCapacityBits(v, ecl) / 8 - (v < 10 ? 2 : 3);
  assert.deepEqual(['L', 'M', 'Q', 'H'].map(e => capacity(1, e)), [17, 14, 11, 7]);
  assert.deepEqual(['L', 'M', 'Q', 'H'].map(e => capacity(10, e)), [271, 213, 151, 119]);
  assert.deepEqual(['L', 'M', 'Q', 'H'].map(e => capacity(40, e)), [2953, 2331, 1663, 1273]);
});

test('version auto-selection picks the smallest fitting version', () => {
  const qr = encodeQr('HELLO WORLD');
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.equal(qr.ecl, 'M');
  // H level holds only 7 bytes at v1, so 11 bytes must bump to v2
  assert.equal(encodeQr('HELLO WORLD', { ecl: 'H' }).version, 2);
});

test('finder patterns, separators, timing and the dark module are in place', () => {
  const qr = encodeQr('HELLO WORLD');
  assert.equal(at(qr, 0, 0), 1);
  assert.equal(at(qr, 0, 6), 1);
  assert.equal(at(qr, 6, 0), 1);
  assert.equal(at(qr, 1, 1), 0);
  assert.equal(at(qr, 3, 3), 1);
  assert.equal(at(qr, 7, 7), 0); // separator
  assert.equal(at(qr, 20, 20), 1); // bottom-right finder corner
  assert.equal(at(qr, 6, 8), 1); // timing starts dark at column 8
  assert.equal(at(qr, 6, 9), 0);
  assert.equal(at(qr, 8, 6), 1);
  assert.equal(at(qr, qr.size - 8, 8), 1); // always-dark module
});

test('format information in both copies matches the BCH code of ecl+mask', () => {
  const qr = encodeQr('https://example.com/', { ecl: 'Q' });
  const expected = bchTypeInfo((ECL_BITS.Q << 3) | qr.mask);
  let vertical = 0;
  for (let i = 0; i < 15; i += 1) {
    const bit = i < 6 ? at(qr, i, 8) : i < 8 ? at(qr, i + 1, 8) : at(qr, qr.size - 15 + i, 8);
    vertical |= bit << i;
  }
  let horizontal = 0;
  for (let i = 0; i < 15; i += 1) {
    const bit = i < 8 ? at(qr, 8, qr.size - i - 1) : i < 9 ? at(qr, 8, 7) : at(qr, 8, 15 - i - 1);
    horizontal |= bit << i;
  }
  assert.equal(vertical, expected);
  assert.equal(horizontal, expected);
});

test('alignment patterns appear at table positions for v2+', () => {
  const qr = encodeQr('a'.repeat(20)); // v2 at M
  assert.equal(qr.version, 2);
  assert.equal(at(qr, 18, 18), 1); // alignment center
  assert.equal(at(qr, 17, 18), 0); // white inner ring
  assert.equal(at(qr, 16, 18), 1); // dark outer border
});

test('version information for v7+ matches the BCH code of the version', () => {
  const qr = encodeQr('a'.repeat(200)); // v10 at M
  assert.equal(qr.version, 10);
  let bits = 0;
  for (let i = 0; i < 18; i += 1) {
    bits |= at(qr, Math.floor(i / 3), (i % 3) + qr.size - 11) << i;
  }
  assert.equal(bits, bchTypeNumber(10));
});

test('encoding is deterministic', () => {
  const a = encodeQr('确定性 测试');
  const b = encodeQr('确定性 测试');
  assert.equal(a.mask, b.mask);
  assert.deepEqual([...a.modules], [...b.modules]);
});

test('over-limit input throws a Chinese error naming the capacity', () => {
  assert.throws(() => encodeQr('a'.repeat(3000), { ecl: 'L' }), /内容过长/);
  assert.throws(() => encodeQr('a'.repeat(2000), { ecl: 'H' }), /内容过长/);
});
