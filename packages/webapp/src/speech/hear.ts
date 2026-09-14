import { createLogger } from '../base/logger.js';
import { getLeaderPermissionsSurface } from '../core/permissions-surface-registry.js';
import { decodeToMono16k } from './audio.js';
import {
  getWhisper,
  type WhisperLoadState,
  whisperDownloadSnapshot,
  whisperLoadState,
} from './whisper-engine.js';
import { whisperLanguage } from './whisper-session.js';

const log = createLogger('speech:hear');

export interface HearPermissionSurface {
  prompt(opts: {
    kinds: ReadonlyArray<'microphone'>;
    description?: string;
    requestOptions?: { microphone?: { constraints?: MediaStreamConstraints } };

    skipIfGranted?: boolean;
  }): Promise<{
    status: 'granted' | 'cancelled' | 'denied' | 'error';
    grants: ReadonlyArray<{ kind: 'microphone'; stream: MediaStream } | { kind: string }>;
    reason?: string;
    message?: string;
  }>;
}

export interface HearDeps {
  getPermissionSurface?: () => HearPermissionSurface | null;
}

let injectedDeps: HearDeps = {};

export function setHearDepsForTests(deps: HearDeps): void {
  injectedDeps = deps;
}

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
  lang?: string;

  timeoutMs?: number;

  deviceId?: string;

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

interface OnceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onnomatch: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface WindowWithSpeechRecognition {
  SpeechRecognition?: new () => OnceRecognition;
  webkitSpeechRecognition?: new () => OnceRecognition;
}

function onceRecognitionCtor(): (new () => OnceRecognition) | null {
  if (typeof window === 'undefined') return null;
  const { SpeechRecognition, webkitSpeechRecognition } = window as WindowWithSpeechRecognition;
  return SpeechRecognition ?? webkitSpeechRecognition ?? null;
}

class SpeechRecognitionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(speechErrorMessage(code));
    this.name = 'SpeechRecognitionError';
    this.code = code;
  }
}

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

function isUnsupportedSpeechError(err: unknown): boolean {
  return (
    err instanceof SpeechRecognitionError &&
    (err.code === 'network' || err.code === 'service-not-allowed')
  );
}

function builtinOnce(lang: string | undefined, timeoutMs: number): Promise<string> {
  const Ctor = onceRecognitionCtor();
  if (!Ctor) {
    return Promise.reject(new Error('speech recognition unavailable in this environment'));
  }
  return new Promise<string>((resolve, reject) => {
    const t0 = Date.now();
    const since = () => Date.now() - t0;
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = false;

    if (lang) rec.lang = lang;
    log.debug('builtinOnce: recognizer constructed', {
      lang: lang ?? '(browser default)',
      timeoutMs,
    });

    let transcript = '';
    let settled = false;
    const timer = setTimeout(() => {
      log.debug('builtinOnce: timeout reached — stopping recognizer', { elapsedMs: since() });
      try {
        rec.stop();
      } catch {}
    }, timeoutMs);

    rec.onstart = () =>
      log.debug('builtinOnce: onstart (recognition service active)', {
        elapsedMs: since(),
      });
    rec.onaudiostart = () =>
      log.debug('builtinOnce: onaudiostart (capturing audio)', {
        elapsedMs: since(),
      });
    rec.onspeechstart = () =>
      log.debug('builtinOnce: onspeechstart (speech detected)', {
        elapsedMs: since(),
      });
    rec.onspeechend = () =>
      log.debug('builtinOnce: onspeechend (speech ended)', {
        elapsedMs: since(),
      });
    rec.onnomatch = () =>
      log.debug('builtinOnce: onnomatch (no recognizable speech)', {
        elapsedMs: since(),
      });

    rec.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        parts.push(event.results[i][0]?.transcript ?? '');
      }
      transcript = parts.join(' ').trim();
      log.debug('builtinOnce: onresult', {
        elapsedMs: since(),
        resultCount: event.results.length,
        transcriptLength: transcript.length,
      });
    };
    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        log.debug('builtinOnce: onerror (non-fatal — ends with empty transcript)', {
          elapsedMs: since(),
          code: event.error,
        });
        return;
      }
      settled = true;
      clearTimeout(timer);
      log.error('builtinOnce: onerror (fatal)', { elapsedMs: since(), code: event.error });
      reject(new SpeechRecognitionError(event.error));
    };
    rec.onend = () => {
      clearTimeout(timer);
      if (!settled) {
        log.debug('builtinOnce: onend — resolving', {
          elapsedMs: since(),
          transcriptLength: transcript.length,
          empty: transcript.length === 0,
        });
        resolve(transcript);
      } else {
        log.debug('builtinOnce: onend after fatal error (already rejected)', {
          elapsedMs: since(),
        });
      }
    };
    log.debug('builtinOnce: calling recognizer.start()', { elapsedMs: since() });
    rec.start();
  });
}

async function acquireMicrophoneStream(deviceId: string | undefined): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  };
  const surface = resolvePermissionSurface();
  if (surface) {
    log.debug('acquireMicrophoneStream: requesting microphone via permission surface', {
      hasDeviceId: !!deviceId,
    });
    const result = await surface.prompt({
      kinds: ['microphone'],
      description: 'The hear command needs your microphone to transcribe speech.',
      requestOptions: { microphone: { constraints } },

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
      } catch {}
      teardown();
    },
  };
}

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

function releasePrimedStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  log.debug('primeBuiltinPermission: released primed microphone stream');
}

async function captureEnhanced(opts: HearCaptureOptions, timeoutMs: number): Promise<HearResult> {
  const recording = await recordUntil(opts.deviceId);
  let builtinText = '';
  try {
    builtinText = await builtinOnce(opts.lang, timeoutMs);
  } catch (err) {
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

  let primedStream = await primeBuiltinPermission(opts.deviceId);
  try {
    const transcript = await builtinOnce(opts.lang, timeoutMs);
    log.debug('hearCapture: builtin recognition produced a transcript');
    return { transcript, engine: 'builtin' };
  } catch (err) {
    if (!isUnsupportedSpeechError(err)) {
      log.error('hearCapture: builtin recognition failed', err);
      throw err;
    }
    if (enhancedReady) {
      log.debug(
        'hearCapture: builtin unsupported in this browser; falling back to enhanced whisper'
      );

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

export async function hearTranscribe(bytes: ArrayBuffer, lang?: string): Promise<HearResult> {
  const asr = await getWhisper();
  const audio = await decodeToMono16k(bytes);
  const transcript = await asr.transcribe(audio, { language: whisperLanguage(lang) });
  return { transcript, engine: 'enhanced' };
}

export function hearStatus(): HearStatus {
  const snapshot = whisperDownloadSnapshot();
  return {
    state: whisperLoadState(),
    ...(snapshot
      ? { loaded: snapshot.loaded, total: snapshot.total, etaSeconds: snapshot.etaSeconds }
      : {}),
  };
}

export function hearWarmup(): HearStatus {
  getWhisper().catch(() => {});
  return hearStatus();
}
