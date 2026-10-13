/**
 * Local browser audio decoding. No media data is sent to any network endpoint.
 * Browser codecs vary: a playable video container is not necessarily decodable
 * by Web Audio. This first version deliberately avoids a large FFmpeg download.
 */
export const TARGET_SAMPLE_RATE = 16000;
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 30 * 60;

/**
 * Average channels so identical stereo stays at unity. Some recordings contain
 * an inverted copy of one channel; preserve one channel only when averaging
 * would erase virtually all non-silent audio. Ordinary stereo remains averaged.
 */
export function downmixChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError('音频没有可读取的声道。');
  }
  const length = channels[0]?.length;
  if (!Number.isInteger(length) || length < 1 || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== length)) {
    throw new TypeError('音频声道数据不完整。');
  }
  const mono = new Float32Array(length);
  const channelEnergy = new Float64Array(channels.length);
  let mixedEnergy = 0;
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const sample = channels[channelIndex][i];
      if (!Number.isFinite(sample)) throw new TypeError('音频含有无效的采样数据。');
      sum += sample;
      channelEnergy[channelIndex] += sample * sample;
    }
    mono[i] = sum / channels.length;
    mixedEnergy += mono[i] * mono[i];
  }
  let strongestChannel = 0;
  for (let channelIndex = 1; channelIndex < channelEnergy.length; channelIndex += 1) {
    if (channelEnergy[channelIndex] > channelEnergy[strongestChannel]) strongestChannel = channelIndex;
  }
  const sourceEnergy = channelEnergy[strongestChannel];
  if (sourceEnergy / length > 1e-12 && mixedEnergy <= sourceEnergy * 1e-8) {
    return channels[strongestChannel].slice();
  }
  return mono;
}

/** Preserve duration when sizing the OfflineAudioContext resampling buffer. */
export function getResampledLength(sampleLength, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!Number.isInteger(sampleLength) || sampleLength < 1 || !Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new RangeError('音频采样率或长度无效。');
  }
  return Math.max(1, Math.ceil(sampleLength * targetRate / sourceRate));
}

export function validateMediaFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size)) {
    throw new TypeError('请先选择一个音频或视频文件。');
  }
  if (file.size < 1) throw new Error('这个文件是空的，请重新选择。');
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('当前版本支持 300 MB 以内的文件。请先剪短文件，或从视频中导出 MP3 / WAV 音频。');
  }
}

export async function decodeAudio(file, { onStatus = () => {} } = {}) {
  validateMediaFile(file);
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineContextClass) {
    throw new Error('这个浏览器暂不支持本地音频处理。请使用较新的 Chrome、Edge 或 Safari。');
  }

  let context;
  let decoded;
  try {
    onStatus('正在本机读取音视频……');
    const bytes = await file.arrayBuffer();
    context = new AudioContextClass();
    onStatus('正在本机提取声音……');
    try {
      // decodeAudioData requires the complete file; this is not streaming decode.
      decoded = await context.decodeAudioData(bytes);
    } catch (error) {
      if (/memory|alloc|out of bounds|array buffer/i.test(String(error?.message || error))) {
        throw new Error('浏览器内存不足，未能读取文件。请关闭其他页面，或先把文件剪短后重试。');
      }
      const video = String(file.type || '').startsWith('video/') || /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(String(file.name || ''));
      throw new Error(video
        ? '浏览器无法提取这个视频中的声音，可能是编码不支持或没有音轨。请先将视频导出为 MP3 / WAV，再选择音频文件。'
        : '浏览器无法解码这个音频。请检查文件是否完整，或转换为 MP3 / WAV 后重试。');
    }
  } finally {
    if (context && typeof context.close === 'function') await context.close().catch(() => {});
  }

  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.length < 1) {
    throw new Error('没有读取到有效的音频。请换一个包含声音的文件。');
  }
  if (decoded.duration > MAX_DURATION_SECONDS) {
    throw new Error('当前版本支持 30 分钟以内的音视频。请先分段，再逐段转写。');
  }

  onStatus('正在本机整理音频……');
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  let mono = downmixChannels(channels);
  const duration = decoded.duration;
  const sourceRate = decoded.sampleRate;
  // Drop the multichannel buffer before model loading; browsers reclaim it by GC.
  decoded = null;

  if (sourceRate !== TARGET_SAMPLE_RATE) {
    try {
      const offline = new OfflineContextClass(1, getResampledLength(mono.length, sourceRate), TARGET_SAMPLE_RATE);
      const source = offline.createBufferSource();
      const buffer = offline.createBuffer(1, mono.length, sourceRate);
      buffer.copyToChannel(mono, 0);
      source.buffer = buffer;
      source.connect(offline.destination);
      source.start(0);
      const resampled = await offline.startRendering();
      mono = resampled.getChannelData(0).slice();
    } catch (error) {
      if (/memory|alloc|out of bounds|array buffer/i.test(String(error?.message || error))) {
        throw new Error('浏览器内存不足，未能处理音频。请先剪短文件，或关闭其他页面后重试。');
      }
      throw new Error('浏览器未能完成音频处理。请使用较新的 Chrome / Edge，或将音频转换为 16 kHz 单声道 WAV 后重试。');
    }
  }

  return { samples: mono, sampleRate: TARGET_SAMPLE_RATE, duration };
}
