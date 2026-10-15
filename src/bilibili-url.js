/** Only public video pages and the platform's own short links are accepted. */
export function parseBilibiliUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(url.hostname)) return null;
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('请使用不含账号信息的 B站 HTTPS 分享链接。');
  if (url.hostname === 'b23.tv') {
    if (!/^\/[A-Za-z0-9]{4,32}\/?$/.test(url.pathname)) throw new Error('这个 B站短链接格式不完整。');
    return { url: `https://b23.tv${url.pathname}`, short: true };
  }
  const id = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]{1,18})\/?$/i.exec(url.pathname)?.[1];
  if (!id) throw new Error('当前支持 B站普通 BV / av 视频及 b23.tv 分享链接；直播、番剧和个人主页暂不支持。');
  const rawPage = url.searchParams.get('p') || '1';
  if (!/^[1-9][0-9]{0,2}$/.test(rawPage)) throw new Error('B站分P编号无效，请重新复制视频链接。');
  const normalizedId = id.slice(0, 2).toUpperCase() === 'BV' ? `BV${id.slice(2)}` : `av${id.slice(2)}`;
  return { id: normalizedId, page: Number(rawPage), short: false,
    url: `https://www.bilibili.com/video/${normalizedId}${rawPage === '1' ? '' : `?p=${rawPage}`}` };
}

export function bilibiliEndpoint(location, configured = '') {
  if (configured) {
    const url = new URL(configured, location?.origin);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('B站读取服务必须使用 HTTPS。');
    return url.href;
  }
  if (location?.hostname === 'lyhrmer.github.io') return 'https://tingxie-local.mossy-loach-2602.chatgpt.site/api/bilibili';
  if (location?.hostname === 'tingxie-local.mossy-loach-2602.chatgpt.site') return '/api/bilibili';
  return '';
}
