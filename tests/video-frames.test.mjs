import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideoFile, planVideoFrames, readVideoFrames } from '../src/video-frames.js';

test('video detection respects an explicit audio MIME and accepts videos without MIME', () => {
  assert.equal(isVideoFile({ name: 'recording.webm', type: 'audio/webm' }), false);
  assert.equal(isVideoFile({ name: 'clip.MP4', type: '' }), true);
  assert.equal(isVideoFile({ name: 'unknown', type: 'video/mp4' }), true);
  assert.equal(isVideoFile({ name: 'voice.wav', type: '' }), false);
});

test('short videos use at most two frames per second over the whole duration', () => {
  const result = planVideoFrames(21.75);
  assert.equal(result.sparse, false);
  assert.equal(result.times.length, 44);
  assert.ok(result.times[0] < 0.2);
  assert.ok(result.times.at(-1) > 21);
  assert.ok(result.times.every(time => time >= 0 && time < 21.75));
  assert.equal(new Set(result.times).size, result.times.length);
});

test('long videos have bounded cost with adjacent pairs near the beginning, middle and end', () => {
  const { times, sparse } = planVideoFrames(1800);
  assert.equal(sparse, true);
  assert.equal(times.length, 360);
  assert.ok(times.at(-1) > 1799);
  assert.ok(times.some(time => time > 895 && time < 905));
  for (let i = 0; i < times.length; i += 2) assert.ok(Math.abs(times[i + 1] - times[i] - 0.5) < 0.000001);
  assert.throws(() => planVideoFrames(1800.1), /30 分钟/);
  assert.throws(() => planVideoFrames(Infinity), /30 分钟/);
  assert.throws(() => planVideoFrames(0), /30 分钟/);
  assert.equal(planVideoFrames(0.01).times.length, 1);
});

async function mediaHarness(run, { drawError = false } = {}) {
  const oldDocument = globalThis.document;
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const resources = { created: [], revoked: [], videos: [], canvases: [] };
  class Video extends EventTarget {
    constructor() {
      super();
      this.style = {};
      this.duration = 1.1;
      this.videoWidth = 3840;
      this.videoHeight = 2160;
      this.seeks = [];
    }
    setAttribute() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
    set currentTime(time) { this.seeks.push(time); queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    pause() { this.paused = true; }
    remove() { this.removed = true; }
  }
  globalThis.document = {
    body: { appendChild: video => { video.connected = true; } },
    createElement(tag) {
      if (tag === 'video') { const video = new Video(); resources.videos.push(video); return video; }
      const canvas = { width: 0, height: 0, getContext: () => ({
        drawImage() { if (drawError) throw new Error('模拟画面读取失败'); },
        getImageData: () => ({ width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(4) }),
      }) };
      resources.canvases.push(canvas);
      return canvas;
    },
  };
  URL.createObjectURL = file => { resources.created.push(file); return 'blob:local-video'; };
  URL.revokeObjectURL = url => resources.revoked.push(url);
  try { await run(resources); }
  finally { globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
}

const mediaFile = { name: 'silent.mp4', type: 'video/mp4', size: 64, arrayBuffer: async () => new ArrayBuffer(64) };

test('frame extraction needs no audio track, preserves orientation and disposes every media resource', async () => {
  await mediaHarness(async resources => {
    const frames = [];
    const result = await readVideoFrames(mediaFile, { onFrame: frame => frames.push(frame) });
    assert.equal(result.duration, 1.1);
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.equal(frames.length, 3);
    assert.deepEqual(resources.videos[0].seeks, planVideoFrames(1.1).times);
    assert.equal(resources.videos[0].connected, true);
    assert.equal(resources.videos[0].paused, true);
    assert.equal(resources.videos[0].removed, true);
    assert.equal(resources.canvases[0].width, 0);
    assert.deepEqual(resources.revoked, ['blob:local-video']);
  });
});

test('canceling frame processing prevents later frames and revokes the local URL', async () => {
  await mediaHarness(async resources => {
    const controller = new AbortController();
    let seen = 0;
    await assert.rejects(readVideoFrames(mediaFile, { signal: controller.signal, onFrame() { seen++; controller.abort(); } }), { name: 'AbortError' });
    assert.equal(seen, 1);
    assert.equal(resources.videos[0].removed, true);
    assert.deepEqual(resources.revoked, ['blob:local-video']);
  });
});

test('canvas errors still release the video and its object URL', async () => {
  await mediaHarness(async resources => {
    await assert.rejects(readVideoFrames(mediaFile, { onFrame() {} }), /模拟画面读取失败/);
    assert.equal(resources.videos[0].removed, true);
    assert.deepEqual(resources.revoked, ['blob:local-video']);
  }, { drawError: true });
});
