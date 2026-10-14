// Models are static site assets. This adapter joins small, verified downloads
// into the ONNX response expected by Transformers.js; it never receives media.
const PART_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_BYTES = 512 * 1024 * 1024;
const MODEL_PATH = /^Xenova\/whisper-(?:tiny\/onnx\/(?:encoder_model_quantized|decoder_model_merged_quantized)|small\/onnx\/(?:encoder_model_q4f16|decoder_model_merged_q4f16))\.onnx$/;
const CONFIG_PATH = /^Xenova\/whisper-(tiny|small)\/([^/]+\.json)$/;
const REQUIRED_CONFIGS = new Set([
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json',
]);
const SHA256 = /^[a-f0-9]{64}$/i;

function assetError(message, cause) {
  return new Error(`MODEL_ASSET_FAILED: ${message}`, cause ? { cause } : undefined);
}

function checkResponse(response) {
  if (response.status === 401 || response.status === 403) {
    throw assetError(`网站资源访问被拒绝（HTTP ${response.status}）。请在系统浏览器中打开后重试；如果仍显示「blocked」，需要站点托管方排查。`);
  }
  if (!response.ok) throw assetError(`模型文件下载失败（HTTP ${response.status}），请刷新网页后重试。`);
  return response;
}

function htmlResponse(response, bytes) {
  if (/text\/html/i.test(response.headers.get('content-type') || '')) return true;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 128));
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix);
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) throw assetError('浏览器无法校验模型文件，请使用 HTTPS 打开网页。');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateManifest(manifest, filename) {
  if (!manifest || manifest.version !== 1
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > MAX_MODEL_BYTES
    || typeof manifest.sha256 !== 'string' || !SHA256.test(manifest.sha256)
    || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 32) {
    throw assetError('模型目录无效，请刷新网页后重试。');
  }
  let total = 0;
  manifest.parts.forEach((part, index) => {
    // Exact names also exclude absolute URLs, traversal, query strings and
    // reordered/duplicate parts supplied by a malformed manifest.
    if (!part || part.file !== `${filename}.part-${index}.bin`
      || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > PART_BYTES
      || typeof part.sha256 !== 'string' || !SHA256.test(part.sha256)) {
      throw assetError('模型分片目录无效，请刷新网页后重试。');
    }
    total += part.bytes;
  });
  if (total !== manifest.bytes) throw assetError('模型文件长度与目录不一致，请刷新网页后重试。');
  return manifest;
}

/**
 * Install a same-origin GET adapter for the app's quantized Whisper models.
 * `install:false` returns the adapter without changing global fetch (for tests).
 * Return value: { fetch(input, init), restore() }.
 */
export function installModelAssetFetch(baseUrl, {
  fetchImpl = globalThis.fetch.bind(globalThis),
  install = true,
} = {}) {
  const location = globalThis.location || globalThis.self?.location;
  const base = new URL(baseUrl, location?.href);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash
    || (location?.origin && base.origin !== location.origin)) {
    throw assetError('模型目录必须与网页位于同一地址。');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const originalFetch = globalThis.fetch;

  async function checkedFetch(url, signal) {
    let response;
    try {
      response = await fetchImpl(url.href, { method: 'GET', signal, credentials: 'same-origin', redirect: 'error' });
    } catch (error) {
      throw assetError('模型文件下载中断，请检查网络并重试。', error);
    }
    checkResponse(response);
    if (response.type === 'opaqueredirect'
      || (response.url && new URL(response.url).origin !== base.origin)) {
      throw assetError(`模型文件下载失败（${response.status}），请刷新网页后重试。`);
    }
    return response;
  }

  const fetchAssets = async (input, init) => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    let url;
    try { url = new URL(inputUrl, location?.href || base.href); }
    catch { return fetchImpl(input, init); }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      return fetchImpl(input, init);
    }
    const relativePath = url.pathname.slice(base.pathname.length);
    const config = CONFIG_PATH.exec(relativePath);
    if (!config && !url.pathname.endsWith('.onnx')) return fetchImpl(input, init);
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') throw assetError('模型文件仅支持下载。');
    if ((!config && !MODEL_PATH.test(relativePath)) || url.search || url.hash || url.username || url.password) {
      throw assetError('请求的模型文件不在支持列表中。');
    }
    if (config) {
      // Transformers probes optional metadata (e.g. processor_config.json).
      // A static site's SPA fallback can otherwise return HTML with status 200,
      // causing JSON parsing to fail instead of the intended optional fallback.
      if (!REQUIRED_CONFIGS.has(config[2])) return new Response(null, { status: 404 });
      let response;
      try { response = await fetchImpl(input, init); }
      catch (error) { throw assetError('模型配置文件下载中断，请检查网络并重试。', error); }
      checkResponse(response);
      if (response.ok && /text\/html/i.test(response.headers.get('content-type') || '')) {
        throw assetError('模型配置文件未能正确下载，请刷新网页后重试。');
      }
      return response;
    }
    const callerSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
    // The response body has its own lifetime: cancelling its reader must also
    // stop a part fetch, even when the caller supplied no AbortSignal.
    const downloadController = new AbortController();
    const signal = downloadController.signal;
    const abortFromCaller = () => downloadController.abort(callerSignal.reason);
    const cleanup = () => callerSignal?.removeEventListener('abort', abortFromCaller);
    const checkAborted = () => {
      if (signal.aborted) throw signal.reason || new DOMException('Download aborted', 'AbortError');
    };
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const filename = relativePath.split('/').at(-1);
    let manifest;
    try {
      checkAborted();
      const manifestResponse = await checkedFetch(new URL(`${relativePath}.manifest.json`, base), signal);
      const manifestText = await manifestResponse.text();
      checkAborted();
      if (manifestText.length > 64 * 1024 || /text\/html/i.test(manifestResponse.headers.get('content-type') || '')) {
        throw new Error('Invalid manifest response');
      }
      manifest = validateManifest(JSON.parse(manifestText), filename);
    } catch (error) {
      cleanup();
      downloadController.abort();
      if (error.message?.startsWith('MODEL_ASSET_FAILED:')) throw error;
      throw assetError('模型目录未能正确下载，请刷新网页后重试。', error);
    }

    const modelDirectory = new URL('./', url);
    let partIndex = 0;
    let offset = 0;
    // WebCrypto has no incremental hash API. Keep one bounded verification
    // buffer while consumers receive individually verified chunks for progress.
    let integrityBytes;
    let body;
    let cancelled = false;
    try {
      integrityBytes = new Uint8Array(manifest.bytes);
      body = new ReadableStream({
        async pull(controller) {
          try {
            checkAborted();
            const part = manifest.parts[partIndex];
            const response = await checkedFetch(new URL(part.file, modelDirectory), signal);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (cancelled) return;
            checkAborted();
            if (bytes.length !== part.bytes || htmlResponse(response, bytes)) {
              throw assetError('模型分片下载不完整，请检查网络并重试。');
            }
            if ((await digest(bytes)) !== part.sha256.toLowerCase()) {
              throw assetError('模型分片校验失败，请刷新网页后重试。');
            }
            if (cancelled) return;
            checkAborted();
            integrityBytes.set(bytes, offset);
            offset += bytes.length;
            partIndex += 1;
            if (partIndex === manifest.parts.length) {
              if ((await digest(integrityBytes)) !== manifest.sha256.toLowerCase()) {
                throw assetError('模型文件校验失败，请刷新网页后重试。');
              }
              integrityBytes = null;
              if (cancelled) return;
              checkAborted();
              cleanup();
              controller.enqueue(bytes);
              controller.close();
            } else {
              controller.enqueue(bytes);
            }
          } catch (error) {
            integrityBytes = null;
            cleanup();
            downloadController.abort();
            if (!cancelled) controller.error(error.message?.startsWith('MODEL_ASSET_FAILED:')
              ? error : assetError('模型文件下载中断，请重试。', error));
          }
        },
        cancel(reason) {
          cancelled = true;
          integrityBytes = null;
          cleanup();
          downloadController.abort(reason);
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(manifest.bytes),
        },
      });
    } catch (error) {
      cancelled = true;
      integrityBytes = null;
      cleanup();
      downloadController.abort();
      await body?.cancel(error).catch(() => {});
      throw assetError('模型文件无法初始化，请关闭其他页面后重试。', error);
    }
  };
  if (install) globalThis.fetch = fetchAssets;
  return {
    fetch: fetchAssets,
    restore() { if (install && globalThis.fetch === fetchAssets) globalThis.fetch = originalFetch; },
  };
}
