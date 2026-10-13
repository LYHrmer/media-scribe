import { MAX_DURATION_SECONDS, validateMediaFile } from './audio.js';

export function isVideoFile(file) {
  if (String(file?.type || '').startsWith('audio/')) return false;
  return String(file?.type || '').startsWith('video/') || /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(String(file?.name || ''));
}

/** Adjacent samples support consensus; long files retain pairs across the full duration. */
export function planVideoFrames(duration, { fps = 2, maxFrames = 360 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) {
    throw new RangeError('当前版本支持 30 分钟以内的视频。请先分段，再逐段转写。');
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > 2 || !Number.isInteger(maxFrames) || maxFrames < 2) {
    throw new RangeError('视频抽帧参数无效。');
  }
  const interval = 1 / fps;
  const count = Math.max(1, Math.ceil(duration / interval));
  const inset = Math.min(0.125, duration / 4);
  const last = Math.max(inset, duration - Math.min(0.05, duration / 4));
  let times;
  if (count <= maxFrames) {
    times = Array.from({ length: count }, (_, i) => Math.min(last, inset + i * interval));
  } else {
    const pairs = Math.floor(maxFrames / 2);
    const stride = (Math.max(inset, last - interval) - inset) / Math.max(1, pairs - 1);
    times = Array.from({ length: pairs }, (_, i) => [
      Math.min(last, inset + i * stride),
      Math.min(last, inset + i * stride + interval),
    ]).flat();
  }
  return { times: [...new Set(times)], sampleInterval: interval, sparse: count > maxFrames };
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('已停止视频读取。', 'AbortError');
}

function waitMedia(video, eventName, signal, begin = () => {}) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventName, ready);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', canceled);
    };
    const finish = (error) => { cleanup(); error ? reject(error) : resolve(); };
    const ready = () => finish();
    const failed = () => finish(new Error('浏览器无法读取这个视频画面。请尝试 MP4（H.264）视频，或切换「仅识别声音」。'));
    const canceled = () => finish(new DOMException('已停止视频读取。', 'AbortError'));
    video.addEventListener(eventName, ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', canceled, { once: true });
    timer = setTimeout(() => finish(new Error('读取视频画面超时。请换一个较短的视频，或切换「仅识别声音」。')), 20000);
    try { begin(); } catch (error) { finish(error); }
  });
}

/** Decode one local frame at a time. Pixel data is never accumulated or uploaded. */
export async function readVideoFrames(file, {
  signal, onMetadata = () => {}, onFrame, maxSide = 1920, maxFrames = 360,
} = {}) {
  validateMediaFile(file);
  if (typeof onFrame !== 'function') throw new TypeError('缺少视频画面处理函数。');
  aborted(signal);
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('这个浏览器不支持读取视频画面。请切换「仅识别声音」。');
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  // A connected, off-screen element also works on browsers that defer decoding
  // detached media. No play(), camera, microphone, or autoplay permission is used.
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  try {
    await waitMedia(video, 'loadedmetadata', signal, () => { video.src = url; video.load(); });
    const duration = video.duration;
    const plan = planVideoFrames(duration, { maxFrames });
    if (!video.videoWidth || !video.videoHeight) throw new Error('这个文件没有可读取的视频画面。请切换「仅识别声音」。');
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const metadata = { duration, width: canvas.width, height: canvas.height, frameCount: plan.times.length, sampleInterval: plan.sampleInterval, sparse: plan.sparse };
    onMetadata(metadata);
    for (let index = 0; index < plan.times.length; index++) {
      aborted(signal);
      const time = plan.times[index];
      await waitMedia(video, 'seeked', signal, () => { video.currentTime = time; });
      aborted(signal);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      await onFrame({ time, pixels, index, ...metadata });
    }
    aborted(signal);
    return metadata;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    canvas.width = canvas.height = 0;
    URL.revokeObjectURL(url);
  }
}
