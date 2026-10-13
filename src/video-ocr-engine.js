// Image processing and CTC portions adapted from RapidOCR 1.4.4 / PaddleOCR.
// Copyright (c) 2020 PaddlePaddle Authors. Licensed under the Apache License,
// Version 2.0: https://www.apache.org/licenses/LICENSE-2.0
// See public/licenses/RapidOCR-PaddleOCR-Apache-2.0.txt for the full license.
import cvModule from '@techstark/opencv-js';
import Clipper from 'js-clipper';
import * as ort from 'onnxruntime-web/wasm';
import { getOcrAssets, loadOcrAsset } from './video-ocr-assets.js';

// The preprocessing, DB box expansion, perspective crop and CTC decoding follow
// RapidOCR/PaddleOCR (Apache-2.0). This is discriminative OCR of actual pixels;
// no expected lyrics, remote image URLs or generative text completion are used.
async function readyCv() {
  if (cvModule.Mat) return { cv: cvModule };
  return new Promise((resolve, reject) => {
    cvModule.onRuntimeInitialized = () => resolve({ cv: cvModule });
    cvModule.onAbort = reason => reject(new Error(`字幕图像运行库加载失败：${reason}`));
  });
}
const norm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function decodeOcrCtc(output, dictionary) {
  const [batch, steps, classes] = output.dims;
  if (batch !== 1 || classes !== dictionary.length || !Number.isSafeInteger(steps)) throw new Error('字幕识别模型与中文字典不匹配。');
  let previous = -1;
  let text = '';
  const characters = [];
  for (let step = 0; step < steps; step++) {
    let best = 0;
    let score = -Infinity;
    for (let c = 0; c < classes; c++) {
      const value = output.data[step * classes + c];
      if (value > score) { score = value; best = c; }
    }
    if (best !== 0 && best !== previous) {
      const character = dictionary[best];
      text += character;
      characters.push({ character, confidence: score, step });
    }
    previous = best;
  }
  return { text, confidence: characters.length ? characters.reduce((sum, char) => sum + char.confidence, 0) / characters.length : 0, characters };
}

function boxPoints(rect) {
  const radians = rect.angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const x = rect.center.x, y = rect.center.y;
  const w = rect.size.width / 2, h = rect.size.height / 2;
  const points = [[-w, -h], [w, -h], [w, h], [-w, h]]
    .map(([dx, dy]) => [x + dx * cos - dy * sin, y + dx * sin + dy * cos])
    .sort((a, b) => a[0] - b[0]);
  const left = points.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = points.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}
function minBox(cv, contour) {
  const rect = cv.minAreaRect(contour);
  return { box: boxPoints(rect), side: Math.min(rect.size.width, rect.size.height) };
}
function expandBox(box) {
  let twiceArea = 0, length = 0;
  for (let i = 0; i < 4; i++) {
    const a = box[i], b = box[(i + 1) % 4];
    twiceArea += a[0] * b[1] - a[1] * b[0];
    length += norm(a, b);
  }
  if (length <= 0) return [];
  const offset = new Clipper.ClipperOffset();
  offset.AddPath(box.map(([x, y]) => ({ X: Math.trunc(x), Y: Math.trunc(y) })), Clipper.JoinType.jtRound, Clipper.EndType.etClosedPolygon);
  const paths = [];
  offset.Execute(paths, Math.abs(twiceArea) / 2 * 1.6 / length);
  return paths.flatMap(points => points.flatMap(({ X, Y }) => [X, Y]));
}

function polygonScore(cv, values, width, height, box) {
  const x1 = clamp(Math.floor(Math.min(...box.map(p => p[0]))), 0, width - 1);
  const x2 = clamp(Math.ceil(Math.max(...box.map(p => p[0]))), 0, width - 1);
  const y1 = clamp(Math.floor(Math.min(...box.map(p => p[1]))), 0, height - 1);
  const y2 = clamp(Math.ceil(Math.max(...box.map(p => p[1]))), 0, height - 1);
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  const mask = cv.Mat.zeros(h, w, cv.CV_8UC1);
  const polygon = cv.matFromArray(4, 1, cv.CV_32SC2, box.flatMap(([x, y]) => [Math.trunc(x - x1), Math.trunc(y - y1)]));
  const polygons = new cv.MatVector();
  try {
    polygons.push_back(polygon);
    cv.fillPoly(mask, polygons, new cv.Scalar(1));
    let total = 0, count = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask.data[y * w + x]) { total += values[(y + y1) * width + x + x1]; count++; }
    }
    return count ? total / count : 0;
  } finally { mask.delete(); polygon.delete(); polygons.delete(); }
}
function detectBoxes(cv, output, imageWidth, imageHeight, boxThreshold) {
  const height = output.dims[2], width = output.dims[3];
  if (!height || !width || output.data.length !== height * width) throw new Error('字幕检测模型输出尺寸错误。');
  const bitmap = new cv.Mat(height, width, cv.CV_8UC1);
  for (let i = 0; i < width * height; i++) bitmap.data[i] = output.data[i] > 0.3 ? 255 : 0;
  const kernel = cv.Mat.ones(2, 2, cv.CV_8UC1);
  const contours = new cv.MatVector(), hierarchy = new cv.Mat();
  const boxes = [];
  try {
    cv.dilate(bitmap, bitmap, kernel);
    cv.findContours(bitmap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < Math.min(contours.size(), 1000); i++) {
      const contour = contours.get(i);
      try {
        const small = minBox(cv, contour);
        if (small.side < 3) continue;
        const detectionConfidence = polygonScore(cv, output.data, width, height, small.box);
        if (detectionConfidence < boxThreshold) continue;
        const expanded = expandBox(small.box);
        if (expanded.length < 8) continue;
        const enlarged = cv.matFromArray(expanded.length / 2, 1, cv.CV_32SC2, expanded);
        try {
          const found = minBox(cv, enlarged);
          if (found.side < 5) continue;
          const box = found.box.map(([x, y]) => [clamp(Math.round(x / width * imageWidth), 0, imageWidth - 1), clamp(Math.round(y / height * imageHeight), 0, imageHeight - 1)]);
          if (norm(box[0], box[1]) <= 3 || norm(box[0], box[3]) <= 3) continue;
          boxes.push({ box, detectionConfidence });
        } finally { enlarged.delete(); }
      } finally { contour.delete(); }
    }
  } finally { bitmap.delete(); kernel.delete(); contours.delete(); hierarchy.delete(); }
  return boxes.sort((a, b) => Math.abs(a.box[0][1] - b.box[0][1]) < 10 ? a.box[0][0] - b.box[0][0] : a.box[0][1] - b.box[0][1]);
}
function bgrTensor(cv, image, height, tensorWidth, resizedWidth = tensorWidth) {
  const resized = new cv.Mat();
  try {
    cv.resize(image, resized, new cv.Size(resizedWidth, height), 0, 0, cv.INTER_LINEAR);
    const plane = height * tensorWidth;
    const pixels = new Float32Array(3 * plane); // padding is normalized zero
    for (let y = 0; y < height; y++) for (let x = 0; x < resizedWidth; x++) {
      const source = (y * resizedWidth + x) * 3;
      const target = y * tensorWidth + x;
      for (let c = 0; c < 3; c++) pixels[c * plane + target] = resized.data[source + c] / 127.5 - 1;
    }
    return new ort.Tensor('float32', pixels, [1, 3, height, tensorWidth]);
  } finally { resized.delete(); }
}
function perspectiveCrop(cv, source, box) {
  const width = Math.max(1, Math.trunc(Math.max(norm(box[0], box[1]), norm(box[2], box[3]))));
  const height = Math.max(1, Math.trunc(Math.max(norm(box[0], box[3]), norm(box[1], box[2]))));
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, box.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const transform = cv.getPerspectiveTransform(from, to);
  const cropped = new cv.Mat();
  try {
    cv.warpPerspective(source, cropped, transform, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    if (height / width >= 1.5) cv.rotate(cropped, cropped, cv.ROTATE_90_COUNTERCLOCKWISE);
    return cropped;
  } catch (error) { cropped.delete(); throw error; }
  finally { from.delete(); to.delete(); transform.delete(); }
}
async function run(session, tensor) {
  try { return (await session.run({ [session.inputNames[0]]: tensor }))[session.outputNames[0]]; }
  finally { tensor.dispose(); }
}

export async function createOcrEngine({ baseUrl, runtimeUrl, precision = 'standard', onProgress = () => {} }) {
  const assets = getOcrAssets(precision);
  const { cv } = await readyCv();
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.mjs', runtimeUrl).href,
    wasm: new URL('ort-wasm-simd-threaded.wasm', runtimeUrl).href,
  };
  const sessions = [];
  let dictionary;
  try {
    // Load sequentially to avoid large overlapping download/compile peaks.
    for (const asset of assets) {
      const bytes = await loadOcrAsset(asset, baseUrl, onProgress);
      if (asset.name.endsWith('.txt')) {
        const characters = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/);
        if (characters.at(-1) === '') characters.pop();
        if (characters.length !== 6623) throw new Error('字幕中文字典不完整。');
        dictionary = ['', ...characters, ' '];
      } else {
        onProgress({ phase: 'initialize', asset: asset.name });
        sessions.push(await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
      }
    }
  } catch (error) {
    for (const session of sessions) await session.release();
    throw error;
  }
  const [detection, recognition, classification] = sessions;
  const model = precision === 'enhanced' ? 'PP-OCRv4 mobile detection + server recognition' : 'PP-OCRv4 mobile';
  return {
    model,
    async recognize(frame, { maxSide = 1920, maxLines = 32, recognitionThreshold = 0.5, boxThreshold = 0.5, colorMode = 'original' } = {}) {
      const { width, height, data } = frame;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 4 || height < 4 || width * height > 4194304 || data.length !== width * height * 4) throw new Error('视频画面太大或像素不完整。');
      if (!['original', 'green', 'red', 'blue'].includes(colorMode)) throw new Error('字幕颜色处理参数无效。');
      const rgba = cv.matFromArray(height, width, cv.CV_8UC4, data);
      const source = new cv.Mat();
      let detected;
      try {
        cv.cvtColor(rgba, source, cv.COLOR_RGBA2BGR);
        const ratio = Math.min(1, clamp(maxSide, 320, 1920) / Math.max(width, height));
        const inputWidth = Math.max(32, Math.round(width * ratio / 32) * 32);
        const inputHeight = Math.max(32, Math.round(height * ratio / 32) * 32);
        detected = await run(detection, bgrTensor(cv, source, inputHeight, inputWidth));
        const boxes = detectBoxes(cv, detected, width, height, clamp(boxThreshold, 0.1, 0.95));
        detected.dispose(); detected = undefined;
        const texts = [];
        for (const item of boxes.slice(0, clamp(maxLines, 1, 64))) {
          const crop = perspectiveCrop(cv, source, item.box);
          let classified, recognized;
          try {
            // Optional colour-channel isolation reduces coloured LED fringing.
            // It is a second observation of pixels, never a word substitution.
            if (colorMode !== 'original') {
              const channel = { blue: 0, green: 1, red: 2 }[colorMode];
              for (let i = 0; i < crop.data.length; i += 3) {
                const value = crop.data[i + channel];
                crop.data[i] = crop.data[i + 1] = crop.data[i + 2] = value;
              }
            }
            const clsWidth = Math.max(1, Math.min(192, Math.ceil(48 * crop.cols / crop.rows)));
            classified = await run(classification, bgrTensor(cv, crop, 48, 192, clsWidth));
            const turned = classified.data[1] > 0.9 && classified.data[1] > classified.data[0];
            if (turned) cv.rotate(crop, crop, cv.ROTATE_180);
            classified.dispose(); classified = undefined;
            const resizedWidth = Math.max(1, Math.min(1536, Math.ceil(48 * crop.cols / crop.rows)));
            const tensorWidth = Math.max(320, resizedWidth);
            recognized = await run(recognition, bgrTensor(cv, crop, 48, tensorWidth, resizedWidth));
            const decoded = decodeOcrCtc(recognized, dictionary);
            if (decoded.text && decoded.confidence >= clamp(recognitionThreshold, 0, 1)) texts.push({ ...decoded, ...item, rotated180: turned });
          } finally { crop.delete(); classified?.dispose(); recognized?.dispose(); }
        }
        return { texts, width, height, model, colorMode, detectedLines: boxes.length, truncated: boxes.length > maxLines };
      } finally { rgba.delete(); source.delete(); detected?.dispose(); }
    },
    async dispose() { for (const session of sessions) await session.release(); },
  };
}
