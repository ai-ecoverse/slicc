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
 * Kokoro v1.0 ONNX ships voices across several languages, keyed by the id
 * prefix (`a` en-US, `b` en-GB, `e` es-ES, `f` fr-FR, `i` it-IT, `h` hi-IN,
 * `p` pt-BR, `j` ja-JP, `z` zh-CN). en/es/fr/it/hi/pt are synthesizable
 * on-device via the espeak-ng phonemizer; ja/zh have no JS G2P and stay on
 * Web Speech (see `KokoroVoiceInfo.onDevice` and `speak.ts`).
 */

import type { Tensor } from '@huggingface/transformers';
import type { KokoroTTS as KokoroTtsClass } from 'kokoro-js';
import { createLogger } from '../core/logger.js';
import { createDownloadTracker, type DownloadSnapshot } from './download-progress.js';
import { getEspeakPhonemize } from './espeak-phonemizer.js';
import {
  type EspeakPhonemize,
  espeakVoiceForKokoroVoice,
  phonemizeForKokoro,
} from './kokoro-phonemize.js';
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
  /**
   * BCP-47 language tag. Uses kokoro-js's reported `language` when present,
   * otherwise derives from the id prefix: `a`→en-US, `b`→en-GB, `e`→es-ES,
   * `f`→fr-FR, `i`→it-IT, `h`→hi-IN, `p`→pt-BR, `j`→ja-JP, `z`→zh-CN.
   */
  lang: string;
  /**
   * Whether this voice can be synthesized on-device by the base Kokoro model.
   * en/es/fr/it/hi/pt have an espeak-ng phonemizer (true); ja/zh have no JS
   * G2P and are Web-Speech-only (false).
   */
  onDevice: boolean;
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

/** Kokoro voice id prefix → BCP-47 language tag (fallback when kokoro-js
 * doesn't report a `language`). */
const KOKORO_PREFIX_LANG: Record<string, string> = {
  a: 'en-US',
  b: 'en-GB',
  e: 'es-ES',
  f: 'fr-FR',
  i: 'it-IT',
  h: 'hi-IN',
  p: 'pt-BR',
  j: 'ja-JP',
  z: 'zh-CN',
};

/** Base languages the base Kokoro model can phonemize on-device (espeak-ng).
 * ja/zh need misaki (no JS port), so they fall back to Web Speech. */
const KOKORO_ON_DEVICE_LANGS = new Set(['en', 'es', 'fr', 'it', 'hi', 'pt']);

/** Normalize a language tag to BCP-47 casing (`en-us` → `en-US`, `es` → `es`). */
function normalizeLangTag(lang: string): string {
  const [base, region] = lang.split('-');
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase();
}

/** Map kokoro-js's voices object into the normalized picker shape. Resolves
 * the language from kokoro-js's reported `language` when present, else from the
 * id prefix, and marks whether the voice is synthesizable on-device. */
export function toKokoroVoiceInfos(
  voices: Record<string, { name?: string; language?: string; gender?: string }>
): KokoroVoiceInfo[] {
  return Object.entries(voices).map(([id, meta]) => {
    const lang = meta.language
      ? normalizeLangTag(meta.language)
      : (KOKORO_PREFIX_LANG[id[0]] ?? 'en-US');
    const baseLang = lang.split('-')[0].toLowerCase();
    return {
      id,
      name: meta.name || id,
      lang,
      onDevice: KOKORO_ON_DEVICE_LANGS.has(baseLang),
      ...(meta.gender ? { gender: meta.gender } : {}),
    };
  });
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

/**
 * Synthesize one chunk for a non-English voice via the wrapper synth path:
 * phonemize with the correct espeak language, then drive kokoro-js's public
 * `tokenizer` + `generate_from_ids` directly — bypassing kokoro-js's
 * English-only internal phonemize (`kokoro-phonemize.ts`).
 */
async function synthesizeWithEspeak(
  tts: KokoroTtsClass,
  text: string,
  espeakLang: string,
  voiceId: string,
  speed: number | undefined,
  phonemize: EspeakPhonemize
): Promise<KokoroAudioChunk> {
  const phonemes = await phonemizeForKokoro(text, espeakLang, phonemize);
  const tokenize = tts.tokenizer as unknown as (
    t: string,
    o: { truncation: boolean }
  ) => { input_ids: Tensor };
  const { input_ids } = tokenize(phonemes, { truncation: true });
  const audio = await tts.generate_from_ids(input_ids, {
    voice: voiceId as never,
    ...(speed ? { speed } : {}),
  });
  return { audio: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
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
  const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');

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
      const voiceId = opts?.voice ?? 'af_heart';
      // Non-English voices (es/fr/it/hi/pt) phonemize via espeak ourselves and
      // feed token ids to kokoro-js directly; English keeps the native path.
      const espeakLang = espeakVoiceForKokoroVoice(voiceId);
      if (espeakLang) {
        const phonemize = await getEspeakPhonemize();
        return synthesizeWithEspeak(tts, text, espeakLang, voiceId, opts?.speed, phonemize);
      }
      const audio = await tts.generate(text, {
        ...(opts?.voice ? { voice: opts.voice as never } : {}),
        ...(opts?.speed ? { speed: opts.speed } : {}),
      });
      return { audio: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
    },
    async *synthesizeStream(text, opts) {
      const voiceId = opts?.voice ?? 'af_heart';
      // Non-English wrapper path: split into sentences (so a long reply isn't
      // clamped to ~510 tokens, #1038), phonemize + generate each ourselves.
      const espeakLang = espeakVoiceForKokoroVoice(voiceId);
      if (espeakLang) {
        const phonemize = await getEspeakPhonemize();
        const splitter = new TextSplitterStream();
        if (opts?.splitPattern) {
          const parts = text
            .split(opts.splitPattern)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
          splitter.push(...parts);
        } else {
          splitter.push(text);
        }
        splitter.close();
        for await (const sentence of splitter) {
          yield await synthesizeWithEspeak(
            tts,
            sentence,
            espeakLang,
            voiceId,
            opts?.speed,
            phonemize
          );
        }
        return;
      }
      const streamOpts = {
        ...(opts?.voice ? { voice: opts.voice as never } : {}),
        ...(opts?.speed ? { speed: opts.speed } : {}),
      };
      // kokoro-js' `stream(string)` shorthand builds an internal
      // TextSplitterStream but NEVER `.close()`s it, so the async iterator
      // (and therefore `speak()`) blocks forever after the final sentence.
      // Drive the splitter ourselves and close it so the generator
      // terminates once the last sentence is yielded. Mirror kokoro's own
      // split: per-`splitPattern` parts when given, else push the whole
      // string and let the splitter's sentence detection do the work.
      const splitter = new TextSplitterStream();
      if (opts?.splitPattern) {
        const parts = text
          .split(opts.splitPattern)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        splitter.push(...parts);
      } else {
        splitter.push(text);
      }
      splitter.close();
      for await (const chunk of tts.stream(splitter, streamOpts)) {
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
