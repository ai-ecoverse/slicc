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
import { getLeaderPermissionsSurface } from '../ui/wc/wc-permissions-registry.js';
import { decodeToMono16k } from './audio.js';
import {
  getWhisper,
  type WhisperLoadState,
  whisperDownloadSnapshot,
  whisperLoadState,
} from './whisper-engine.js';
import { whisperLanguage } from './whisper-session.js';

const log = createLogger('speech:hear');

/**
 * Minimal seam for the leader `<slicc-permissions>` surface — just the slice
 * we need to drive a microphone grant through the unified prompt. Defined
 * locally so tests can fake it without constructing the full custom element.
 * Matches the structural shape of `SliccPermissions.prompt`.
 */
export interface HearPermissionSurface {
  prompt(opts: {
    kinds: ReadonlyArray<'microphone'>;
    description?: string;
    requestOptions?: { microphone?: { constraints?: MediaStreamConstraints } };
  }): Promise<{
    status: 'granted' | 'cancelled' | 'denied' | 'error';
    grants: ReadonlyArray<{ kind: 'microphone'; stream: MediaStream } | { kind: string }>;
    reason?: string;
    message?: string;
  }>;
}

/** Injectable seams for tests; real wiring picks defaults. */
export interface HearDeps {
  /** Returns the mounted leader permission surface, or `null` when none. */
  getPermissionSurface?: () => HearPermissionSurface | null;
}

let injectedDeps: HearDeps = {};

/** Test-only: install fakes for the permission surface lookup. */
export function setHearDepsForTests(deps: HearDeps): void {
  injectedDeps = deps;
}

/** Test-only: drop any injected deps so subsequent runs use real wiring. */
export function resetHearDepsForTests(): void {
  injectedDeps = {};
}

function resolvePermissionSurface(): HearPermissionSurface | null {
  if (injectedDeps.getPermissionSurface) return injectedDeps.getPermissionSurface();
  const surface = getLeaderPermissionsSurface();
  if (!surface) return null;
  return surface as unknown as HearPermissionSurface;
}

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

/**
 * Acquire a microphone `MediaStream` for the hear command. `hear` is
 * agent-or-terminal-initiated with no ambient user activation, so when the
 * leader `<slicc-permissions>` surface is mounted we drive its multi-kind
 * prompt — the user's click on Allow IS the gesture that authorizes
 * `getUserMedia`. When no surface is reachable (early boot, headless tests,
 * non-WC realms) we fall back to a direct `getUserMedia` so dev/test paths
 * keep working.
 *
 * Rejects with a clear message on denial / cancel / unavailable so the
 * command exits cleanly instead of hanging.
 */
async function acquireMicrophoneStream(deviceId: string | undefined): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  };
  const surface = resolvePermissionSurface();
  if (surface) {
    const result = await surface.prompt({
      kinds: ['microphone'],
      description: 'The hear command needs your microphone to transcribe speech.',
      requestOptions: { microphone: { constraints } },
    });
    if (result.status !== 'granted') {
      const detail = result.message ? `: ${result.message}` : '';
      throw new Error(`microphone permission ${result.reason ?? result.status}${detail}`);
    }
    const grant = result.grants.find(
      (g): g is { kind: 'microphone'; stream: MediaStream } => g.kind === 'microphone'
    );
    if (!grant) throw new Error('microphone permission granted without a stream');
    return grant.stream;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('microphone capture unavailable in this realm');
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

/** Record the mic until `stop()` is called; resolves the encoded container. */
async function recordUntil(deviceId: string | undefined): Promise<{
  stop(): Promise<Blob | null>;
  cancel(): void;
}> {
  const stream = await acquireMicrophoneStream(deviceId);
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

/**
 * Acquire-and-release a microphone grant through the leader surface so the
 * Web Speech recognizer reuses the now-granted origin permission instead of
 * surfacing its own browser prompt. No-op when no surface is mounted — the
 * recognizer then drives the browser prompt itself, preserving compatibility
 * with non-WC realms and headless tests.
 */
async function primeBuiltinPermission(deviceId: string | undefined): Promise<void> {
  const surface = resolvePermissionSurface();
  if (!surface) return;
  const stream = await acquireMicrophoneStream(deviceId);
  for (const track of stream.getTracks()) track.stop();
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
    // Route the microphone grant through the leader `<slicc-permissions>`
    // surface even on the builtin recognizer path so every voice input
    // funnels through ONE prompt. We acquire-and-release: the Web Speech
    // recognizer opens its own mic internally, but the origin-level grant
    // is established here so its `start()` no longer triggers a separate
    // browser prompt. Without a surface (early boot / non-WC realm) we
    // fall through to the recognizer's own permission flow.
    await primeBuiltinPermission(opts.deviceId);
    const transcript = await builtinOnce(opts.lang, timeoutMs);
    return { transcript, engine: 'builtin' };
  }

  // Enhanced: builtin endpointing + parallel capture, whisper for the text.
  // `recordUntil` already drives the surface grant — the builtin recognizer
  // reuses the now-granted origin permission without its own prompt.
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
