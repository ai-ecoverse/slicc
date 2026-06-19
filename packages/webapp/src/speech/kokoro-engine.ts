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
import { configureTransformersEnv } from './transformers-env.js';
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
  const { env } = await import('@huggingface/transformers');
  configureTransformersEnv(env as never);
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
