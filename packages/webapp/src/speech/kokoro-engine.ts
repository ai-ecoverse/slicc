import type { KokoroTTS as KokoroTtsClass } from 'kokoro-js';
import { createLogger } from '../base/logger.js';
import { createDownloadTracker, type DownloadSnapshot } from './download-progress.js';
import { getEspeakPhonemize } from './espeak-phonemizer.js';
import {
  type EspeakPhonemize,
  englishEspeakVoiceForKokoroVoice,
  espeakVoiceForKokoroVoice,
  isUnusablePhonemizerError,
  phonemizeForKokoro,
} from './kokoro-phonemize.js';
import { KOKORO_MODEL_ID } from './model-ids.js';
import {
  assertLocalModelPresent,
  configureTransformersEnv,
  ensureOrtWasmPaths,
} from './transformers-env.js';
import type { WhisperProgress } from './whisper-engine.js';

const log = createLogger('speech:kokoro');

export { KOKORO_MODEL_ID };

export interface KokoroVoiceInfo {
  id: string;

  name: string;

  lang: string;

  onDevice: boolean;
  gender?: string;
}

export interface KokoroAudioChunk {
  audio: Float32Array;
  sampleRate: number;
}

export interface KokoroTts {
  synthesize(text: string, opts?: { voice?: string; speed?: number }): Promise<KokoroAudioChunk>;

  synthesizeStream(
    text: string,
    opts?: { voice?: string; speed?: number; splitPattern?: RegExp }
  ): AsyncGenerator<KokoroAudioChunk, void, void>;

  voices(): KokoroVoiceInfo[];
}

export type KokoroLoadState = 'idle' | 'loading' | 'ready' | 'failed';

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

const KOKORO_ON_DEVICE_LANG_TAGS = new Set([
  'en-US',
  'en-GB',
  'es-ES',
  'fr-FR',
  'it-IT',
  'hi-IN',
  'pt-BR',
]);

function normalizeLangTag(lang: string): string {
  const [base, region] = lang.split('-');
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase();
}

function isKokoroOnDeviceVoice(id: string, resolvedLang: string | undefined): boolean {
  if (!resolvedLang) return false;
  if (KOKORO_ON_DEVICE_LANG_TAGS.has(resolvedLang)) return true;

  if (resolvedLang.includes('-')) return false;
  const prefixLang = KOKORO_PREFIX_LANG[id[0]];
  return (
    prefixLang !== undefined &&
    KOKORO_ON_DEVICE_LANG_TAGS.has(prefixLang) &&
    prefixLang.split('-')[0].toLowerCase() === resolvedLang
  );
}

export function toKokoroVoiceInfos(
  voices: Record<string, { name?: string; language?: string; gender?: string }>
): KokoroVoiceInfo[] {
  return Object.entries(voices).map(([id, meta]) => {
    const resolvedLang = meta.language
      ? normalizeLangTag(meta.language)
      : KOKORO_PREFIX_LANG[id[0]];
    return {
      id,
      name: meta.name || id,

      lang: resolvedLang ?? 'en-US',

      onDevice: isKokoroOnDeviceVoice(id, resolvedLang),
      ...(meta.gender ? { gender: meta.gender } : {}),
    };
  });
}

export const KOKORO_MULTILINGUAL_VOICES: Readonly<
  Record<string, { name?: string; gender?: string }>
> = Object.freeze({
  ef_dora: { name: 'Dora', gender: 'Female' },
  em_alex: { name: 'Alex', gender: 'Male' },
  em_santa: { name: 'Santa', gender: 'Male' },

  ff_siwis: { name: 'Siwis', gender: 'Female' },

  hf_alpha: { name: 'Alpha', gender: 'Female' },
  hf_beta: { name: 'Beta', gender: 'Female' },
  hm_omega: { name: 'Omega', gender: 'Male' },
  hm_psi: { name: 'Psi', gender: 'Male' },

  if_sara: { name: 'Sara', gender: 'Female' },
  im_nicola: { name: 'Nicola', gender: 'Male' },

  pf_dora: { name: 'Dora', gender: 'Female' },
  pm_alex: { name: 'Alex', gender: 'Male' },
  pm_santa: { name: 'Santa', gender: 'Male' },

  jf_alpha: { name: 'Alpha', gender: 'Female' },
  jf_gongitsune: { name: 'Gongitsune', gender: 'Female' },
  jf_nezumi: { name: 'Nezumi', gender: 'Female' },
  jf_tebukuro: { name: 'Tebukuro', gender: 'Female' },
  jm_kumo: { name: 'Kumo', gender: 'Male' },

  zf_xiaobei: { name: 'Xiaobei', gender: 'Female' },
  zf_xiaoni: { name: 'Xiaoni', gender: 'Female' },
  zf_xiaoxiao: { name: 'Xiaoxiao', gender: 'Female' },
  zf_xiaoyi: { name: 'Xiaoyi', gender: 'Female' },
  zm_yunjian: { name: 'Yunjian', gender: 'Male' },
  zm_yunxi: { name: 'Yunxi', gender: 'Male' },
  zm_yunxia: { name: 'Yunxia', gender: 'Male' },
  zm_yunyang: { name: 'Yunyang', gender: 'Male' },
});

export function buildKokoroVoiceInfos(
  ttsVoices: Record<string, { name?: string; language?: string; gender?: string }>
): KokoroVoiceInfo[] {
  const merged: Record<string, { name?: string; language?: string; gender?: string }> = {
    ...ttsVoices,
  };
  for (const [id, meta] of Object.entries(KOKORO_MULTILINGUAL_VOICES)) {
    if (!(id in merged)) merged[id] = meta;
  }
  return toKokoroVoiceInfos(merged);
}

const STYLE_TTS2_MODEL_TYPE = 'style_text_to_speech_2';
const STYLE_TTS2_ARCHITECTURE = 'StyleTextToSpeech2Model';

interface PretrainedConfigLike {
  model_type?: string;
  architectures?: string[];
}

export function injectStyleTts2Architectures<T extends PretrainedConfigLike>(config: T): T {
  if (
    config?.model_type === STYLE_TTS2_MODEL_TYPE &&
    (!Array.isArray(config.architectures) || config.architectures.length === 0)
  ) {
    config.architectures = [STYLE_TTS2_ARCHITECTURE];
  }
  return config;
}

const STYLE_TTS2_SHIM_MARKER = Symbol.for('slicc.kokoro.style-tts2-arch-shim');

type AutoConfigLoader = ((...args: unknown[]) => Promise<unknown>) & {
  [STYLE_TTS2_SHIM_MARKER]?: true;
};
interface TransformersWithAutoConfig {
  AutoConfig?: { from_pretrained?: AutoConfigLoader };
}

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

async function synthesizeWithEspeak(
  tts: KokoroTtsClass,
  text: string,
  espeakLang: string,
  voiceId: string,
  speed: number | undefined,
  phonemize: EspeakPhonemize
): Promise<KokoroAudioChunk> {
  const phonemes = await phonemizeForKokoro(text, espeakLang, phonemize);

  type InputIds = Parameters<KokoroTtsClass['generate_from_ids']>[0];
  const tokenize = tts.tokenizer as unknown as (
    t: string,
    o: { truncation: boolean }
  ) => { input_ids: InputIds };
  const { input_ids } = tokenize(phonemes, { truncation: true });
  const audio = await tts.generate_from_ids(input_ids, {
    voice: voiceId as never,
    ...(speed ? { speed } : {}),
  });
  return { audio: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
}

const DEFAULT_STREAM_SPLIT = /(?<=[.!?。！？…])\s+|\n{2,}/u;

export function splitKokoroStreamText(text: string, splitPattern?: RegExp): string[] {
  const pattern = splitPattern ?? DEFAULT_STREAM_SPLIT;
  const parts = text
    .split(pattern)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const trimmed = text.trim();
  return parts.length > 0 ? parts : trimmed ? [trimmed] : [];
}

let kokoroPromise: Promise<KokoroTts> | null = null;
let loadState: KokoroLoadState = 'idle';
let lastSnapshot: DownloadSnapshot | null = null;
let readyTts: KokoroTts | null = null;

export function kokoroLoadState(): KokoroLoadState {
  return loadState;
}

export function kokoroDownloadSnapshot(): DownloadSnapshot | null {
  return lastSnapshot;
}

export function kokoroIfReady(): KokoroTts | null {
  return readyTts;
}

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
  const transformers = await import('@huggingface/transformers');
  configureTransformersEnv(transformers.env as never);

  applyStyleTts2ConfigShim(transformers as TransformersWithAutoConfig);

  await assertLocalModelPresent(KOKORO_MODEL_ID);

  await ensureOrtWasmPaths();
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

  const voiceInfos = buildKokoroVoiceInfos(
    tts.voices as Record<string, { name?: string; language?: string; gender?: string }>
  );

  return {
    async synthesize(text, opts) {
      const voiceId = opts?.voice ?? 'af_heart';

      const espeakLang = espeakVoiceForKokoroVoice(voiceId);
      if (espeakLang) {
        const phonemize = await getEspeakPhonemize();
        return synthesizeWithEspeak(tts, text, espeakLang, voiceId, opts?.speed, phonemize);
      }
      try {
        const t0 = performance.now();
        const audio = await tts.generate(text, {
          ...(opts?.voice ? { voice: opts.voice as never } : {}),
          ...(opts?.speed ? { speed: opts.speed } : {}),
        });
        const pcm = audio.audio as Float32Array;

        log.info('kokoro synthesize', {
          elapsedMs: Math.round(performance.now() - t0),
          chars: text.length,
          audioSeconds: Math.round((pcm.length / audio.sampling_rate) * 100) / 100,
          numThreads: transformers.env.backends?.onnx?.wasm?.numThreads,
        });
        return { audio: pcm, sampleRate: audio.sampling_rate };
      } catch (err) {
        const fallback = await englishEspeakFallback(err, voiceId);
        if (!fallback) throw err;
        return synthesizeWithEspeak(
          tts,
          text,
          fallback.lang,
          voiceId,
          opts?.speed,
          fallback.phonemize
        );
      }
    },
    async *synthesizeStream(text, opts) {
      const voiceId = opts?.voice ?? 'af_heart';

      const espeakLang = espeakVoiceForKokoroVoice(voiceId);
      if (espeakLang) {
        const phonemize = await getEspeakPhonemize();
        for (const sentence of splitKokoroStreamText(text, opts?.splitPattern)) {
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
      try {
        const t0 = performance.now();
        let chunks = 0;
        let samples = 0;
        let sampleRate = 0;
        for await (const chunk of tts.stream(splitter, streamOpts)) {
          const pcm = chunk.audio.audio as Float32Array;
          chunks += 1;
          samples += pcm.length;
          sampleRate = chunk.audio.sampling_rate;
          yield { audio: pcm, sampleRate };
        }
        log.info('kokoro synthesizeStream', {
          elapsedMs: Math.round(performance.now() - t0),
          chunks,
          chars: text.length,
          audioSeconds: sampleRate ? Math.round((samples / sampleRate) * 100) / 100 : 0,
          numThreads: transformers.env.backends?.onnx?.wasm?.numThreads,
        });
      } catch (err) {
        const fallback = await englishEspeakFallback(err, voiceId);
        if (!fallback) throw err;

        for (const sentence of splitKokoroStreamText(text, opts?.splitPattern)) {
          yield await synthesizeWithEspeak(
            tts,
            sentence,
            fallback.lang,
            voiceId,
            opts?.speed,
            fallback.phonemize
          );
        }
      }
    },
    voices: () => voiceInfos,
  };
}

async function englishEspeakFallback(
  err: unknown,
  voiceId: string
): Promise<{ lang: string; phonemize: EspeakPhonemize } | null> {
  if (!isUnusablePhonemizerError(err)) return null;
  const lang = englishEspeakVoiceForKokoroVoice(voiceId);
  if (!lang) return null;
  try {
    const phonemize = await getEspeakPhonemize();
    log.warn(
      'kokoro bundled phonemizer reported no languages; phonemizing English with the staged espeak-ng',
      { voiceId, lang }
    );
    return { lang, phonemize };
  } catch (stagingErr) {
    log.warn('staged espeak-ng unavailable, cannot recover English synthesis', {
      error: String(stagingErr),
    });
    return null;
  }
}

export function resetKokoroForTests(): void {
  kokoroPromise = null;
  loadState = 'idle';
  lastSnapshot = null;
  readyTts = null;
}
