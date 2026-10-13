import * as ort from 'onnxruntime-web/wasm';
import { needsPunctuation, punctuationTokens, insertPredictedPunctuation } from './punctuation-text.js';
import { validatePunctuationManifest, loadPunctuationAsset } from './punctuation-assets.js';

export async function createPunctuationEngine({ baseUrl, runtimeUrl, onProgress = () => {} }) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.mjs', runtimeUrl).href,
    wasm: new URL('ort-wasm-simd-threaded.wasm', runtimeUrl).href,
  };
  const response = await fetch(new URL('manifest.json', baseUrl));
  if (!response.ok) throw new Error(`标点模型目录下载失败：HTTP ${response.status}`);
  if (/(?:text\/html|application\/xhtml)/iu.test(response.headers.get('content-type') || '')) throw new Error('标点模型目录返回了网页，请刷新页面重试。');
  const manifest = validatePunctuationManifest(await response.json());
  onProgress({ message: '正在准备中文标点模型（约 7.4 MB），文字留在本机。' });
  const [model, tokenBytes] = await Promise.all([loadPunctuationAsset(baseUrl, manifest.model), loadPunctuationAsset(baseUrl, manifest.tokens)]);
  const tokens = JSON.parse(new TextDecoder().decode(tokenBytes));
  const vocabulary = new Map(tokens.map((token, id) => [token, id]));
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  async function predict(ids) {
    const result = await session.run({ inputs: new ort.Tensor('int32', Int32Array.from(ids), [1, ids.length]), text_lengths: new ort.Tensor('int32', Int32Array.of(ids.length), [1]) });
    const values = result.logits.data;
    const predictions = [];
    for (let i = 0; i < ids.length; i++) {
      let best = 0;
      for (let j = 1; j < 6; j++) if (values[i * 6 + j] > values[i * 6 + best]) best = j;
      predictions.push(best);
    }
    for (const tensor of Object.values(result)) tensor.dispose?.();
    return predictions;
  }
  return {
    async punctuate(text) {
      if (!needsPunctuation(text)) return text;
      // Paragraphs retain their boundaries. Short bounded windows prevent very
      // long recordings from producing unbounded transformer attention buffers.
      const lines = text.split(/(\r?\n)/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 2) {
        const line = lines[lineIndex];
        if (!needsPunctuation(line)) continue;
        const words = punctuationTokens(line, vocabulary);
        if (!words.length) continue;
        const predictions = [];
        let start = 0;
        while (start < words.length) {
          const end = Math.min(words.length, start + 200);
          const result = await predict(words.slice(start, end).map(token => token.id));
          // Keep 20 tokens of right context at an internal window boundary.
          const accepted = end < words.length ? result.length - 20 : result.length;
          predictions.push(...result.slice(0, accepted));
          start += accepted;
        }
        lines[lineIndex] = insertPredictedPunctuation(line, words, predictions);
      }
      return lines.join('');
    },
    dispose: () => session.release(),
  };
}
