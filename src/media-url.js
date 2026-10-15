import { MAX_FILE_BYTES } from './audio.js';
import { parseBilibiliUrl } from './bilibili-url.js';

const extensions = /\.(mp4|m4v|mov|webm|mkv|avi|mp3|wav|m4a|aac|ogg|opus|flac|aiff?|wma)$/i;
const pageHosts = /(^|\.)(bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com|youtube\.com|youtu\.be|youku\.com|iqiyi\.com|v\.qq\.com|tv\.cctv\.com)$/i;
const pageMessage = '这是视频播放网页，不是可直接读取的音视频文件。当前仅接入 B站普通视频；抖音、YouTube 等分享页暂不支持，请使用文件直链或选择本地文件。';
const streamMessage = '这个链接是分段播放列表（M3U8 / DASH），本地版暂不支持。请使用完整的 MP4 / MP3 等文件链接。';
const mimeExtensions = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac' };

export function parseMediaUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('请先粘贴音频或视频链接。');
  const matches = text.match(/https?:\/\/[^\s<>"“”]+/gi) || [];
  if (matches.length !== 1) throw new Error('请一次粘贴一个完整的 HTTPS 音视频链接。');
  let url;
  try { url = new URL(matches[0].replace(/[。，；！）】]+$/u, '')); }
  catch { throw new Error('链接格式不完整，请重新复制。'); }
  if (url.protocol !== 'https:') throw new Error('请使用 HTTPS 链接；安全网页无法读取普通 HTTP 音视频。');
  if (url.username || url.password) throw new Error('不支持含用户名或密码的链接。请使用无需登录的公开文件链接。');
  if (pageHosts.test(url.hostname)) {
    const page = parseBilibiliUrl(url.href);
    if (!page) throw new Error(pageMessage);
    return new URL(page.url);
  }
  if (/\.(m3u8|mpd)$/i.test(url.pathname)) throw new Error(streamMessage);
  if (/\.(?:html?|shtml|php|aspx)$/i.test(url.pathname)) throw new Error(pageMessage);
  url.hash = '';
  return url;
}

function sniff(bytes) {
  const ascii = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (/^(?:<!doctype\s+html|<html|<head|<body|<\?xml|\{\s*")/i.test(ascii)) return 'page';
  if (/^#EXTM3U/i.test(ascii)) return 'playlist';
  const four = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (four(4) === 'ftyp') return 'video/mp4';
  if (four(0) === 'RIFF' && four(8) === 'WAVE') return 'audio/wav';
  if (four(0) === 'RIFF' && four(8) === 'AVI ') return 'video/x-msvideo';
  if (four(0) === 'OggS') return 'audio/ogg';
  if (four(0) === 'fLaC') return 'audio/flac';
  if (ascii.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224) return 'audio/mpeg';
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return 'video/webm';
  return '';
}

function mediaName(url, type) {
  let name;
  try { name = decodeURIComponent(url.pathname.split('/').pop() || '链接音视频'); }
  catch { name = '链接音视频'; }
  name = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 100) || '链接音视频';
  if (!extensions.test(name)) name += '.' + (mimeExtensions[type] || (type.startsWith('audio/') ? 'mp3' : 'mp4'));
  return name;
}

/** Files load directly; supported Bilibili pages use our anonymous audio relay. */
export async function importMediaUrl(value, { signal, onProgress = () => {}, fetchImpl = fetch,
  maxBytes = MAX_FILE_BYTES, idleTimeoutMs = 45000, bilibiliService = '' } = {}) {
  const url = parseMediaUrl(value);
  const bili = parseBilibiliUrl(url.href);
  if (bili && !bilibiliService) throw new Error('此部署尚未配置 B站读取服务，请使用官方在线版或选择本地文件。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer, timedOut = false, reader, complete = false;
  const checkpoint = () => {
    if (controller.signal.aborted) throw new DOMException('已取消链接读取。', 'AbortError');
  };
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, idleTimeoutMs);
  };
  try {
    checkpoint();
    armTimer();
    onProgress({ loaded: 0, total: null, stage: bili ? 'resolve' : 'connect', platform: bili ? 'bilibili' : null });
    const response = await fetchImpl(bili ? bilibiliService : url.href, { method: bili ? 'POST' : 'GET', mode: 'cors', credentials: 'omit',
      ...(bili ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({url:bili.url}) } : {}),
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
    checkpoint();
    if (bili && !response.ok) {
      // Do not render a hosting/login HTML page or arbitrary upstream details.
      const jsonType = /application\/json/i.test(response.headers.get('content-type') || '');
      let message = '';
      if (jsonType) { try { const data = await response.json(); if (typeof data.error === 'string') message = data.error.slice(0, 240); } catch {} }
      throw new Error(message || (response.status === 429 ? '读取过于频繁，请稍后重试。' : 'B站读取服务暂不可用，请稍后重试或选择本地文件。'));
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '视频来源拒绝读取，可能需要登录、链接已过期或禁止外站访问。请换一个公开文件链接。'
      : response.status === 404 ? '这个链接的文件不存在或已失效，请重新复制。' : `视频来源返回 ${response.status}，请稍后重试或更换链接。`);
    if (response.status === 206) throw new Error('视频来源只返回了部分文件，无法完整识别。请更换完整文件链接。');
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/html|json|xml/.test(type) && !/dash/.test(type)) throw new Error(pageMessage);
    if (/mpegurl|dash\+xml/.test(type)) throw new Error(streamMessage);
    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    if (total > maxBytes) throw new Error('链接中的文件超过 300 MB，请使用较短的视频或音频。');
    if (!response.body?.getReader) throw new Error('浏览器暂不支持链接读取，请更新浏览器或选择本地文件。');
    reader = response.body.getReader();
    const chunks = [];
    const prefix = new Uint8Array(256);
    let prefixLength = 0, loaded = 0;
    onProgress({ loaded, total, platform: bili ? 'bilibili' : null });
    while (true) {
      checkpoint(); armTimer();
      const { done, value: chunk } = await reader.read();
      checkpoint();
      if (done) break;
      loaded += chunk.byteLength;
      if (loaded > maxBytes) throw new Error('链接中的文件超过 300 MB，已停止读取。请使用较短的视频或音频。');
      const part = chunk.subarray(0, prefix.length - prefixLength);
      prefix.set(part, prefixLength); prefixLength += part.length;
      const signature = sniff(prefix.subarray(0, prefixLength));
      if (signature === 'page') throw new Error(pageMessage);
      if (signature === 'playlist') throw new Error(streamMessage);
      chunks.push(chunk);
      onProgress({ loaded, total, platform: bili ? 'bilibili' : null });
    }
    if (!loaded) throw new Error('链接返回了空文件，请更换链接。');
    if (total && loaded !== total) throw new Error('音视频传输不完整，请重新读取链接。');
    const signature = sniff(prefix.subarray(0, prefixLength));
    const audioExtension = /\.(m4a|aac|mp3|wav|ogg|opus|flac)$/i.exec(url.pathname)?.[1].toLowerCase();
    const inferred = audioExtension ? ({ m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' })[audioExtension] : signature;
    const mediaType = /^(audio|video)\//.test(type) ? type : inferred;
    if (!mediaType && !extensions.test(url.pathname)) throw new Error('这个链接没有返回可识别的音视频文件，请使用 MP4 / MP3 等文件直链。');
    let filename = mediaName(url, mediaType || '');
    if (bili) {
      try { filename = decodeURIComponent(response.headers.get('x-media-name') || '') || 'B站音频.m4a'; } catch { filename = 'B站音频.m4a'; }
      filename = Array.from(filename.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')).slice(0,110).join('');
      if (!filename.endsWith('.m4a')) filename += '.m4a';
    }
    const file = new File(chunks, filename, { type: bili ? 'audio/mp4' : mediaType || '' });
    complete = true;
    return file;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('已取消链接读取。', 'AbortError');
    if (timedOut) throw new Error('视频来源长时间没有响应，已停止读取。请检查网络或换一个链接。');
    if (error instanceof TypeError) throw new Error(bili ? 'B站音轨读取中断或服务无法连接，请检查网络后重试。已有文字仍保留。' : '浏览器无法读取此链接：可能是网络问题、链接失效，或来源网站不允许跨站读取。请使用允许外站读取的公开音视频直链，或选择本地文件。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!complete) { controller.abort(); await reader?.cancel().catch(() => {}); }
    reader?.releaseLock();
  }
}
