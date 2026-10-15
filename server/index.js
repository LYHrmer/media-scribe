import { handleBilibili } from './bilibili.js';
// Best-effort per-isolate burst guard, not a distributed billing quota.
const recent=new Map();
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/api/bilibili') {
      if(request.method==='POST') {
        const now=Date.now(), key=request.headers.get('cf-connecting-ip')||'anonymous';
        for(const [id,item] of recent)if(now-item.start>60000)recent.delete(id);
        const item=recent.get(key)||{start:now,count:0};
        if(item.count>=20)return Response.json({error:'读取过于频繁，请一分钟后重试。'},{status:429,headers:{'Cache-Control':'no-store','Retry-After':'60',
          ...(request.headers.get('origin')==='https://lyhrmer.github.io'?{'Access-Control-Allow-Origin':'https://lyhrmer.github.io','Vary':'Origin'}:{})}});
        item.count++; if(recent.size<2048||recent.has(key))recent.set(key,item);
      }
      return handleBilibili(request);
    }
    if(path.startsWith('/api/'))return new Response('Not found',{status:404});
    return env.ASSETS.fetch(request);
  }
};
