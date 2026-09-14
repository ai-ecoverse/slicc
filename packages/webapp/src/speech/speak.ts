import { createLogger } from '../base/logger.js';
import { isExtensionRealm } from '../core/runtime-env.js';
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

  lang?: string;

  voice?: string;

  rate?: number;
  pitch?: number;
  volume?: number;
}

const MAX_SPEECH_CHARS = 20000;

function isEnglishLang(lang: string): boolean {
  return lang.toLowerCase().startsWith('en');
}

export function pickSpeakEngine(
  req: { lang?: string; voice?: string },
  kokoro: {
    ready: boolean;
    voices: readonly { id: string; lang: string; onDevice: boolean }[];

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

function pickKokoroVoiceForLang(
  lang: string | undefined,
  voices: readonly KokoroVoiceInfo[]
): string | undefined {
  if (!lang || isEnglishLang(lang)) return undefined;
  const baseLang = lang.split('-')[0].toLowerCase();
  return voices.find((v) => v.onDevice && v.lang.split('-')[0].toLowerCase() === baseLang)?.id;
}

const MAX_SPOKEN_INLINE_CODE_CHARS = 48;

export function speechTextFromMarkdown(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');

  text = text.replace(/(?:```|~~~)[\s\S]*$/, ' ');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/`([^`]*)`/g, (_match, code: string) =>
    code.length > MAX_SPOKEN_INLINE_CODE_CHARS ? ' ' : code
  );
  text = text.replace(/<[^>\n]+>/g, ' ');
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');
  text = text.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_SPEECH_CHARS) {
    text = `${text.slice(0, MAX_SPEECH_CHARS).replace(/\s+\S*$/, '')}…`;
  }
  return text;
}

const isExtensionFloat = isExtensionRealm;

function onDeviceInCurrentRuntime(v: KokoroVoiceInfo): boolean {
  return v.onDevice && (isEnglishLang(v.lang) || !isExtensionFloat());
}

export function kokoroVoicesIfReady(): KokoroVoiceInfo[] {
  return (
    kokoroIfReady()
      ?.voices()
      .map((v) => ({ ...v, onDevice: onDeviceInCurrentRuntime(v) })) ?? []
  );
}

export async function ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return [];
  const voices = speechSynthesis.getVoices();
  if (voices.length > 0) return voices;
  if (typeof speechSynthesis.addEventListener !== 'function') return voices;
  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(speechSynthesis.getVoices());
    };
    const onChange = () => done();
    const timer = setTimeout(done, 2000);
    speechSynthesis.addEventListener('voiceschanged', onChange);
  });
}

export async function hasVoiceForLang(lang: string): Promise<boolean> {
  const base = lang.split('-')[0]?.toLowerCase();
  if (!base) return false;
  if (
    kokoroVoicesIfReady().some((v) => v.onDevice && v.lang.split('-')[0].toLowerCase() === base)
  ) {
    return true;
  }
  const voices = await ensureVoicesLoaded();
  return voices.some((v) => v.lang.split('-')[0].toLowerCase() === base);
}

export interface KokoroStatus {
  state: KokoroLoadState;
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

let assetsInstanceId: string | undefined;

export function setSpeakAssetsInstanceId(instanceId: string | undefined): void {
  assetsInstanceId = instanceId;
}

export function kokoroStatus(): KokoroStatus {
  const snapshot = kokoroDownloadSnapshot();
  return {
    state: kokoroLoadState(),
    ...(snapshot
      ? { loaded: snapshot.loaded, total: snapshot.total, etaSeconds: snapshot.etaSeconds }
      : {}),
  };
}

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
    log.warn('kokoro warmup load failed', err);
  }
}

export function kokoroWarmup(): KokoroStatus {
  void stageThenLoadKokoro();
  return kokoroStatus();
}

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function playPcm(audio: Float32Array, sampleRate: number, volume = 1): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const buffer = ctx.createBuffer(1, audio.length, sampleRate);

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

async function webSpeak(req: SpeakRequest): Promise<void> {
  if (typeof speechSynthesis === 'undefined') {
    throw new Error('speechSynthesis is unavailable in this realm');
  }

  const voices = await ensureVoicesLoaded();
  return new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(req.text);
    if (req.lang !== undefined) u.lang = req.lang;
    if (req.rate !== undefined) u.rate = req.rate;
    if (req.pitch !== undefined) u.pitch = req.pitch;
    if (req.volume !== undefined) u.volume = req.volume;
    if (req.voice) {
      const match = voices.find((v) => v.name === req.voice);
      if (match) u.voice = match;
    } else if (req.lang) {
      const base = req.lang.split('-')[0].toLowerCase();
      const match = voices.find((v) => v.lang.split('-')[0].toLowerCase() === base);
      if (match) u.voice = match;
    }
    u.onend = () => resolve();
    u.onerror = (ev) => reject(new Error(`speak: ${ev.error || 'utterance failed'}`));
    speechSynthesis.speak(u);
  });
}

export async function speak(req: SpeakRequest): Promise<{ engine: SpeakEngine }> {
  const tts = kokoroIfReady();
  const voices = tts?.voices() ?? [];
  const engine = pickSpeakEngine(req, {
    ready: tts !== null,
    voices,
    nonEnglishOnDevice: !isExtensionFloat(),
  });
  if (engine === 'kokoro' && tts) {
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

export function resetSpeakForTests(): void {
  audioContext = null;
}

export async function synthesizeToWav(req: SpeakRequest): Promise<Uint8Array> {
  const tts = kokoroIfReady();
  if (!tts) {
    throw new Error('on-device voice not ready — run say --warmup and retry once it reports ready');
  }
  if (req.lang && !req.lang.toLowerCase().startsWith('en')) {
    throw new Error(
      `-o writes WAV via the on-device voice, which is English-only (got ${req.lang})`
    );
  }
  if (req.voice) {
    const ids = tts.voices().map((v) => v.id);
    if (!ids.includes(req.voice)) {
      throw new Error(
        `-o writes WAV via the on-device voice; "${req.voice}" is a Web Speech voice. ` +
          `Pick a kokoro voice (e.g. af_heart) or omit -v.`
      );
    }
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
