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
    /** Skip the in-app dialog when the origin mic grant is already 'granted'. */
    skipIfGranted?: boolean;
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
 * The raw Web Speech `SpeechRecognitionErrorEvent.error` code, carried on the
 * rejection so callers can branch on it (e.g. fall back to whisper on the
 * `network` / `service-not-allowed` codes that mean this browser has no Web
 * Speech cloud backend) without string-matching the message.
 */
class SpeechRecognitionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(speechErrorMessage(code));
    this.name = 'SpeechRecognitionError';
    this.code = code;
  }
}

/** Map a raw Web Speech error code to a clear, user-facing message. */
function speechErrorMessage(code: string): string {
  switch (code) {
    case 'network':
    case 'service-not-allowed':
      return 'builtin speech recognition is unsupported in this browser (no Web Speech cloud backend) — use `hear --engine enhanced`';
    case 'not-allowed':
      return 'microphone permission denied for builtin speech recognition';
    case 'audio-capture':
      return 'no microphone available for builtin speech recognition';
    case 'no-speech':
      return 'no speech detected';
    case 'aborted':
      return 'speech recognition aborted';
    default:
      return `speech recognition error: ${code}`;
  }
}

/**
 * `true` for the recognizer errors that mean this browser cannot run the
 * builtin (cloud) recognizer at all — the trigger for the whisper fallback /
 * clear-error degradation in {@link hearCapture}.
 */
function isUnsupportedSpeechError(err: unknown): boolean {
  return (
    err instanceof SpeechRecognitionError &&
    (err.code === 'network' || err.code === 'service-not-allowed')
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
      log.error('builtin recognition error', { code: event.error });
      reject(new SpeechRecognitionError(event.error));
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
    // The surface short-circuits its own Allow/Cancel dialog when the origin
    // mic grant is already 'granted' (see SliccPermissions.prompt), so this
    // single call covers both first-use (dialog) and repeat-use (straight to
    // getUserMedia) without the hear path duplicating the query.
    log.debug('acquireMicrophoneStream: requesting microphone via permission surface', {
      hasDeviceId: !!deviceId,
    });
    const result = await surface.prompt({
      kinds: ['microphone'],
      description: 'The hear command needs your microphone to transcribe speech.',
      requestOptions: { microphone: { constraints } },
      // hear is agent/terminal-initiated with no ambient gesture — skip the
      // in-app dialog when the origin grant is already 'granted' so repeat
      // invocations go straight to getUserMedia (the browser persists it).
      skipIfGranted: true,
    });
    if (result.status !== 'granted') {
      log.error('acquireMicrophoneStream: microphone permission not granted', {
        status: result.status,
        reason: result.reason,
      });
      const detail = result.message ? `: ${result.message}` : '';
      throw new Error(`microphone permission ${result.reason ?? result.status}${detail}`);
    }
    const grant = result.grants.find(
      (g): g is { kind: 'microphone'; stream: MediaStream } => g.kind === 'microphone'
    );
    if (!grant) {
      log.error('acquireMicrophoneStream: permission granted without a microphone stream');
      throw new Error('microphone permission granted without a stream');
    }
    log.debug('acquireMicrophoneStream: microphone stream acquired via surface');
    return grant.stream;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    log.error('acquireMicrophoneStream: getUserMedia unavailable in this realm');
    throw new Error('microphone capture unavailable in this realm');
  }
  // No surface (early boot / non-WC realm) — call getUserMedia directly. The
  // browser drives its own permission prompt here.
  log.debug('acquireMicrophoneStream: no permission surface; calling getUserMedia directly');
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    log.debug('acquireMicrophoneStream: getUserMedia succeeded (direct)');
    return stream;
  } catch (err) {
    log.error('acquireMicrophoneStream: getUserMedia failed (direct)', err);
    throw err;
  }
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
 * Prime a microphone grant through the leader surface so the Web Speech
 * recognizer reuses the now-granted origin permission instead of surfacing its
 * own browser prompt. Returns the live {@link MediaStream} so the caller can
 * keep the OS audio device OPEN across `SpeechRecognition.start()` and release
 * it only once recognition has finished — see {@link hearCapture}. Returns
 * `null` when no surface is mounted (early boot / non-WC realm / headless
 * tests): the recognizer then drives the browser prompt itself, preserving
 * compatibility with those realms.
 *
 * Holding the stream open is load-bearing: releasing it before the recognizer
 * starts (the previous acquire-and-release behavior) raced the asynchronous OS
 * audio-device teardown against the recognizer's own internal capture, which
 * silently aborted the builtin path. The enhanced path never hit this because
 * `recordUntil` keeps the mic open across `builtinOnce`.
 */
async function primeBuiltinPermission(deviceId: string | undefined): Promise<MediaStream | null> {
  const surface = resolvePermissionSurface();
  if (!surface) {
    log.debug('primeBuiltinPermission: no permission surface; recognizer drives its own prompt');
    return null;
  }
  log.debug('primeBuiltinPermission: priming microphone grant via permission surface', {
    hasDeviceId: !!deviceId,
  });
  const stream = await acquireMicrophoneStream(deviceId);
  log.debug('primeBuiltinPermission: microphone primed; holding stream open for recognizer');
  return stream;
}

/** Stop every track on a primed stream once the recognizer is done with it. */
function releasePrimedStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  log.debug('primeBuiltinPermission: released primed microphone stream');
}

/**
 * Enhanced capture: the builtin recognizer owns endpointing while the mic is
 * recorded in parallel, and whisper transcribes the captured audio (builtin
 * text as fallback). Shared by the `auto`/`enhanced` dispatch and the
 * builtin→whisper degradation path (R6).
 */
async function captureEnhanced(opts: HearCaptureOptions, timeoutMs: number): Promise<HearResult> {
  // `recordUntil` drives the surface grant — the builtin recognizer reuses the
  // now-granted origin permission without its own prompt.
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

/** One-shot capture → transcript (the `hear` command's microphone mode). */
export async function hearCapture(opts: HearCaptureOptions = {}): Promise<HearResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const engine = opts.engine ?? 'auto';
  const enhancedReady = whisperLoadState() === 'ready';

  if (engine === 'enhanced' && !enhancedReady) {
    log.error('hearCapture: enhanced engine requested but whisper is not ready');
    throw new Error(
      'enhanced engine not ready — run `hear --warmup` (check progress with `hear --status`)'
    );
  }

  const useEnhanced = engine !== 'builtin' && enhancedReady;
  log.debug('hearCapture: engine dispatch', {
    requested: engine,
    enhancedReady,
    resolved: useEnhanced ? 'enhanced' : 'builtin',
  });

  if (useEnhanced) {
    return captureEnhanced(opts, timeoutMs);
  }

  // Builtin-only path. Route the microphone grant through the leader
  // `<slicc-permissions>` surface so every voice input funnels through ONE
  // prompt; the recognizer then reuses the now-granted origin permission.
  // CRITICAL: hold the primed stream OPEN across `builtinOnce` (release it in
  // `finally`) so the OS audio device isn't torn down mid-recognition —
  // mirroring the enhanced path, where `recordUntil` keeps the mic open while
  // the recognizer runs. Without a surface (early boot / non-WC realm) the
  // recognizer drives its own browser prompt and there's no stream to hold.
  let primedStream = await primeBuiltinPermission(opts.deviceId);
  try {
    const transcript = await builtinOnce(opts.lang, timeoutMs);
    log.debug('hearCapture: builtin recognition produced a transcript');
    return { transcript, engine: 'builtin' };
  } catch (err) {
    // Chrome-for-Testing (and other Chromium builds without Google's private
    // Web Speech cloud key) fire `onerror: 'network'` / `service-not-allowed`.
    // Degrade gracefully: fall back to local whisper when it is ready, else
    // surface the clear, actionable "use `hear --engine enhanced`" error
    // instead of an uncaught raw recognizer rejection.
    if (!isUnsupportedSpeechError(err)) {
      log.error('hearCapture: builtin recognition failed', err);
      throw err;
    }
    if (enhancedReady) {
      log.debug(
        'hearCapture: builtin unsupported in this browser; falling back to enhanced whisper'
      );
      // Release the builtin's primed mic before the enhanced path acquires its
      // own stream so the two don't contend for the device. Null it out so the
      // `finally` doesn't double-release.
      releasePrimedStream(primedStream);
      primedStream = null;
      return captureEnhanced(opts, timeoutMs);
    }
    log.error('hearCapture: builtin unsupported and whisper not ready', {
      code: (err as SpeechRecognitionError).code,
    });
    throw err;
  } finally {
    releasePrimedStream(primedStream);
  }
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
