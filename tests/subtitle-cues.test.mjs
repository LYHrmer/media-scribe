import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubtitle,
  sanitizeCues,
  convertSubtitle,
  shiftSubtitle,
  mergeSubtitles,
  splitSubtitle,
} from '../src/lib/subtitle-cues.js';

const SRT_SAMPLE = '1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n\n2\n00:00:04,000 --> 00:00:05,000\n第二行&lt;标签&gt;\n';

const VTT_SAMPLE = 'WEBVTT - 文件备注\n\nNOTE 这是注释\n跨两行\n\ncue-id-1\n00:01.000 --> 00:03.000 align:start position:0%\n你好\n\n00:04.000 --> 00:05.000\n第二行\n';

test('parses SRT cues with seconds as numbers', () => {
  const { format, cues, skipped } = parseSubtitle(SRT_SAMPLE);
  assert.equal(format, 'srt');
  assert.equal(skipped, 0);
  assert.deepEqual(cues[0], { start: 1, end: 3.5, text: '你好，世界' });
});

test('parses VTT header, NOTE blocks, identifiers and cue settings', () => {
  const { format, cues } = parseSubtitle(VTT_SAMPLE);
  assert.equal(format, 'vtt');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 3, text: '你好' });
});

test('SRT→VTT→SRT round-trip is byte-stable including entities', () => {
  const vtt = convertSubtitle(SRT_SAMPLE);
  assert.equal(vtt.to, 'vtt');
  assert.ok(vtt.text.startsWith('WEBVTT\n'));
  assert.ok(vtt.text.includes('00:00:01.000 --> 00:00:03.500'));
  const back = convertSubtitle(vtt.text);
  assert.equal(back.text, SRT_SAMPLE);
});

test('sanitize sorts unsorted cues and warns', () => {
  const { cues, warnings } = sanitizeCues([
    { start: 5, end: 6, text: '后' },
    { start: 1, end: 2, text: '先' },
  ]);
  assert.deepEqual(cues.map(cue => cue.start), [1, 5]);
  assert.ok(warnings.some(w => w.includes('乱序')));
});

test('sanitize drops empty and invalid cues with warnings, keeps overlaps', () => {
  const { cues, warnings } = sanitizeCues([
    { start: 1, end: 3, text: '甲' },
    { start: 2, end: 4, text: '乙' },
    { start: 5, end: 5, text: '零时长' },
    { start: 6, end: 7, text: '   ' },
  ]);
  assert.equal(cues.length, 2);
  assert.ok(warnings.some(w => w.includes('重叠')));
  assert.ok(warnings.some(w => w.includes('时间无效')));
  assert.ok(warnings.some(w => w.includes('无文字')));
});

test('shift clamps negative starts and reports it', () => {
  const result = shiftSubtitle(SRT_SAMPLE, -2000);
  assert.ok(result.text.includes('00:00:00,000 --> 00:00:01,500'));
  assert.ok(result.warnings.some(w => w.includes('从 0 开始')));
});

test('shift drops cues that end before zero', () => {
  const result = shiftSubtitle(SRT_SAMPLE, -4500);
  assert.equal(result.count, 1);
  assert.ok(result.text.includes('00:00:00,000 --> 00:00:00,500'));
});

test('shift rejects zero or non-numeric offsets', () => {
  assert.throws(() => shiftSubtitle(SRT_SAMPLE, 0), /非零数字/);
});

test('merge offsets the second part after the first', () => {
  const result = mergeSubtitles(SRT_SAMPLE, SRT_SAMPLE);
  assert.equal(result.count, 4);
  assert.ok(result.warnings.some(w => w.includes('平移 5.0 秒')));
  assert.ok(result.text.includes('00:00:06,000 --> 00:00:08,500'));
});

test('merge requires both inputs to have cues', () => {
  assert.throws(() => mergeSubtitles(SRT_SAMPLE, '没有字幕'), /至少含有一条/);
});

test('split assigns cues by start time', () => {
  const result = splitSubtitle(SRT_SAMPLE, 3.75);
  assert.equal(result.part1.count, 1);
  assert.equal(result.part2.count, 1);
  assert.ok(result.part1.text.includes('你好，世界'));
  assert.ok(result.part2.text.includes('第二行'));
});

test('split rejects split points that empty one side', () => {
  assert.throws(() => splitSubtitle(SRT_SAMPLE, 0.5), /某一侧没有字幕/);
});

test('convert throws when nothing parses', () => {
  assert.throws(() => convertSubtitle('这不是字幕'), /没有解析出任何有效字幕/);
});

test('malformed timing blocks count as skipped, not fatal', () => {
  const messy = '1\n时间戳不对 --> 也不对\n坏块\n\n2\n00:00:01,000 --> 00:00:02,000\n好块\n';
  const result = convertSubtitle(messy);
  assert.equal(result.count, 1);
  assert.ok(result.warnings.some(w => w.includes('无法解析')));
});
