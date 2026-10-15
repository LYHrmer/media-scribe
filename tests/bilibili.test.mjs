import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseBilibiliUrl, bilibiliEndpoint } from '../src/bilibili-url.js';
import { md5, signWbi, allowedMediaUrl, openBilibiliAudio, handleBilibili } from '../server/bilibili.js';

const video='https://www.bilibili.com/video/BV13x41117TL';
const cdn='https://upos-sz-mirrorcosov.bilivideo.com/test.m4s?opaque=123';
const bytes=new Uint8Array(48);bytes.set(new TextEncoder().encode('ftyp'),4);
const images={img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'};
const metadata={code:0,data:{bvid:'BV13x41117TL',title:'公开采访',pages:[{page:1,cid:123,duration:20,part:'第一段'},{page:2,cid:456,duration:21,part:'第二段'}],rights:{}}};
const play={code:0,data:{timelength:21000,dash:{audio:[{codecs:'mp4a.40.2',bandwidth:192000,baseUrl:cdn}]}}};
function fixture({meta=metadata,playInfo=play,media,redirect}={}) {
  const calls=[];
  const fetchImpl=async(value,options)=>{
    const url=new URL(value);calls.push({url,options});
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
    assert.equal(options.headers?.Cookie,undefined);assert.equal(options.headers?.Authorization,undefined);
    if(url.hostname==='b23.tv')return new Response(null,{status:302,headers:{location:redirect||video+'?p=2&share_source=copy'}});
    if(url.pathname==='/x/web-interface/view')return Response.json(meta);
    if(url.pathname==='/x/web-interface/nav')return Response.json({code:-101,data:{wbi_img:images}});
    if(url.pathname==='/x/player/wbi/playurl')return Response.json(playInfo);
    if(url.hostname.endsWith('.bilivideo.com'))return media?.(url,options)||new Response(bytes,{headers:{'Content-Length':String(bytes.length),'Content-Type':'video/mp4'}});
    assert.fail('unexpected destination '+url.href);
  };
  return {calls,fetchImpl};
}

test('Bilibili URL canonicalization preserves selected part, removes tracking and rejects unsafe destinations',()=>{
  assert.equal(parseBilibiliUrl(video+'/?p=2&share_source=copy#reply').url,video+'?p=2');
  assert.equal(parseBilibiliUrl('https://b23.tv/Abc123?token=tracking').url,'https://b23.tv/Abc123');
  assert.equal(parseBilibiliUrl('https://www.bilibili.com/video/av123').id,'av123');
  assert.equal(parseBilibiliUrl('https://bilibili.com.evil.test/video/BV13x41117TL'),null);
  for(const url of [video+'?p=0',video+'?p=-1','https://u:p@www.bilibili.com/video/BV13x41117TL','https://www.bilibili.com:8443/video/BV13x41117TL','https://www.bilibili.com/bangumi/play/ep123'])assert.throws(()=>parseBilibiliUrl(url));
  assert.equal(bilibiliEndpoint({hostname:'example.com',origin:'https://example.com'}),'');
  assert.match(bilibiliEndpoint({hostname:'lyhrmer.github.io'}),/\/api\/bilibili$/);
});
test('WBI checksum matches independent MD5 vectors and canonical request signing',()=>{
  for(const value of ['', 'abc','公开音轨','x'.repeat(1000)])assert.equal(md5(value),createHash('md5').update(value).digest('hex'));
  const signed=new URLSearchParams(signWbi({foo:'114',bar:'514',baz:1919810},images,1702204169000));
  // Fixed public key and timestamp; independently checked with Python hashlib.
  assert.equal(signed.get('w_rid'),'6149fdadf571698ca7e6a567265cd0ee');
  assert.throws(()=>signWbi({},{}));
});
test('anonymous API and media use the canonical Referer and stream actual audio, including b23 and part selection',async()=>{
  const h=fixture();const result=await openBilibiliAudio('https://b23.tv/Abc123',{fetchImpl:h.fetchImpl});
  assert.equal(result.duration,21);assert.match(result.title,/P2 第二段/);
  assert.deepEqual(new Uint8Array(await new Response(result.stream).arrayBuffer()),bytes);
  const playback=h.calls.find(x=>x.url.pathname.includes('/playurl'));
  assert.equal(playback.url.searchParams.get('cid'),'456');assert.ok(playback.url.searchParams.get('w_rid'));
  const media=h.calls.at(-1);assert.equal(media.options.headers.Referer,video+'?p=2');
  assert.equal(playback.options.headers.Origin,'https://www.bilibili.com');
});
test('short-link and CDN redirects cannot turn the service into an arbitrary relay',async()=>{
  const h=fixture({redirect:'https://127.0.0.1/private'});
  await assert.rejects(openBilibiliAudio('https://b23.tv/Abc123',{fetchImpl:h.fetchImpl}),/没有指向/);assert.equal(h.calls.length,1);
  for(const url of ['http://upos-a.bilivideo.com/a','https://bilivideo.com.evil.test/a','https://127.0.0.1/a','https://u:p@upos-a.bilivideo.com/a','https://upos-a.bilivideo.com:444/a'])assert.throws(()=>allowedMediaUrl(url));
  const redirect=fixture({media:()=>new Response(null,{status:302,headers:{location:'https://example.com/a'}})});
  await assert.rejects(openBilibiliAudio(video,{fetchImpl:redirect.fetchImpl}),/来源/);
  assert.equal(redirect.calls.length,4);
});
test('a platform-provided HTTPS backup is used when the primary media host is unsupported',async()=>{
  const h=fixture({playInfo:{code:0,data:{...play.data,dash:{audio:[{codecs:'mp4a.40.2',baseUrl:'http://other.example/audio',backupUrl:[cdn]}]}}}});
  const audio=await openBilibiliAudio(video,{fetchImpl:h.fetchImpl});
  assert.deepEqual(new Uint8Array(await new Response(audio.stream).arrayBuffer()),bytes);
  assert.equal(h.calls.at(-1).url.href,cdn);
});
test('upstream timeout stops the request and returns a recoverable error',async()=>{
  let aborted=false;
  const fetchImpl=async(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('stopped','AbortError'));},{once:true}));
  await assert.rejects(openBilibiliAudio(video,{fetchImpl,timeoutMs:10}),/长时间没有响应/);
  assert.equal(aborted,true);
});
test('one connection failure is retried at the same address, but a refusal is not retried',async()=>{
  const h=fixture();let calls=0;let firstUrl;
  const audio=await openBilibiliAudio(video,{fetchImpl:async(url,options)=>{
    if(!calls++){firstUrl=url;throw new TypeError('fetch failed');}
    if(calls===2)assert.equal(url,firstUrl);
    return h.fetchImpl(url,options);
  }});
  await new Response(audio.stream).arrayBuffer();assert.equal(calls,5);
  let denied=0;
  await assert.rejects(openBilibiliAudio(video,{fetchImpl:async()=>{denied++;return new Response('no',{status:403});}}),/拒绝/);
  assert.equal(denied,1);
});
test('private, preview, missing parts and excessive duration are rejected before media requests',async()=>{
  for(const meta of [{code:-403},{...metadata,data:{...metadata.data,pages:[{page:1,cid:123,duration:1801}]}}]) {
    const h=fixture({meta});await assert.rejects(openBilibiliAudio(video,{fetchImpl:h.fetchImpl}));assert.equal(h.calls.length,1);
  }
  const part=fixture();await assert.rejects(openBilibiliAudio(video+'?p=3',{fetchImpl:part.fetchImpl}),/分P/);
  const preview=fixture({playInfo:{code:0,data:{...play.data,is_preview:1}}});await assert.rejects(openBilibiliAudio(video,{fetchImpl:preview.fetchImpl}),/试看/);assert.equal(preview.calls.length,3);
});
test('HTTP denial, HTML and partial/oversized audio never become successful imports',async()=>{
  for(const make of [()=>new Response('no',{status:403}),()=>new Response(bytes,{status:206}),()=>new Response('<html>',{headers:{'content-type':'text/html'}}),()=>new Response(bytes,{headers:{'content-length':'9999'}}),()=>new Response('not media')]) {
    const h=fixture({media:make});await assert.rejects(openBilibiliAudio(video,{fetchImpl:h.fetchImpl,maxBytes:1024}));
  }
});
test('stream length mismatch and streamed byte limit propagate and cancel upstream',async()=>{
  let canceled=false;
  const h=fixture({media:()=>new Response(new ReadableStream({start(c){c.enqueue(bytes);c.enqueue(bytes);},cancel(){canceled=true;}}))});
  const result=await openBilibiliAudio(video,{fetchImpl:h.fetchImpl,maxBytes:60});
  await assert.rejects(new Response(result.stream).arrayBuffer(),/超过/);assert.equal(canceled,true);
  const truncated=fixture({media:()=>new Response(bytes,{headers:{'content-length':'50'}})});
  const audio=await openBilibiliAudio(video,{fetchImpl:truncated.fetchImpl});await assert.rejects(new Response(audio.stream).arrayBuffer(),/不完整/);
});
test('client cancellation releases the original media response',async()=>{
  let canceled=false;const h=fixture({media:()=>new Response(new ReadableStream({start(c){c.enqueue(bytes);},cancel(){canceled=true;}}))});
  const audio=await openBilibiliAudio(video,{fetchImpl:h.fetchImpl});await audio.stream.cancel();assert.equal(canceled,true);
});
test('HTTP endpoint checks origin, method and request size, exposes only safe audio metadata',async()=>{
  const endpoint='https://site.test/api/bilibili';const h=fixture();
  const make=(body,extra={})=>new Request(endpoint,{method:'POST',headers:{Origin:'https://lyhrmer.github.io','Content-Type':'application/json',Cookie:'user-cookie-not-forwarded',...extra},body:JSON.stringify(body)});
  const result=await handleBilibili(make({url:video}),{fetchImpl:h.fetchImpl});assert.equal(result.status,200);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),'https://lyhrmer.github.io');assert.equal(result.headers.get('content-type'),'audio/mp4');
  assert.match(decodeURIComponent(result.headers.get('x-media-name')),/公开采访/);assert.equal(result.headers.get('set-cookie'),null);
  await result.arrayBuffer();
  assert.equal((await handleBilibili(make({url:video},{Origin:'https://evil.test'}),{fetchImpl:h.fetchImpl})).status,403);
  assert.equal((await handleBilibili(make({url:'x'.repeat(3000)}),{fetchImpl:h.fetchImpl})).status,413);
  const preflight=await handleBilibili(new Request(endpoint,{method:'OPTIONS',headers:{Origin:'https://lyhrmer.github.io'}}));assert.equal(preflight.status,204);
});
