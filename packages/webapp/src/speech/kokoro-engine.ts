/**
 * Lazy Kokoro-82M loader — the on-device speech-SYNTHESIS engine behind
 * spoken replies and the `say` command's enhanced voice.
 *
 * Same lazy-fetch contract as the whisper engine: nothing is bundled. The
 * first call dynamically imports `kokoro-js` (deduped onto the workspace's
 * `@huggingface/transformers` by the Vite configs) and reads the
 * `onnx-community/Kokoro-82M-v1.0-ONNX` model (~80-300 MB depending on
 * dtype; https://ttslab.dev/models/kokoro-82m) from the VFS at
 * `/workspace/models/onnx-community/Kokoro-82M-v1.0-ONNX/` (Wave 7 swap —
 * no Hugging Face CDN). Weights must be staged via the `hf download`
 * shell command before first call. The "download" warmup is CHAINED:
 * `whisper-engine.ts` kicks it automatically once speech recognition is
 * ready, so by the time a dictated turn completes the reply voice is
 * usually warm.
 *
 * Kokoro v1.0 ONNX ships English voices only (`a*` = en-US, `b*` = en-GB) —
 * engine pick for other languages stays on Web Speech (see `speak.ts`).
 */

import { createLogger } from '../core/logger.js';
import { createDownloadTracker, type DownloadSnapshot } from './download-progress.js';
import { assertLocalModelPresent, configureTransformersEnv } from './transformers-env.js';
import type { WhisperProgress } from './whisper-engine.js';

const log = createLogger('speech:kokoro');

/** The TTS model the enhanced voice runs (https://ttslab.dev/models/kokoro-82m). */
export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** A kokoro voice, normalized for pickers and `say --list`. */
export interface KokoroVoiceInfo {
  /** Stable voice id, e.g. `af_heart`. */
  id: string;
  /** Display name, e.g. `Heart`. */
  name: string;
  /** BCP-47-ish tag derived from the id prefix (`a*` en-US, `b*` en-GB). */
  lang: string;
  gender?: string;
}

/** One synthesized PCM chunk — a sentence under `synthesizeStream`. */
export interface KokoroAudioChunk {
  audio: Float32Array;
  sampleRate: number;
}

/** The loaded engine: text in, PCM out. */
export interface KokoroTts {
  /**
   * Synthesize speech in one shot; resolves mono PCM + its sample rate.
   *
   * NOTE: kokoro-js' `generate()` tokenizes the whole input with truncation
   * and hard-clamps to ~510 tokens (kokoro's 512-token context). Anything
   * longer is silently cut off — see #1038. Prefer `synthesizeStream()` for
   * any reply that may exceed a few sentences.
   */
  synthesize(text: string, opts?: { voice?: string; speed?: number }): Promise<KokoroAudioChunk>;
  /**
   * Synthesize speech sentence-by-sentence via kokoro-js' `tts.stream()` —
   * each sentence is tokenized + truncated INDIVIDUALLY, so a multi-paragraph
   * reply yields multiple chunks instead of being clamped to ~510 tokens.
   * Consumers play each chunk back-to-back for continuous audio (`speak.ts`).
   */
  synthesizeStream(
    text: string,
    opts?: { voice?: string; speed?: number; splitPattern?: RegExp }
  ): AsyncGenerator<KokoroAudioChunk, void, void>;
  /** The available voices. */
  voices(): KokoroVoiceInfo[];
}

export type KokoroLoadState = 'idle' | 'loading' | 'ready' | 'failed';

/** Map kokoro-js's voices object into the normalized picker shape. */
export function toKokoroVoiceInfos(
  voices: Record<string, { name?: string; language?: string; gender?: string }>
): KokoroVoiceInfo[] {
  return Object.entries(voices).map(([id, meta]) => ({
    id,
    name: meta.name || id,
    lang: meta.language === 'en-gb' || id.startsWith('b') ? 'en-GB' : 'en-US',
    ...(meta.gender ? { gender: meta.gender } : {}),
  }));
}

/**
 * StyleTTS2 ⇄ workspace-transformers reconciliation.
 *
 * kokoro-js@1.2.1 is written + tested against `@huggingface/transformers` ^3.x,
 * where the `style_text_to_speech_2` MODEL TYPE is registered by its model_type
 * STRING. The Vite configs dedupe kokoro onto the workspace 4.x (one
 * transformers + one ort), whose registry refactor keys the type map by CLASS
 * NAME (`StyleTextToSpeech2Model`) only — so a config-only resolve of
 * `model_type: 'style_text_to_speech_2'` misses and warns "Architecture(s) not
 * found in MODEL_TYPE_MAPPING … Falling back to EncoderOnly" (the warning fires
 * from the progress-file enumeration `kokoro` triggers by passing a
 * `progress_callback`). The Kokoro v1.0 `config.json` omits the `architectures`
 * field 4.x's resolver checks FIRST; supplying the architecture the model
 * genuinely is turns the lookup into a clean direct hit on the registered class
 * — no fallback, identical resolved type (EncoderOnly). whisper is untouched
 * (its config already declares `architectures` and a different model_type).
 */
const STYLE_TTS2_MODEL_TYPE = 'style_text_to_speech_2';
const STYLE_TTS2_ARCHITECTURE = 'StyleTextToSpeech2Model';

/** Minimal slice of a transformers config the shim reads/patches. */
interface PretrainedConfigLike {
  model_type?: string;
  architectures?: string[];
}

/**
 * Fill in the StyleTTS2 architecture when a config declares the
 * `style_text_to_speech_2` model_type but omits `architectures` (the Kokoro
 * v1.0 case). Pure + idempotent; mutates and returns the same object. No-op for
 * any other model (whisper) or a config that already lists architectures.
 */
export function injectStyleTts2Architectures<T extends PretrainedConfigLike>(config: T): T {
  if (
    config?.model_type === STYLE_TTS2_MODEL_TYPE &&
    (!Array.isArray(config.architectures) || config.architectures.length === 0)
  ) {
    config.architectures = [STYLE_TTS2_ARCHITECTURE];
  }
  return config;
}

/** Idempotency marker on a patched `AutoConfig.from_pretrained`. */
const STYLE_TTS2_SHIM_MARKER = Symbol.for('slicc.kokoro.style-tts2-arch-shim');

/** Structural slice of the deduped transformers module the shim touches. */
type AutoConfigLoader = ((...args: unknown[]) => Promise<unknown>) & {
  [STYLE_TTS2_SHIM_MARKER]?: true;
};
interface TransformersWithAutoConfig {
  AutoConfig?: { from_pretrained?: AutoConfigLoader };
}

/**
 * Patch the deduped transformers' `AutoConfig.from_pretrained` so every config
 * it loads passes through `injectStyleTts2Architectures` before
 * `resolve_model_type` sees it. Applied on the SHARED module instance kokoro
 * loads through, so it covers every float uniformly (no fetch/SW dependency).
 * Idempotent across the say⇄hear warmup race via a Symbol marker. Best-effort:
 * an unexpected export shape leaves transformers untouched (kokoro still loads
 * via the benign EncoderOnly fallback).
 */
export function applyStyleTts2ConfigShim(transformers: TransformersWithAutoConfig): void {
  const autoConfig = transformers?.AutoConfig;
  const orig = autoConfig?.from_pretrained;
  if (!autoConfig || typeof orig !== 'function') {
    log.debug('style_text_to_speech_2 shim skipped: AutoConfig.from_pretrained unavailable');
    return;
  }
  if (orig[STYLE_TTS2_SHIM_MARKER]) return;
  const wrapped: AutoConfigLoader = async (...args: unknown[]): Promise<unknown> => {
    const config = (await orig.apply(autoConfig, args)) as PretrainedConfigLike;
    const willInject =
      config?.model_type === STYLE_TTS2_MODEL_TYPE &&
      (!Array.isArray(config.architectures) || config.architectures.length === 0);
    injectStyleTts2Architectures(config);
    if (willInject) {
      log.debug(
        `style_text_to_speech_2 architectures injected for "${String(args[0])}": [${STYLE_TTS2_ARCHITECTURE}]`
      );
    }
    return config;
  };
  wrapped[STYLE_TTS2_SHIM_MARKER] = true;
  autoConfig.from_pretrained = wrapped;
  log.debug('style_text_to_speech_2 architecture shim installed on AutoConfig.from_pretrained');
}

let kokoroPromise: Promise<KokoroTts> | null = null;
let loadState: KokoroLoadState = 'idle';
let lastSnapshot: DownloadSnapshot | null = null;
let readyTts: KokoroTts | null = null;

/** Where the voice engine is in its lifecycle (sync, render-friendly). */
export function kokoroLoadState(): KokoroLoadState {
  return loadState;
}

/** The latest aggregated download snapshot (null before the first sample). */
export function kokoroDownloadSnapshot(): DownloadSnapshot | null {
  return lastSnapshot;
}

/** The loaded engine when ready, else null (sync — for engine picks). */
export function kokoroIfReady(): KokoroTts | null {
  return readyTts;
}

/**
 * Public entry point. Idempotent — concurrent and repeated callers share one
 * load. A failed load resets so a later call can retry from scratch.
 */
export function getKokoro(onProgress?: WhisperProgress): Promise<KokoroTts> {
  if (!kokoroPromise) {
    loadState = 'loading';
    kokoroPromise = loadKokoro(onProgress).then(
      (tts) => {
        loadState = 'ready';
        readyTts = tts;
        return tts;
      },
      (err) => {
        loadState = 'failed';
        kokoroPromise = null;
        log.error('kokoro load failed', err);
        throw err;
      }
    );
  }
  return kokoroPromise;
}

async function loadKokoro(onProgress?: WhisperProgress): Promise<KokoroTts> {
  // Configure the SHARED transformers env (Vite dedupes kokoro-js onto the
  // workspace copy) before kokoro touches ort — `say` can warm kokoro
  // without whisper ever having loaded.
  const transformers = await import('@huggingface/transformers');
  configureTransformersEnv(transformers.env as never);
  // Register the StyleTTS2 architecture on the shared transformers so kokoro's
  // `style_text_to_speech_2` config resolves cleanly instead of warn-falling
  // back to EncoderOnly (see `applyStyleTts2ConfigShim`).
  applyStyleTts2ConfigShim(transformers as TransformersWithAutoConfig);
  // Surface a clear "run hf download …" message if the user hasn't staged
  // the kokoro weights yet — kokoro-js otherwise dies with a generic
  // transformers.js model-load error.
  await assertLocalModelPresent(KOKORO_MODEL_ID);
  const { KokoroTTS } = await import('kokoro-js');

  const tracker = createDownloadTracker();
  const wantGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    device: wantGpu ? 'webgpu' : 'wasm',
    dtype: wantGpu ? 'fp32' : 'q8',
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (!p?.file) return;
      if (p.status === 'progress') tracker.update(p.file, p.loaded ?? 0, p.total ?? 0);
      else if (p.status === 'done') tracker.complete(p.file);
      else return;
      lastSnapshot = tracker.snapshot();
      onProgress?.(lastSnapshot);
    },
  });

  log.info('kokoro ready', { model: KOKORO_MODEL_ID, device: wantGpu ? 'webgpu' : 'wasm' });
  const voiceInfos = toKokoroVoiceInfos(
    tts.voices as Record<string, { name?: string; language?: string; gender?: string }>
  );

  return {
    async synthesize(text, opts) {
      const audio = await tts.generate(text, {
        ...(opts?.voice ? { voice: opts.voice as never } : {}),
        ...(opts?.speed ? { speed: opts.speed } : {}),
      });
      return { audio: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
    },
    async *synthesizeStream(text, opts) {
      const streamOpts = {
        ...(opts?.voice ? { voice: opts.voice as never } : {}),
        ...(opts?.speed ? { speed: opts.speed } : {}),
        ...(opts?.splitPattern ? { split_pattern: opts.splitPattern } : {}),
      };
      for await (const chunk of tts.stream(text, streamOpts)) {
        yield {
          audio: chunk.audio.audio as Float32Array,
          sampleRate: chunk.audio.sampling_rate,
        };
      }
    },
    voices: () => voiceInfos,
  };
}

/** Test-only: drop the cached engine promise + state. */
export function resetKokoroForTests(): void {
  kokoroPromise = null;
  loadState = 'idle';
  lastSnapshot = null;
  readyTts = null;
}
