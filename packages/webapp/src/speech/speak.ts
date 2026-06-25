/**
 * Shared speech-synthesis surface — the voice twin of the recognition stack.
 *
 * Two engines behind one `speak()` call:
 *
 * - **kokoro** — the on-device Kokoro-82M voice (`kokoro-engine.ts`), used
 *   once its chained download (after whisper) has completed, for any language
 *   it can synthesize on-device (en/es/fr/it/hi/pt via espeak-ng), or whenever
 *   the requested voice names a synthesizable kokoro voice id.
 * - **webspeech** — `speechSynthesis`, the always-available fallback and the
 *   route for ja/zh (no JS G2P) and any other language. The extension float
 *   also routes es/fr/it/hi/pt here (MV3 CSP blocks the espeak-ng glue).
 *
 * Consumers: the `say` command (local realm + the `speak-text` panel-RPC
 * handler) and the spoken-reply loop (`voice-reply.ts`). Page/offscreen
 * realm only.
 */

import { createLogger } from '../core/logger.js';
import { callEnsureSpeechAssets } from '../kernel/speech-assets-bridge.js';
import {
  getKokoro,
  type KokoroLoadState,
  type KokoroVoiceInfo,
  kokoroDownloadSnapshot,
  kokoroIfReady,
  kokoroLoadState,
} from './kokoro-engine.js';
import { encodePcmChunksToWav, type PcmChunk } from './wav-encode.js';

const log = createLogger('speech:speak');

export type SpeakEngine = 'kokoro' | 'webspeech';

export interface SpeakRequest {
  text: string;
  /** BCP-47 tag; ja/zh and unsupported languages route to webspeech. */
  lang?: string;
  /** A kokoro voice id (`af_heart`, …) or a Web Speech voice name. */
  voice?: string;
  /** Speaking rate (Web Speech `rate` / kokoro `speed`). */
  rate?: number;
  pitch?: number;
  volume?: number;
}

/**
 * Spoken replies stay bounded — nobody wants a minutes-long readout, but the
 * old 1500-char cap also silently chopped any reasonable multi-paragraph
 * reply (#1038). With kokoro now streaming sentence-by-sentence (each chunk
 * tokenized + truncated INDIVIDUALLY by kokoro-js, so the engine's ~510-token
 * clamp no longer truncates the whole text) the cap only exists to keep
 * pathological / runaway prose from monologuing — a generous upper bound.
 */
const MAX_SPEECH_CHARS = 20000;

/** A language tag is English when its base subtag is `en`. */
function isEnglishLang(lang: string): boolean {
  return lang.toLowerCase().startsWith('en');
}

/**
 * Pick the synthesis engine for a request (pure — unit-tested). Kokoro wins
 * for any voice it can synthesize ON-DEVICE in this runtime; everything else
 * routes to Web Speech.
 *
 * A voice is synthesizable now when the engine is ready, the voice is flagged
 * `onDevice` (en/es/fr/it/hi/pt — ja/zh have no JS G2P), AND, for non-English,
 * the runtime can load the espeak-ng phonemizer (`nonEnglishOnDevice`). The
 * extension float can't dynamic-import the espeak-ng glue from a VFS blob URL
 * under MV3 CSP, so it sets that flag false and non-English degrades to Web
 * Speech (see `espeak-phonemizer.ts` and the spec's cross-runtime status).
 *
 * - explicit voice id → kokoro when that voice is synthesizable, else webspeech
 * - otherwise → kokoro when a synthesizable voice matches the request language
 *   (English when no `lang` is given), else webspeech
 */
export function pickSpeakEngine(
  req: { lang?: string; voice?: string },
  kokoro: {
    ready: boolean;
    voices: readonly { id: string; lang: string; onDevice: boolean }[];
    /** Whether non-English on-device synthesis works in this runtime. */
    nonEnglishOnDevice: boolean;
  }
): SpeakEngine {
  if (!kokoro.ready) return 'webspeech';
  const synthesizable = (v: { lang: string; onDevice: boolean }): boolean =>
    v.onDevice && (isEnglishLang(v.lang) || kokoro.nonEnglishOnDevice);
  if (req.voice) {
    const match = kokoro.voices.find((v) => v.id === req.voice);
    return match && synthesizable(match) ? 'kokoro' : 'webspeech';
  }
  const baseLang = (req.lang ? req.lang.split('-')[0] : 'en').toLowerCase();
  const matched = kokoro.voices.some(
    (v) => v.lang.split('-')[0].toLowerCase() === baseLang && synthesizable(v)
  );
  return matched ? 'kokoro' : 'webspeech';
}

/**
 * The kokoro voice id to synthesize `lang` with when the caller named none
 * (pure — unit-tested). English uses kokoro's built-in default (undefined →
 * af_heart); a non-English request resolves to the first on-device voice for
 * that base language so the audio is actually spoken in the requested tongue.
 */
function pickKokoroVoiceForLang(
  lang: string | undefined,
  voices: readonly KokoroVoiceInfo[]
): string | undefined {
  if (!lang || isEnglishLang(lang)) return undefined;
  const baseLang = lang.split('-')[0].toLowerCase();
  return voices.find((v) => v.onDevice && v.lang.split('-')[0].toLowerCase() === baseLang)?.id;
}

/** Inline code spans longer than this are code, not vocabulary — dropped. */
const MAX_SPOKEN_INLINE_CODE_CHARS = 48;

/**
 * Reduce assistant markdown to speakable prose (pure — unit-tested): drop
 * fenced code blocks (including ```shtml dips and ~~~ fences, plus any
 * DANGLING fence from a truncated stream — never read raw code aloud),
 * unwrap short inline code / emphasis / links / images (long inline spans
 * are dropped as code), strip heading/quote/list markers and HTML tags,
 * collapse whitespace, and cap the length so a long reply doesn't monologue.
 */
export function speechTextFromMarkdown(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, ' '); // fenced code (incl. shtml dips)
  text = text.replace(/~~~[\s\S]*?~~~/g, ' '); // tilde fences
  // An unterminated fence (truncated/capped reply) would otherwise leak its
  // whole body into speech — drop everything from the dangling opener on.
  text = text.replace(/(?:```|~~~)[\s\S]*$/, ' ');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images/dip refs → alt label
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links → label
  text = text.replace(
    /`([^`]*)`/g,
    (_match, code: string) => (code.length > MAX_SPOKEN_INLINE_CODE_CHARS ? ' ' : code) // inline code → content (short) / dropped (long)
  );
  text = text.replace(/<[^>\n]+>/g, ' '); // html tags
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ''); // headings
  text = text.replace(/^[ \t]*>[ \t]?/gm, ''); // blockquotes
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, ''); // list markers
  text = text.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1'); // emphasis
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_SPEECH_CHARS) {
    text = `${text.slice(0, MAX_SPEECH_CHARS).replace(/\s+\S*$/, '')}…`;
  }
  return text;
}

const isExtensionFloat = (): boolean => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

/** Whether a model-capable Kokoro voice can actually run on-device here. */
function onDeviceInCurrentRuntime(v: KokoroVoiceInfo): boolean {
  return v.onDevice && (isEnglishLang(v.lang) || !isExtensionFloat());
}

/** The kokoro voices when the engine is ready, else an empty list. */
export function kokoroVoicesIfReady(): KokoroVoiceInfo[] {
  return (
    kokoroIfReady()
      ?.voices()
      .map((v) => ({ ...v, onDevice: onDeviceInCurrentRuntime(v) })) ?? []
  );
}

/** Enhanced-voice (kokoro) lifecycle snapshot — the `say --status` shape. */
export interface KokoroStatus {
  state: KokoroLoadState;
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

/** Kernel-worker instance id scoping the page→worker speech-assets bridge (R10). */
let assetsInstanceId: string | undefined;

/**
 * Wire the kernel-worker instance id so `kokoroWarmup()` can reach the
 * page→worker speech-assets bridge (R10). Called by the WC live boot alongside
 * `setComposerSpeechInstanceId`.
 */
export function setSpeakAssetsInstanceId(instanceId: string | undefined): void {
  assetsInstanceId = instanceId;
}

/** Enhanced-voice lifecycle snapshot (the `say --status` mode). */
export function kokoroStatus(): KokoroStatus {
  const snapshot = kokoroDownloadSnapshot();
  return {
    state: kokoroLoadState(),
    ...(snapshot
      ? { loaded: snapshot.loaded, total: snapshot.total, etaSeconds: snapshot.etaSeconds }
      : {}),
  };
}

/**
 * Stage the on-device assets (R10) then load kokoro from the VFS — mirrors the
 * whisper warmup path. A staging failure is not fatal on its own: the weights
 * may already be present, in which case the VFS-direct `getKokoro()` still
 * succeeds. The extension float loads speech assets directly under
 * `host_permissions` (no VFS staging), so it skips the bridge — N/A by design.
 */
async function stageThenLoadKokoro(): Promise<void> {
  try {
    if (!isExtensionFloat()) {
      await callEnsureSpeechAssets({ instanceId: assetsInstanceId });
    }
  } catch (err) {
    log.warn('kokoro asset staging failed; trying already-present weights', err);
  }
  try {
    await getKokoro();
  } catch (err) {
    // Surfaced via kokoroStatus() as state 'failed'; the command reports it.
    log.warn('kokoro warmup load failed', err);
  }
}

/**
 * Kick the enhanced-voice download without waiting (the `say --warmup` mode):
 * stage the kokoro weights via the R10 bridge, then load the engine in the
 * background. Idempotent — concurrent/repeat calls share the one engine load.
 */
export function kokoroWarmup(): KokoroStatus {
  void stageThenLoadKokoro();
  return kokoroStatus();
}

// One lazily-created context per realm, reused across utterances (matches
// the afplay pattern; repeatedly constructing contexts leaks OS handles).
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/** Play mono PCM through the realm's audio context; resolves on end. */
async function playPcm(audio: Float32Array, sampleRate: number, volume = 1): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const buffer = ctx.createBuffer(1, audio.length, sampleRate);
  // Copy into a fresh ArrayBuffer-backed view — the engine may hand back a
  // SharedArrayBuffer-backed array, which copyToChannel's typing rejects.
  buffer.copyToChannel(new Float32Array(audio), 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(ctx.destination);
  await new Promise<void>((resolve) => {
    source.onended = () => resolve();
    source.start();
  });
}

/** Speak via the Web Speech API (the always-available engine). */
function webSpeak(req: SpeakRequest): Promise<void> {
  if (typeof speechSynthesis === 'undefined') {
    return Promise.reject(new Error('speechSynthesis is unavailable in this realm'));
  }
  return new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(req.text);
    if (req.lang !== undefined) u.lang = req.lang;
    if (req.rate !== undefined) u.rate = req.rate;
    if (req.pitch !== undefined) u.pitch = req.pitch;
    if (req.volume !== undefined) u.volume = req.volume;
    if (req.voice) {
      const match = speechSynthesis.getVoices().find((v) => v.name === req.voice);
      if (match) u.voice = match;
    }
    u.onend = () => resolve();
    u.onerror = (ev) => reject(new Error(`speak: ${ev.error || 'utterance failed'}`));
    speechSynthesis.speak(u);
  });
}

/**
 * Speak `req.text` on the best available engine; resolves once playback
 * finishes, reporting which engine ran. Kokoro runs via `synthesizeStream`
 * so multi-paragraph replies are not truncated by the engine's ~510-token
 * generate clamp (#1038) — sentence chunks play back-to-back as continuous
 * audio. If the FIRST kokoro chunk fails before any audio plays, fall back
 * to webspeech; a later-chunk failure logs and stops (no re-speak overlap).
 */
export async function speak(req: SpeakRequest): Promise<{ engine: SpeakEngine }> {
  const tts = kokoroIfReady();
  const voices = tts?.voices() ?? [];
  const engine = pickSpeakEngine(req, {
    ready: tts !== null,
    voices,
    nonEnglishOnDevice: !isExtensionFloat(),
  });
  if (engine === 'kokoro' && tts) {
    // No explicit voice on a non-English request → pick a language-matched one
    // (kokoro's default voice is English) so es/fr/it/hi/pt speak correctly.
    const voice = req.voice ?? pickKokoroVoiceForLang(req.lang, voices);
    let played = 0;
    try {
      const stream = tts.synthesizeStream(req.text, {
        ...(voice ? { voice } : {}),
        ...(req.rate ? { speed: req.rate } : {}),
      });
      for await (const chunk of stream) {
        await playPcm(chunk.audio, chunk.sampleRate, req.volume);
        played++;
      }
      return { engine: 'kokoro' };
    } catch (err) {
      if (played > 0) {
        log.warn('kokoro stream failed mid-playback; stopping', err);
        return { engine: 'kokoro' };
      }
      log.warn('kokoro synthesis failed; falling back to webspeech', err);
    }
  }
  await webSpeak(req);
  return { engine: 'webspeech' };
}

/** Test-only: drop the cached AudioContext so a fresh stubbed `AudioContext`
 *  class is picked up on the next `playPcm()` call. */
export function resetSpeakForTests(): void {
  audioContext = null;
}

/**
 * Synthesize `req.text` with the on-device kokoro engine and return a 16-bit
 * mono WAV byte buffer — the file path for `say -o <file>`. Kokoro-only: this
 * is what gives the round-trippable WAV output the issue asks for (Web Speech
 * has no capture API). Callers must guard with `kokoroIfReady()` and reject
 * non-English / unknown-voice requests upstream — this helper does no engine
 * picking and no fallback to webspeech.
 *
 * Throws if kokoro is not ready, if the stream yields no chunks (empty input
 * after splitting), or if synthesis fails mid-stream.
 */
export async function synthesizeToWav(req: SpeakRequest): Promise<Uint8Array> {
  const tts = kokoroIfReady();
  if (!tts) {
    throw new Error('kokoro engine is not ready');
  }
  const chunks: PcmChunk[] = [];
  const stream = tts.synthesizeStream(req.text, {
    ...(req.voice ? { voice: req.voice } : {}),
    ...(req.rate ? { speed: req.rate } : {}),
  });
  for await (const chunk of stream) {
    chunks.push({ audio: chunk.audio, sampleRate: chunk.sampleRate });
  }
  if (chunks.length === 0) {
    throw new Error('kokoro produced no audio (text is empty after sentence split?)');
  }
  return encodePcmChunksToWav(chunks);
}
