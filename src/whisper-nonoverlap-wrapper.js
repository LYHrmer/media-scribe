import { nonoverlapGuard } from './nonoverlap-guard.js';

export const VERIFIED_TRANSFORMERS_VERSION = '3.8.1';
const installed = new WeakMap();

function isKnownWindow(output) {
  return Array.isArray(output?.tokens)
    && Array.isArray(output?.stride)
    && output.stride.length === 3
    && output.stride.every(Number.isFinite);
}

/**
 * Install on one tokenizer instance after pipeline creation. Pass the actual
 * library.env.version; an upgrade requires reviewing the private decode API.
 * This helper never runs a model or changes generated tokens.
 */
export function installSafeTimestampMerge(tokenizer, { transformersVersion } = {}) {
  if (transformersVersion !== VERIFIED_TRANSFORMERS_VERSION) {
    throw new Error(`Whisper merge guard requires reviewed Transformers.js ${VERIFIED_TRANSFORMERS_VERSION}; received ${String(transformersVersion)}`);
  }
  if (!tokenizer || typeof tokenizer._decode_asr !== 'function') {
    throw new TypeError('Whisper merge guard requires a tokenizer instance with _decode_asr');
  }
  const prior = installed.get(tokenizer);
  if (prior) {
    if (tokenizer._decode_asr !== prior.wrapper) {
      throw new Error('Whisper tokenizer decoder changed after guard installation; review before wrapping again');
    }
    return prior.handle;
  }

  const original = tokenizer._decode_asr;
  const originalDescriptor = Object.getOwnPropertyDescriptor(tokenizer, '_decode_asr');
  function guardedDecode(...args) {
    const [sequences, options] = args;
    if (options?.return_timestamps !== true || !Array.isArray(sequences)
      || sequences.length < 2 || !isKnownWindow(sequences[0])
      || sequences[0].stride[1] !== 0
      || !Number.isSafeInteger(this?.timestamp_begin)
      || !Array.isArray(this?.all_special_ids)) {
      return original.apply(this, args);
    }

    const specialIds = new Set(this.all_special_ids);
    let adjusted = null;
    // Only a consecutive eligible prefix can be proven to start without
    // pending tokens/skip state. Never inspect later windows after rejection.
    for (let index = 0; index < sequences.length - 1; index++) {
      const output = sequences[index];
      const next = sequences[index + 1];
      if (!isKnownWindow(output) || !isKnownWindow(next)) break;
      const decision = nonoverlapGuard({
        output,
        next,
        timestampBegin: this.timestamp_begin,
        specialIds,
        precision: options.time_precision,
        returnTimestamps: options.return_timestamps,
        pendingTokens: false,
        skip: false,
      });
      if (!decision.accepted) break;

      adjusted ??= sequences.slice();
      const [length, left, right] = output.stride;
      // Equivalent in the pinned decoder to clearing this window's
      // last_timestamp: right_stride_start and time_offset stay identical.
      // Audio/model/observer objects remain untouched; only this decode call
      // receives a shallow output clone with adjusted stride metadata.
      adjusted[index] = { ...output, stride: [length - right, left, 0] };
    }

    if (!adjusted) return original.apply(this, args);
    const forwarded = args.slice();
    forwarded[0] = adjusted;
    return original.apply(this, forwarded);
  }

  const record = { wrapper: guardedDecode, handle: null };
  record.handle = Object.freeze({
    detach() {
      if (installed.get(tokenizer) !== record) return false;
      if (tokenizer._decode_asr !== guardedDecode) {
        throw new Error('Whisper tokenizer decoder changed before guard removal; refusing to overwrite it');
      }
      if (originalDescriptor) Object.defineProperty(tokenizer, '_decode_asr', originalDescriptor);
      else delete tokenizer._decode_asr;
      installed.delete(tokenizer);
      return true;
    },
  });
  tokenizer._decode_asr = guardedDecode;
  installed.set(tokenizer, record);
  return record.handle;
}

export function installWhisperNonoverlapGuard(tokenizer, scope) {
  installSafeTimestampMerge(tokenizer, scope);
  return tokenizer;
}

/**
 * Job-scoped production entry point. The worker serializes jobs; no global
 * prototype changes or state can leak from an English job to a cached Chinese
 * job. All other models/languages/modes use the untouched pipeline directly.
 */
export async function transcribeWithSafeTimestampMerge(transcriber, audio, options, {
  model, transformersVersion,
} = {}) {
  const eligible = model === 'Xenova/whisper-small'
    && options?.language === 'english'
    && options?.task === 'transcribe'
    && options?.return_timestamps === true;
  if (!eligible) return await transcriber(audio, options);

  const tokenizer = transcriber.tokenizer;
  const alreadyInstalled = installed.has(tokenizer);
  const handle = installSafeTimestampMerge(tokenizer, { transformersVersion });
  try {
    return await transcriber(audio, options);
  } finally {
    if (!alreadyInstalled) handle.detach();
  }
}
