import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseVideoCaptions, ensureSentencePunctuation } from '../src/video-captions.js';
import { planVideoFrames } from '../src/video-frames.js';

const box = [[100, 500], [500, 500], [500, 550], [100, 550]];
const frame = (time, text, confidence = 0.98, extra = {}) => ({ time, texts: [{ text, confidence, box, ...extra }] });
const fuse = (frames, extra = {}) => fuseVideoCaptions(frames, { duration: 10, sampleInterval: 0.5, ...extra });

test('empty, invalid, negative-time and non-language readings are ignored', () => {
  assert.deepEqual(fuseVideoCaptions(null), { reliable: false, segments: [], candidates: [], warnings: [] });
  assert.deepEqual(fuse([frame(-1, '测试'), frame(NaN, '测试'), frame(0, '###'), { time: 1, texts: {} }]).segments, []);
});

test('repeated screen words deduplicate with observation times, not assumed speech times', () => {
  const result = fuse([frame(1, '现在开始练习'), frame(1.5, '现在开始练习'), frame(2, '现在开始练习')]);
  assert.equal(result.reliable, true);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, '现在开始练习。');
  assert.equal(result.segments[0].start, 1);
  assert.equal(result.segments[0].end, 2.5);
  assert.equal(result.segments[0].support, 3);
  assert.equal(result.segments[0].source, 'video_ocr');
  assert.equal(result.segments[0].timeSource, 'video_frames');
});

test('even a high-score lone frame stays a review candidate', () => {
  const result = fuse([frame(1, '欢迎大家', 0.999)]);
  assert.equal(result.reliable, false);
  assert.equal(result.segments.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].support, 1);
});

test('a low-score lone hallucination does not enter the transcript or candidate list', () => {
  const result = fuse([frame(1, '奇怪的字幕', 0.42)]);
  assert.deepEqual(result.segments, []);
  assert.deepEqual(result.candidates, []);
});

test('one hundred variants from one frame cannot defeat two independent clear frames', () => {
  const bad = Array.from({ length: 100 }, () => frame(1, '这就是测式', 0.99));
  const result = fuse([frame(0, '这就是测试', 0.96), ...bad, frame(2, '这就是测试', 0.96)]);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, '这就是测试。');
  assert.equal(result.segments[0].support, 3);
});

test('a missing glyph can be restored only from repeated actual visual readings', () => {
  const result = fuse([frame(0, '现在始练习', 0.98), frame(0.5, '现在始练习', 0.98),
    frame(1, '现在开始练习', 0.96), frame(1.5, '现在开始练习', 0.96)]);
  assert.equal(result.segments[0].text, '现在开始练习。');
});

test('an inserted glyph in only one frame stays uncertain and is not silently filled', () => {
  const result = fuse([frame(0, '现在始练习'), frame(0.5, '现在始练习'), frame(1, '现在开始练习')]);
  assert.equal(result.segments.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].uncertainInsertions.some((item) => item.alternatives.some((other) => other.character === '开')));
  assert.equal(result.candidates[0].text, '现在始练习。');
  assert.equal(result.candidates[0].uncertainInsertions[0].boundary, 2);
});

test('low per-glyph scores cannot be hidden by a high sentence score', () => {
  const characters = Array.from('欢迎大家', (text, index) => ({ text, confidence: index === 2 ? 0.2 : 0.99 }));
  const result = fuse([frame(0, '欢迎大家', 0.99, { characters }), frame(1, '欢迎大家', 0.99, { characters })]);
  assert.equal(result.segments.length, 0);
  assert.ok(result.candidates[0].uncertainCharacters.some((item) => item.character === '大'));
});

test('changing captions and distant text regions stay separate', () => {
  const remote = [[800, 20], [1000, 20], [1000, 60], [800, 60]];
  const result = fuse([frame(0, '今天学习控制'), frame(0.5, '今天学习控制'),
    frame(0, '购票入口', 0.98, { box: remote }), frame(0.5, '购票入口', 0.98, { box: remote }),
    frame(2, '明天学习规划'), frame(2.5, '明天学习规划')]);
  assert.equal(result.segments.length, 3);
  assert.deepEqual(new Set(result.segments.map((item) => item.text)), new Set(['今天学习控制。', '明天学习规划。', '购票入口。']));
});

test('persistent unchanged text at a fixed position is reviewed as a possible logo', () => {
  const frames = [0, 1, 2, 3, 4].map((time) => frame(time, '演出平台'));
  const result = fuse(frames, { duration: 4.5 });
  assert.equal(result.segments.length, 0);
  assert.equal(result.candidates[0].reason, 'static_text');
  assert.ok(result.candidates[0].warnings.some((value) => value.includes('标识')));
});

test('actual 30-minute paired sampling cannot turn a persistent watermark into 180 reliable captions', () => {
  const plan = planVideoFrames(1800);
  const watermark = [[850, 20], [1000, 20], [1000, 60], [850, 60]];
  const frames = plan.times.map((time) => frame(time, '演出平台', 0.99, { box: watermark }));
  const result = fuseVideoCaptions(frames, { duration: 1800, sampleInterval: plan.sampleInterval });
  assert.equal(result.reliable, false);
  assert.deepEqual(result.segments, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].reason, 'static_text');
  assert.equal(result.candidates[0].support, 360);
  assert.ok(result.candidates[0].end > 1799);
});

test('sparse rotating repeated captions stay separate from an all-video watermark', () => {
  const plan = planVideoFrames(1800);
  const phrases = ['现在准备开始', '接下来进行练习', '然后检查结果', '最后保存记录'];
  const watermark = [[850, 20], [1000, 20], [1000, 60], [850, 60]];
  const frames = plan.times.map((time, index) => ({ time, texts: [
    { text: phrases[Math.floor(index / 2) % phrases.length], confidence: 0.99, box },
    { text: '演出平台', confidence: 0.99, box: watermark },
  ] }));
  const result = fuseVideoCaptions(frames, { duration: 1800, sampleInterval: plan.sampleInterval });
  assert.equal(result.segments.length, 180);
  assert.deepEqual(new Set(result.segments.map((segment) => segment.text)), new Set(phrases.map((text) => `${text}。`)));
  assert.equal(result.candidates.filter((candidate) => candidate.reason === 'static_text').length, 1);
  assert.ok(result.segments.every((segment) => segment.text !== '演出平台。'));
});

test('a repeated line interleaved with another line is not a persistent watermark', () => {
  const phrases = ['准备检查参数', '开始运行系统'];
  const frames = [0, 0.5, 1, 1.5, 2].map((time, index) => frame(time, phrases[index % 2]));
  const result = fuse(frames, { duration: 2.5 });
  assert.deepEqual(new Set(result.segments.map((segment) => segment.text)), new Set(phrases.map((text) => `${text}。`)));
  assert.ok(!result.candidates.some((candidate) => candidate.reason === 'static_text'));
});

test('a repeated caption after a long time gap remains a separate occurrence', () => {
  const result = fuse([frame(0, '请再次尝试'), frame(0.5, '请再次尝试'), frame(6, '请再次尝试'), frame(6.5, '请再次尝试')]);
  assert.equal(result.segments.length, 2);
});

test('the same caption on two screens at overlapping times is not printed twice', () => {
  const remote = [[800, 20], [1000, 20], [1000, 60], [800, 60]];
  const result = fuse([frame(0, '现在开始演示'), frame(0.5, '现在开始演示'),
    frame(0, '现在开始演示', 0.98, { box: remote }), frame(0.5, '现在开始演示', 0.98, { box: remote })]);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].support, 2);
});

test('punctuation follows actual existing marks and line breaks, without four-character commas', () => {
  assert.equal(ensureSentencePunctuation('漫天红伞无人生还'), '漫天红伞无人生还。');
  assert.equal(ensureSentencePunctuation('你好，世界！'), '你好，世界！');
  assert.equal(ensureSentencePunctuation('第一行\n第二行'), '第一行。\n第二行。');
  assert.equal(ensureSentencePunctuation('“你好”'), '“你好。”');
  assert.equal(ensureSentencePunctuation('Hello, world!'), 'Hello, world!');
  assert.equal(ensureSentencePunctuation('  '), '');
  const result = fuse([frame(0, '你好，世界！'), frame(1, '你好，世界！')]);
  assert.equal(result.segments[0].text, '你好，世界！');
});

test('normalized geometry handles a change in extracted image resolution', () => {
  const result = fuse([{ ...frame(0, '开始进行测试'), width: 1000, height: 1000 },
    { ...frame(1, '开始进行测试', 0.98, { box: box.map(([x, y]) => [x / 2, y / 2]) }), width: 500, height: 500 }]);
  assert.equal(result.segments.length, 1);
});

test('input objects remain untouched and segment ends are clipped to video duration', () => {
  const frames = [frame(1, '完成本次测试'), frame(1.5, '完成本次测试')];
  const before = JSON.stringify(frames);
  const result = fuse(frames, { duration: 1.7 });
  assert.equal(JSON.stringify(frames), before);
  assert.equal(result.segments[0].end, 1.7);
});

// Real blind PP-OCR outputs from the user's local concert video. These literal
// strings are regression fixtures only; inference has no expected lyric input.
test('real first two seconds produce one supported screen caption, not the later lone false glyph', () => {
  const scores = [0.9934834018349648, 0.9963349103927612, 0.9956464022397995,
    0.9919554218649864, 0.9968395754694939, 0.9964837431907654];
  const firstBox = [[188, 788], [231, 788], [231, 1019], [188, 1019]];
  const frames = scores.map((confidence, index) => frame(0.125 + index * 0.25, '漫天红伞无人生还', confidence, { box: firstBox }));
  frames.push(frame(1.875, '羊', 0.653, { box: firstBox }));
  const result = fuse(frames, { duration: 21.696, sampleInterval: 0.25 });
  assert.deepEqual(result.segments.map((item) => item.text), ['漫天红伞无人生还。']);
  assert.equal(result.segments[0].support, 6);
  assert.equal(result.candidates[0].text, '羊。');
});

test('real complementary later readings preserve the weak conflicting glyph as review evidence', () => {
  const a = '我的遗是不能洁白的带你离开';
  const b = '我的透憾是不能洁白的带你离开';
  const c = '我的遗撼是不能洁的带你离开';
  const measuredFrames = [
    {
      "time": 13.125,
      "texts": [
        {
          "text": "我的遗是不能洁白的带你离开",
          "confidence": 0.8517952355054709,
          "box": [
            [
              479,
              1576
            ],
            [
              655,
              1567
            ],
            [
              657,
              1602
            ],
            [
              481,
              1611
            ]
          ],
          "characters": [
            {
              "text": "我",
              "confidence": 0.9999349117279053
            },
            {
              "text": "的",
              "confidence": 0.9935513734817505
            },
            {
              "text": "遗",
              "confidence": 0.6998844146728516
            },
            {
              "text": "是",
              "confidence": 0.9991300702095032
            },
            {
              "text": "不",
              "confidence": 0.9994509816169739
            },
            {
              "text": "能",
              "confidence": 0.9982554316520691
            },
            {
              "text": "洁",
              "confidence": 0.8432313799858093
            },
            {
              "text": "白",
              "confidence": 0.3424851596355438
            },
            {
              "text": "的",
              "confidence": 0.9941950440406799
            },
            {
              "text": "带",
              "confidence": 0.9619525074958801
            },
            {
              "text": "你",
              "confidence": 0.6497228145599365
            },
            {
              "text": "离",
              "confidence": 0.8238639831542969
            },
            {
              "text": "开",
              "confidence": 0.7676799893379211
            }
          ]
        },
        {
          "text": "我的透憾是不能洁白的带你离开",
          "confidence": 0.8374484777450562,
          "box": [
            [
              479,
              1576
            ],
            [
              655,
              1567
            ],
            [
              657,
              1602
            ],
            [
              481,
              1611
            ]
          ],
          "characters": [
            {
              "text": "我",
              "confidence": 0.999826967716217
            },
            {
              "text": "的",
              "confidence": 0.9886075854301453
            },
            {
              "text": "透",
              "confidence": 0.248135507106781
            },
            {
              "text": "憾",
              "confidence": 0.35395944118499756
            },
            {
              "text": "是",
              "confidence": 0.9983983635902405
            },
            {
              "text": "不",
              "confidence": 0.999798595905304
            },
            {
              "text": "能",
              "confidence": 0.9999886751174927
            },
            {
              "text": "洁",
              "confidence": 0.9613490700721741
            },
            {
              "text": "白",
              "confidence": 0.571207582950592
            },
            {
              "text": "的",
              "confidence": 0.9917165637016296
            },
            {
              "text": "带",
              "confidence": 0.9900321960449219
            },
            {
              "text": "你",
              "confidence": 0.9344753623008728
            },
            {
              "text": "离",
              "confidence": 0.7336711287498474
            },
            {
              "text": "开",
              "confidence": 0.9531116485595703
            }
          ]
        }
      ]
    },
    {
      "time": 14.125,
      "texts": [
        {
          "text": "我的遗撼是不能洁的带你离开",
          "confidence": 0.8995564740437728,
          "box": [
            [
              870,
              1546
            ],
            [
              1059,
              1544
            ],
            [
              1059,
              1583
            ],
            [
              871,
              1585
            ]
          ],
          "characters": [
            {
              "text": "我",
              "confidence": 0.9998335838317871
            },
            {
              "text": "的",
              "confidence": 0.9897253513336182
            },
            {
              "text": "遗",
              "confidence": 0.9218429923057556
            },
            {
              "text": "撼",
              "confidence": 0.1461891233921051
            },
            {
              "text": "是",
              "confidence": 0.9972726702690125
            },
            {
              "text": "不",
              "confidence": 0.9992814660072327
            },
            {
              "text": "能",
              "confidence": 0.9942567944526672
            },
            {
              "text": "洁",
              "confidence": 0.8915221095085144
            },
            {
              "text": "的",
              "confidence": 0.9646751880645752
            },
            {
              "text": "带",
              "confidence": 0.9882232546806335
            },
            {
              "text": "你",
              "confidence": 0.986376941204071
            },
            {
              "text": "离",
              "confidence": 0.9184131026268005
            },
            {
              "text": "开",
              "confidence": 0.896621584892273
            }
          ]
        }
      ]
    }
  ];
  const result = fuse(measuredFrames, { duration: 21.696, sampleInterval: 0.25 });
  assert.equal(result.segments.length, 0);
  assert.equal(result.candidates.length, 1);
  const alternatives = [...result.candidates[0].uncertainCharacters, ...result.candidates[0].uncertainInsertions]
    .flatMap((value) => value.alternatives.map((choice) => choice.character));
  assert.ok(alternatives.includes('憾'));
  assert.ok(alternatives.includes('撼'));
  assert.ok(result.candidates[0].warnings.length);
  const observed = new Set(Array.from(a + b + c));
  for (const char of Array.from(result.candidates[0].text).filter((value) => /[\p{L}\p{N}]/u.test(value))) assert.ok(observed.has(char));
  for (const item of result.candidates[0].uncertainCharacters) assert.equal(Array.from(result.candidates[0].text)[item.index], item.character);
  for (const item of result.candidates[0].uncertainInsertions) assert.equal(item.isInsertion, true);
});

test('uncertain character indices still address their glyph after newline punctuation is added', () => {
  const text = '第一行\n第二行';
  const characters = Array.from(text).filter((char) => /\p{L}/u.test(char))
    .map((character, index) => ({ character, confidence: index === 4 ? 0.2 : 0.99 }));
  const result = fuse([frame(0, text, 0.99, { characters }), frame(1, text, 0.99, { characters })]);
  const candidate = result.candidates[0];
  assert.equal(candidate.text, '第一行。\n第二行。');
  assert.equal(candidate.uncertaintyIndexUnit, 'codepoint');
  for (const item of candidate.uncertainCharacters) assert.equal(Array.from(candidate.text)[item.index], item.character);
});
