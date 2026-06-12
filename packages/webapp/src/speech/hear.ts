/**
 * Page-side helpers behind the `hear` shell command (modeled on macOS `hear`,
 * https://sveinbjorn.org/hear): one-shot microphone capture → transcript, and
 * audio-file transcription via the whisper engine.
 *
 * Endpointing: the browser's built-in recognizer (single-utterance mode) owns
 * "the speaker stopped talking" — whisper has no voice-activity detection.
 * When the enhanced engine is ready (or forced), the microphone is ALSO
 * recorded in parallel and the final transcript comes from whisper over the
 * captured audio, with the builtin text as fallback. The chosen `deviceId`
 * applies to the whisper capture path only — the built-in recognizer always
 * listens on the system default input.
 *
 * Page/offscreen realm only; the kernel worker bridges here over the
 * `hear-*` panel-RPC ops.
 */

import { createLogger } from '../core/logger.js';
import { decodeToMono16k } from './audio.js';
import {
  getWhisper,
  type WhisperLoadState,
  whisperDownloadSnapshot,
  whisperLoadState,
} from './whisper-engine.js';
import { whisperLanguage } from './whisper-session.js';

const log = createLogger('speech:hear');

export interface HearCaptureOptions {
  /** BCP-47 language tag. Omit for auto-detect (whisper detects the spoken
   *  language; the built-in recognizer keeps the browser default). */
  lang?: string;
  /** Hard cap on listening time (default 30s). */
  timeoutMs?: number;
  /** Microphone for the whisper capture path. */
  deviceId?: string;
  /** Engine selection: auto (enhanced when ready), or forced. */
  engine?: 'auto' | 'builtin' | 'enhanced';
}

export interface HearResult {
  transcript: string;
  engine: 'builtin' | 'enhanced';
}

export interface HearStatus {
  state: WhisperLoadState;
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Minimal Chrome-specific Web Speech typings (not in all TS lib sets).
interface OnceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function onceRecognitionCtor(): (new () => OnceRecognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as new () => OnceRecognition) ??
    (w.webkitSpeechRecognition as new () => OnceRecognition) ??
    null
  );
}

/**
 * Single-utterance builtin recognition: resolves with the transcript once the
 * speaker pauses (the recognizer's natural end) or the timeout caps it.
 * Rejects only on fatal errors (no mic, permission denied, no recognizer).
 */
function builtinOnce(lang: string | undefined, timeoutMs: number): Promise<string> {
  const Ctor = onceRecognitionCtor();
  if (!Ctor) {
    return Promise.reject(new Error('speech recognition unavailable in this environment'));
  }
  return new Promise<string>((resolve, reject) => {
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = false;
    // No lang means auto-detect: whisper (when it runs the final pass)
    // detects the language itself; the builtin keeps its browser default.
    if (lang) rec.lang = lang;

    let transcript = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }, timeoutMs);

    rec.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        parts.push(event.results[i][0]?.transcript ?? '');
      }
      transcript = parts.join(' ').trim();
    };
    rec.onerror = (event) => {
      // `no-speech` / `aborted` end quietly with an empty transcript.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`speech recognition error: ${event.error}`));
    };
    rec.onend = () => {
      clearTimeout(timer);
      if (!settled) resolve(transcript);
    };
    rec.start();
  });
}

/** Record the mic until `stop()` is called; resolves the encoded container. */
async function recordUntil(deviceId: string | undefined): Promise<{
  stop(): Promise<Blob | null>;
  cancel(): void;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(500);

  const teardown = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  return {
    stop: () =>
      new Promise<Blob | null>((resolve) => {
        recorder.onstop = () => {
          teardown();
          resolve(
            chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null
          );
        };
        try {
          recorder.stop();
        } catch {
          teardown();
          resolve(null);
        }
      }),
    cancel: () => {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
      teardown();
    },
  };
}

/** One-shot capture → transcript (the `hear` command's microphone mode). */
export async function hearCapture(opts: HearCaptureOptions = {}): Promise<HearResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const engine = opts.engine ?? 'auto';
  const enhancedReady = whisperLoadState() === 'ready';

  if (engine === 'enhanced' && !enhancedReady) {
    throw new Error(
      'enhanced engine not ready — run `hear --warmup` (check progress with `hear --status`)'
    );
  }

  const useEnhanced = engine !== 'builtin' && enhancedReady;
  if (!useEnhanced) {
    const transcript = await builtinOnce(opts.lang, timeoutMs);
    return { transcript, engine: 'builtin' };
  }

  // Enhanced: builtin endpointing + parallel capture, whisper for the text.
  const recording = await recordUntil(opts.deviceId);
  let builtinText = '';
  try {
    builtinText = await builtinOnce(opts.lang, timeoutMs);
  } catch (err) {
    // Endpointing failed (e.g. recognizer network error) — the parallel
    // capture is still good; cap it at the timeout instead of losing it.
    log.warn('builtin endpointing failed; transcribing captured audio anyway', err);
  }
  const blob = await recording.stop();
  if (!blob) return { transcript: builtinText, engine: 'builtin' };

  try {
    const asr = await getWhisper();
    const audio = await decodeToMono16k(await blob.arrayBuffer());
    const transcript = await asr.transcribe(audio, { language: whisperLanguage(opts.lang) });
    if (transcript) return { transcript, engine: 'enhanced' };
  } catch (err) {
    log.warn('whisper transcription failed; falling back to builtin text', err);
  }
  return { transcript: builtinText, engine: 'builtin' };
}

/** Transcribe an encoded audio file (the `hear -i <file>` mode). Triggers the
 *  lazy model download on first use — that's the lazy-fetch contract. */
export async function hearTranscribe(bytes: ArrayBuffer, lang?: string): Promise<HearResult> {
  const asr = await getWhisper();
  const audio = await decodeToMono16k(bytes);
  const transcript = await asr.transcribe(audio, { language: whisperLanguage(lang) });
  return { transcript, engine: 'enhanced' };
}

/** Enhanced-engine lifecycle snapshot (the `hear --status` mode). */
export function hearStatus(): HearStatus {
  const snapshot = whisperDownloadSnapshot();
  return {
    state: whisperLoadState(),
    ...(snapshot
      ? { loaded: snapshot.loaded, total: snapshot.total, etaSeconds: snapshot.etaSeconds }
      : {}),
  };
}

/** Kick the enhanced-engine download without waiting (the `--warmup` mode). */
export function hearWarmup(): HearStatus {
  getWhisper().catch(() => {
    // Surfaced via hearStatus() as state 'failed'; the command reports it.
  });
  return hearStatus();
}
