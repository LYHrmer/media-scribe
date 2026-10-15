import { parseBilibiliUrl } from '../src/bilibili-url.js';

const API = 'https://api.bilibili.com';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SECONDS = 1800;
const mixinOrder = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
class LinkError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

// Public WBI request checksum (not an authentication secret or password hash).
export function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(length); buffer.set(bytes); buffer[bytes.length] = 128;
  const data = new DataView(buffer.buffer);
  data.setUint32(length - 8, bytes.length * 8, true);
  data.setUint32(length - 4, Math.floor(bytes.length / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const shifts = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
  for (let offset = 0; offset < length; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const round = i >>> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5*i+1)%16 : round === 2 ? (3*i+5)%16 : (7*i)%16;
      const n = (a + f + Math.floor(Math.abs(Math.sin(i+1))*4294967296) + data.getUint32(offset+4*g, true)) | 0;
      const s = shifts[round][i%4];
      [a,b,c,d] = [d,(b + ((n << s) | (n >>> (32-s)))) | 0,b,c];
    }
    a0=(a0+a)|0; b0=(b0+b)|0; c0=(c0+c)|0; d0=(d0+d)|0;
  }
  return [a0,b0,c0,d0].flatMap(n => [0,8,16,24].map(s => ((n >>> s)&255).toString(16).padStart(2,'0'))).join('');
}

export function signWbi(params, images, now = Date.now()) {
  const source = [images?.img_url, images?.sub_url].map(value => {
    try { return new URL(value).pathname.split('/').pop().split('.')[0]; } catch { return ''; }
  }).join('');
  if (!/^[a-f0-9]{64}$/i.test(source)) throw new LinkError('B站暂未返回可用的匿名播放参数，请稍后重试。', 502);
  const key = mixinOrder.map(i => source[i]).join('').slice(0,32);
  const values = { ...params, wts: Math.floor(now/1000) };
  const query = new URLSearchParams(Object.keys(values).sort().map(k => [k,String(values[k]).replace(/[!'()*]/g,'')]));
  query.set('w_rid', md5(query.toString()+key));
  return query.toString();
}

export function allowedMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new LinkError('B站未返回有效音轨。', 502); }
  const host = url.hostname.toLowerCase();
  // No client-supplied destination, IP literal, arbitrary CDN, or port is relayed.
  const valid = host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn')
    || /^upos-[a-z0-9-]+\.akamaized\.net$/.test(host);
  if (url.protocol !== 'https:' || !valid || url.port || url.username || url.password) throw new LinkError('音轨来源暂不在支持范围内。', 502);
  return url;
}

async function limitedText(response, limit, oversizedStatus=502) {
  const reader = response.body?.getReader();
  if (!reader) throw new LinkError('来源没有返回内容。', 502);
  const chunks=[]; let length=0;
  try {
    while (true) {
      const {value,done}=await reader.read(); if(done) break;
      length+=value.byteLength; if(length>limit) throw new LinkError('请求或来源内容过大。',oversizedStatus);
      chunks.push(value);
    }
    const data = new Uint8Array(length); let offset=0;
    for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder().decode(data);
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

/** Resolve and stream one anonymous public audio track. Never use visitor credentials. */
export async function openBilibiliAudio(value, { fetchImpl=fetch, signal, maxBytes=MAX_BYTES, timeoutMs=45000 }={}) {
  let page;
  try { page=parseBilibiliUrl(value); } catch(error) { throw new LinkError(error.message,400); }
  if (!page) throw new LinkError('请粘贴 B站普通视频或 b23.tv 分享链接。');
  const abort = new AbortController();
  const onAbort=()=>abort.abort();
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted) onAbort();
  let timer, timedOut=false, reader, released=false;
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;abort.abort();},timeoutMs);};
  const cleanup=()=>{if(released)return;released=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);abort.abort();};
  const get=async(url,headers={})=>{
    const options={method:'GET',headers:{'User-Agent':'MediaScribe/0.5.7 (+https://github.com/LYHrmer/media-scribe)',...headers},redirect:'manual',credentials:'omit',cache:'no-store',signal:abort.signal};
    arm();
    try{return await fetchImpl(url,options);}
    catch(error){
      // One same-address retry for a connection failure before any response.
      // Never retry an access refusal, rate limit, cancellation or partial body.
      if(!(error instanceof TypeError)||abort.signal.aborted)throw error;
      arm();return fetchImpl(url,options);
    }
  };
  const json=async(path,referer)=>{
    const response=await get(API+path,{Referer:referer,Origin:'https://www.bilibili.com',Accept:'application/json'});
    if(!response.ok) {
      // Operational diagnostics omit the user's video ID, query and all headers.
      const diagnostic={endpoint:path.split('?')[0],status:response.status};
      try{
        const body=await limitedText(response,65536);
        try{const data=JSON.parse(body);diagnostic.code=data.code;diagnostic.message=String(data.message||'').slice(0,120);}
        catch{diagnostic.title=/<title[^>]*>([^<]{0,120})<\/title>/i.exec(body)?.[1]||'';}
      }catch{}
      console.warn('[Bilibili upstream]',JSON.stringify(diagnostic));
      throw new LinkError(response.status===403||response.status===412?'B站暂时拒绝匿名读取，请稍后重试或选择本地文件。':'B站接口暂不可用，请稍后重试。',502);
    }
    try { return JSON.parse(await limitedText(response,1024*1024)); }
    catch(error){if(error instanceof LinkError)throw error;throw new LinkError('B站未返回有效播放信息。',502);}
  };
  try {
    for(let hops=0;page.short;hops++) {
      if(hops>=3) throw new LinkError('B站短链接跳转过多，请复制完整 BV 链接。');
      const response=await get(page.url);
      const location=response.headers.get('location'); await response.body?.cancel().catch(()=>{});
      if(![301,302,303,307,308].includes(response.status)||!location) throw new LinkError('B站短链接未能展开，请复制视频页的完整 BV 链接。');
      page=parseBilibiliUrl(new URL(location,page.url).href);
      if(!page) throw new LinkError('这个短链接没有指向支持的 B站视频。');
    }
    const query=new URLSearchParams(page.id.startsWith('BV')?{bvid:page.id}:{aid:page.id.slice(2)});
    const detail=await json('/x/web-interface/view?'+query,page.url);
    if(detail.code!==0||!detail.data) throw new LinkError('这个 B站视频不可匿名读取，可能已失效、受限或需要登录。');
    const meta=detail.data;
    const part=meta.pages?.find(item=>item.page===page.page);
    if(!part?.cid) throw new LinkError('找不到这个分P，请检查链接中的 p 编号。');
    if(meta.rights?.is_stein_gate||meta.is_upower_exclusive||meta.is_upower_pay) throw new LinkError('当前不读取互动或付费专享视频。');
    const duration=Number(part.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>MAX_SECONDS) throw new LinkError('B站单段音频需在 30 分钟以内，请选择较短的分P。');
    if(!/^BV[A-Za-z0-9]{10}$/.test(meta.bvid||'')) throw new LinkError('B站视频编号无效。',502);
    const referer=`https://www.bilibili.com/video/${meta.bvid}${page.page>1?`?p=${page.page}`:''}`;
    const nav=await json('/x/web-interface/nav',referer);
    const signed=signWbi({bvid:meta.bvid,cid:part.cid,fnval:16,qn:16,fnver:0,fourk:0},nav.data?.wbi_img);
    const info=await json('/x/player/wbi/playurl?'+signed,referer);
    if(info.code!==0||!info.data) throw new LinkError('B站暂未允许匿名播放此视频，请稍后重试或选择本地文件。');
    const play=info.data;
    if(play.is_preview||play.is_drm||play.drm_tech_type||play.has_paid===false&&play.is_pay) throw new LinkError('当前不读取付费试看或受保护的音轨。');
    const mediaDuration=Number(play.timelength);
    if(!Number.isFinite(mediaDuration)||mediaDuration<=0||mediaDuration>MAX_SECONDS*1000 || mediaDuration<(duration-3)*1000) throw new LinkError('B站只返回了不完整或超出时长限制的音轨。');
    const tracks=(play.dash?.audio||[]).filter(x=>/^mp4a\./i.test(x.codecs||'') && (x.baseUrl||x.base_url));
    tracks.sort((a,b)=>(Number(b.bandwidth)||0)-(Number(a.bandwidth)||0));
    if(!tracks.length) throw new LinkError('这个 B站视频没有可匿名读取的完整 AAC 音轨。');
    // Select only a platform-provided HTTPS source on a known media CDN.
    // Some API responses put an HTTP or unsupported host before a valid backup.
    let audioUrl, response;
    for(const track of tracks){
      for(const candidate of [track.baseUrl||track.base_url,...(track.backupUrl||track.backup_url||[])]){
        try{audioUrl=allowedMediaUrl(candidate);break;}catch{}
      }
      if(audioUrl)break;
    }
    if(!audioUrl)throw new LinkError('音轨来源暂不在支持范围内。',502);
    for(let hops=0;hops<3;hops++) {
      response=await get(audioUrl.href,{Referer:referer});
      if(![301,302,303,307,308].includes(response.status))break;
      const location=response.headers.get('location'); await response.body?.cancel().catch(()=>{});
      if(!location||hops===2)throw new LinkError('B站音轨跳转异常，请稍后重试。',502);
      audioUrl=allowedMediaUrl(new URL(location,audioUrl).href);
    }
    if(response.status!==200) { await response.body?.cancel().catch(()=>{});throw new LinkError(response.status===403?'B站音轨拒绝读取，请稍后重试或选择本地文件。':'B站未返回完整音轨，请稍后重试。',502); }
    const length=Number(response.headers.get('content-length'));
    if(length>maxBytes){await response.body?.cancel().catch(()=>{});throw new LinkError('B站音轨超过 64 MB，请选择较短的视频。');}
    if(/html|json|xml/i.test(response.headers.get('content-type')||'')){await response.body?.cancel().catch(()=>{});throw new LinkError('B站返回了网页，未取得音频。',502);}
    reader=response.body?.getReader(); if(!reader)throw new LinkError('B站音轨为空。',502);
    const prefix=[]; let total=0;
    while(total<12){arm();const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;prefix.push(chunk.value);if(total>maxBytes)throw new LinkError('B站音轨超过 64 MB。');}
    const first=new Uint8Array(Math.min(total,12));let copied=0;
    for(const chunk of prefix){const slice=chunk.subarray(0,12-copied);first.set(slice,copied);copied+=slice.length;if(copied===12)break;}
    if(String.fromCharCode(...first.subarray(4,8))!=='ftyp')throw new LinkError('B站没有返回可解码的 MP4 音轨。',502);
    const title=String(meta.title||meta.bvid)+(meta.pages.length>1?` · P${page.page} ${part.part||''}`:'');
    let finished=false;
    const stream=new ReadableStream({
      async pull(controller){
        try{
          if(prefix.length){controller.enqueue(prefix.shift());return;}
          arm();const {done,value}=await reader.read();
          if(done){if(length>0&&length!==total)throw new LinkError('音轨传输不完整，请重新读取。',502);finished=true;cleanup();reader.releaseLock();controller.close();return;}
          total+=value.length;if(total>maxBytes)throw new LinkError('B站音轨超过 64 MB，已停止读取。');
          controller.enqueue(value);
        }catch(error){cleanup();await reader.cancel().catch(()=>{});reader.releaseLock();controller.error(error);}
      },
      async cancel(){if(finished)return;cleanup();await reader.cancel().catch(()=>{});reader.releaseLock();}
    });
    return {stream,title,duration,bytes:length>0?length:null};
  }catch(error){cleanup();await reader?.cancel().catch(()=>{});reader?.releaseLock();
    if(signal?.aborted)throw new DOMException('已取消读取。','AbortError');
    if(timedOut)throw new LinkError('B站来源长时间没有响应，请稍后重试。',504);
    throw error;
  }
}

export async function handleBilibili(request,{fetchImpl=fetch, maxBytes=MAX_BYTES}={}) {
  const origin=request.headers.get('origin');
  const permitted=new Set([new URL(request.url).origin,'https://lyhrmer.github.io']);
  const cors={'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(!origin||!permitted.has(origin))return Response.json({error:'请从听写匣页面读取链接。'},{status:403,headers:cors});
  cors['Access-Control-Allow-Origin']=origin;
  cors['Access-Control-Expose-Headers']='Content-Length, X-Media-Name, X-Media-Duration';
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}});
  if(request.method!=='POST')return Response.json({error:'需要 POST 请求。'},{status:405,headers:{...cors,Allow:'POST, OPTIONS'}});
  try{
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw new LinkError('请求格式不正确。',415);
    if(Number(request.headers.get('content-length'))>2048)throw new LinkError('链接请求过大。',413);
    let body;
    try{body=JSON.parse(await limitedText(request,2048,413));}catch(error){if(error instanceof LinkError)throw error;throw new LinkError('链接请求格式不完整。',400);}
    const media=await openBilibiliAudio(body.url,{fetchImpl,signal:request.signal,maxBytes});
    const safeName=Array.from(media.title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g,'_')).slice(0,100).join('')+'.m4a';
    const headers={...cors,'Content-Type':'audio/mp4','X-Media-Name':encodeURIComponent(safeName),'X-Media-Duration':String(media.duration)};
    if(media.bytes)headers['Content-Length']=String(media.bytes);
    return new Response(media.stream,{headers});
  }catch(error){
    return Response.json({error:error instanceof LinkError?error.message:error.name==='AbortError'?'已取消链接读取。':'B站读取服务暂不可用，请稍后重试。'}, {status:error.status||502,headers:cors});
  }
}
