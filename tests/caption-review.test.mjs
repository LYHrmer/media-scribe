import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScreenTracks, reviewCaptionEvidence, captionLabel } from '../src/caption-review.js';
import { fuseVideoCaptions } from '../src/video-captions.js';
const box = (left, top, width = .2, height = .04) => ({ left, top, right: left+width, bottom: top+height, width, height, x:left+width/2, y:top+height/2 });
const track = (text, b = box(.4,.8), extra = {}) => ({text, observedText:text, start:1, end:3, box:b, reliable:true, support:3, warnings:[], ...extra});
const asr = (text, start=1, end=3, extra={}) => ({text, segments:[{start,end,text}], ...extra});

test('credit roles and nearby co-occurring names are separated from bottom captions', () => {
  const items = [track('编剧',box(.4,.2)),track('林明',box(.4,.26)),track('周禾',box(.4,.32)),track('跟着歌声向前走',box(.3,.85,.4))];
  const before=structuredClone(items), out=classifyScreenTracks(items);
  assert.deepEqual(out.map(x=>x.category),['credits','credits','credits','subtitle']);
  assert.ok(out.slice(0,3).every(x=>!x.reliable && x.reason==='probable_credit'));
  assert.deepEqual(items,before);
});
test('a role noun in a spoken sentence is not a credit heading', () => {
  for(const text of ['我是这部电影的编剧','导演告诉我继续走','The director asked me to wait.','我是艺术指导。']) {
    assert.equal(classifyScreenTracks([track(text)])[0].category,'subtitle');
  }
});
test('English and colon-separated credits are recognized without a name dictionary', () => {
  assert.equal(classifyScreenTracks([track('Written by'),track('Ada North',box(.4,.86))])[1].category,'credits');
  assert.equal(classifyScreenTracks([track('艺术指导：林明')])[0].category,'credits');
});
test('episode-prefixed roles and production credits stay separate without suppressing sentences', () => {
  for (const text of ['本集编剧：林明', '本期导演：周禾', '制作监督', '总监制', '总策划']) {
    assert.equal(classifyScreenTracks([track(text)])[0].category, 'credits');
  }
  for (const text of ['本集编剧讲述了一个故事', '我来负责制作监督工作', '我们邀请了本期导演']) {
    assert.equal(classifyScreenTracks([track(text)])[0].category, 'subtitle');
  }
});
test('short text with no spatial or temporal credit connection remains visible', () => {
  const out=classifyScreenTracks([track('导演',box(.1,.2)),track('欢迎你',box(.4,.85)),track('周禾',box(.1,.26),{start:5,end:6}),track('林明',null)]);
  assert.deepEqual(out.map(x=>x.category),['credits','subtitle','subtitle','subtitle']);
});
test('tilted two-column credits are grouped by overlap while distant bottom lyrics remain', () => {
  const items = [track('执行导演',box(.44,.38,.18,.11)), track('林明',box(.38,.49,.11,.11)),
    track('周禾',box(.56,.46,.12,.11)), track('许宁',box(.59,.55,.09,.11)), track('向前走',box(.4,.88,.2,.04))];
  assert.deepEqual(classifyScreenTracks(items).map(x=>x.category), ['credits','credits','credits','credits','subtitle']);
});
test('standalone screen handles stay reviewable without suppressing normal mentions', () => {
  const items = classifyScreenTracks([track('@示例账号'), track('@sample_user'), track('请关注@示例账号')]);
  assert.deepEqual(items.map(x=>x.category), ['screen_label','screen_label','subtitle']);
  assert.equal(items[0].reliable, false); assert.equal(captionLabel(items[0]), '疑似账号标识');
  assert.equal(reviewCaptionEvidence([items[0]],asr(items[0].text))[0].audioEvidence,undefined);
});
test('full OCR fusion keeps credit text out of visual-only transcript but retains it for review', () => {
  const texts=[{text:'编剧',box:[[400,200],[600,240]],confidence:.99},{text:'林明',box:[[400,260],[600,300]],confidence:.99},{text:'跟着歌声向前走',box:[[300,850],[700,890]],confidence:.99}];
  const out=fuseVideoCaptions([1,1.5,2].map(time=>({time,width:1000,height:1000,texts})),{duration:10});
  assert.deepEqual(out.segments.map(x=>x.text),['跟着歌声向前走。']);
  assert.deepEqual(out.candidates.map(x=>x.category),['credits','credits']);
});
test('exact local Chinese agreement is marked without rewriting either source', () => {
  const c=[track('我们明天继续练习。')], a=asr('好的，我们明天继续练习。'), before=structuredClone(a);
  const out=reviewCaptionEvidence(c,a);
  assert.equal(out[0].audioEvidence.status,'match');
  assert.equal(out[0].text,c[0].text);assert.deepEqual(a,before);assert.equal(c[0].audioEvidence,undefined);
  assert.match(captionLabel(out[0]),/语音识别一致/);
});
test('English matching respects word boundaries and does not match substrings', () => {
  assert.equal(reviewCaptionEvidence([track('We can start now.')],asr('Well, we can start now.'))[0].audioEvidence.status,'match');
  assert.notEqual(reviewCaptionEvidence([track('the art show')],asr('the party showed'))[0].audioEvidence.status,'match');
});
test('the same words at a distant time cannot confirm screen text', () => {
  assert.equal(reviewCaptionEvidence([track('我们明天继续练习')],asr('我们明天继续练习',30,33))[0].audioEvidence.status,'unverified');
});
test('coarse full-file timestamps, NaN and missing visual bounds cannot confirm a caption', () => {
  const c=track('我们明天继续练习');
  for(const a of [asr(c.text,0,40),asr(c.text,1,3,{timing:'approximate'}),asr(c.text,NaN,3)]) assert.equal(reviewCaptionEvidence([c],a)[0].audioEvidence.status,'unverified');
  assert.equal(reviewCaptionEvidence([{...c,end:undefined}],asr(c.text))[0].audioEvidence.status,'unverified');
});
test('model disagreements and unsupported short or weak readings are not confirmed', () => {
  assert.equal(reviewCaptionEvidence([track('我们明天继续练习')],asr('我们明年继续练习'))[0].audioEvidence.status,'different');
  for(const c of [track('你好'),track('我们明天继续练习',undefined,{reliable:false})]) assert.equal(reviewCaptionEvidence([c],asr(c.text))[0].audioEvidence.status,'unverified');
});
test('credits and persistent text never acquire audio agreement automatically', () => {
  for(const category of ['credits','static']) {
    const c=track('我们明天继续练习',undefined,{category,audioEvidence:{status:'match'}});
    assert.equal(reviewCaptionEvidence([c],asr(c.text))[0].audioEvidence,undefined);
  }
});
test('retry recomputes agreement and removes stale model evidence', () => {
  const first=reviewCaptionEvidence([track('我们明天继续练习')],asr('我们明天继续练习'));
  assert.equal(reviewCaptionEvidence(first,asr('另外一段录音'))[0].audioEvidence.status,'unverified');
});
