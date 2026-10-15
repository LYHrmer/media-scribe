import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, validateJson, sortKeysDeep, locateJsonError } from '../src/lib/json-tools.js';

test('formats with two-space indent by default', () => {
  const result = formatJson('{"a":1,"b":[2,3]}');
  assert.equal(result.ok, true);
  assert.equal(result.result, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
});

test('minifies when asked', () => {
  const result = formatJson('{ "a": 1 }', { minify: true });
  assert.equal(result.result, '{"a":1}');
});

test('indent accepts a width or a tab character', () => {
  assert.equal(formatJson('{"a":1}', { indent: 4 }).result, '{\n    "a": 1\n}');
  assert.equal(formatJson('{"a":1}', { indent: '\t' }).result, '{\n\t"a": 1\n}');
});

test('sortKeysDeep sorts object keys recursively but keeps array order', () => {
  const sorted = sortKeysDeep({ b: 1, a: [{ d: 1, c: 2 }, 3] });
  assert.deepEqual(Object.keys(sorted), ['a', 'b']);
  assert.deepEqual(Object.keys(sorted.a[0]), ['c', 'd']);
  assert.equal(sorted.a[1], 3);
});

test('reports parse errors with a message', () => {
  const result = formatJson('{\n  "a": 1,\n  bad\n}');
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
});

test('a leading BOM is tolerated and error lines stay aligned', () => {
  const ok = formatJson('﻿{"a":1}');
  assert.equal(ok.ok, true);
  assert.equal(ok.result, '{\n  "a": 1\n}');
  const bad = formatJson('﻿{\n  bad\n}');
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 2);
  assert.equal(validateJson('﻿{"ok":true}').ok, true);
});

test('locateJsonError extracts position-based locations (V8)', () => {
  const text = '{\n  "a": 1,\n  bad\n}';
  const loc = locateJsonError(text, 'Unexpected token b in JSON at position 14');
  assert.deepEqual(loc, { line: 3, column: 3 });
});

test('locateJsonError extracts line/column locations (Firefox/newer V8)', () => {
  const loc = locateJsonError('', 'Unexpected token at line 2 column 5 of the JSON data');
  assert.deepEqual(loc, { line: 2, column: 5 });
});

test('locateJsonError falls back to empty when the format is unknown', () => {
  assert.deepEqual(locateJsonError('', 'JSON Parse error: Unexpected EOF'), {});
});

test('validateJson distinguishes valid and invalid input', () => {
  assert.equal(validateJson('{"ok":true}').ok, true);
  assert.equal(validateJson('{ok}').ok, false);
});
