import { labelDevices } from './devices.js';

/**
 * Speech contract for the composer's push-to-talk gesture.
 *
 * `<slicc-composer>` owns the GESTURE (hold-to-enable, hold-to-dictate,
 * captions, the mic picker) but not the AUDIO STACK. A host injects a
 * `ComposerSpeech` controller via the component's `speech` property; when none
 * is injected the component falls back to {@link createBuiltinComposerSpeech},
 * which wraps the browser's own Web Speech API so the library keeps working
 * standalone (Storybook, tests, simple embeds).
 *
 * The two-engine story lives behind this one interface: a controller reports
 * its current engine via {@link ComposerSpeech.status} (`builtin` until an
 * enhanced on-device model has downloaded, then `enhanced`), streams download
 * progress + ETA through {@link ComposerSpeech.onStatus}, and decides per
 * {@link ComposerSpeech.start} call which recognizer actually runs. The
 * composer renders whatever the status stream says — it never knows which
 * model is listening.
 */

/** An available audio-input device, as shown in the overlay's mic picker. */
export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

/** Progress of an enhanced-model download, for the "ready in ~ETA" line. */
export interface SpeechDownloadProgress {
  /** Bytes fetched so far across all model files. */
  loaded: number;
  /** Total bytes expected across all model files (0 while still unknown). */
  total: number;
  /** Estimated seconds until ready, or null while the rate is still unknown. */
  etaSeconds: number | null;
}

/**
 * The engine snapshot the composer renders from.
 *
 * - `engine` — which recognizer the NEXT session will use.
 * - `state` — the enhanced model's lifecycle: `idle` (not requested),
 *   `downloading` (progress in `download`), `ready`, or `unavailable`
 *   (load failed / unsupported; the controller stays on `builtin`).
 * - `message` — optional human-readable note. On `unavailable` it carries the
 *   actionable failure reason the composer renders in place of hiding the line.
 */
export interface SpeechEngineStatus {
  engine: 'builtin' | 'enhanced';
  state: 'idle' | 'downloading' | 'ready' | 'unavailable';
  download?: SpeechDownloadProgress;
  message?: string;
}

/** Options for one push-to-talk dictation session. */
export interface SpeechSessionOptions {
  /** Preferred input device (capture-based engines only — the browser's
   *  built-in recognizer always listens on the system default). */
  deviceId?: string;
  /** BCP-47 language tag. Omit for auto-detect: capture-based engines
   *  (whisper) detect the spoken language; the built-in recognizer keeps
   *  the browser's own default. */
  lang?: string;
  /** Streaming partial transcript — the composer's closed-caption line. */
  onPartial?: (text: string) => void;
  /** Non-fatal session error (shown in the caption line). */
  onError?: (message: string) => void;
}

/** A live dictation session: exactly one of `stop`/`cancel` ends it. */
export interface SpeechSession {
  /** Stop listening and resolve the final transcript ('' when nothing). */
  stop(): Promise<string>;
  /** Abort without a transcript (pointer left the band, teardown, …). */
  cancel(): void;
}

/** The host-injectable speech controller behind the composer's PTT gesture. */
export interface ComposerSpeech {
  /** Current microphone permission ('granted' | 'prompt' | 'denied'). */
  permission(): Promise<PermissionState>;
  /** Trigger the browser's mic prompt; resolves true when granted. */
  requestPermission(): Promise<boolean>;
  /** Enumerate audio inputs (labels need a prior grant). */
  microphones(): Promise<MicrophoneInfo[]>;
  /** Begin a dictation session. Rejects when no recognizer is available. */
  start(opts: SpeechSessionOptions): Promise<SpeechSession>;
  /** Synchronous engine snapshot (render-friendly). */
  status(): SpeechEngineStatus;
  /** Subscribe to engine/download changes; fires immediately with the
   *  current snapshot. Returns the unsubscribe function. */
  onStatus(cb: (status: SpeechEngineStatus) => void): () => void;
  /** Kick the enhanced-model download (idempotent, fire-and-forget).
   *  Builtin-only controllers treat this as a no-op. */
  warmup(): void;
}

// ── Built-in (Web Speech API) controller ────────────────────────────

// Chrome-specific Web Speech shapes — not in all TS lib sets, so declare
// the minimal slice we touch (mirrors the webapp's voice-input.ts).
interface BuiltinRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}
interface BuiltinRecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: BuiltinRecognitionResult };
}
interface BuiltinRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BuiltinRecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?: () => void;
}

type RecognitionCtor = new () => BuiltinRecognition;

/** Resolve the browser's SpeechRecognition constructor (Chrome: webkit-prefixed). */
function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as RecognitionCtor) ??
    (w.webkitSpeechRecognition as RecognitionCtor) ??
    null
  );
}

/** How long `stop()` waits for the recognizer's `end` event before giving up
 *  and resolving with whatever transcript has accumulated. */
const STOP_RESOLVE_TIMEOUT_MS = 3000;

const BUILTIN_STATUS: SpeechEngineStatus = { engine: 'builtin', state: 'idle' };

/**
 * The default `ComposerSpeech`: permission via the Permissions API (probed
 * through `getUserMedia` on request), device enumeration via
 * `mediaDevices.enumerateDevices`, and recognition via the browser's built-in
 * `SpeechRecognition` (continuous + interim results, so the caption line
 * streams). There is no enhanced engine here — `status()` stays `builtin` and
 * `warmup()` is a no-op; richer hosts (the webapp) inject their own controller.
 */
export function createBuiltinComposerSpeech(): ComposerSpeech {
  return {
    async permission(): Promise<PermissionState> {
      try {
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        return status.state;
      } catch {
        // Permissions API missing or 'microphone' unsupported — assume the
        // prompt path so the hold-to-enable stage runs.
        return 'prompt';
      }
    },

    async requestPermission(): Promise<boolean> {
      if (!navigator.mediaDevices?.getUserMedia) return false;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return true;
      } catch {
        return false;
      }
    },

    async microphones(): Promise<MicrophoneInfo[]> {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return labelDevices(
          devices.filter((d) => d.kind === 'audioinput'),
          'microphone'
        );
      } catch {
        return [];
      }
    },

    async start(opts: SpeechSessionOptions): Promise<SpeechSession> {
      const Ctor = recognitionCtor();
      if (!Ctor) throw new Error('Speech recognition is not supported in this browser.');

      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      // No lang means auto-detect: leave the recognizer on its browser
      // default rather than forcing a tag (Web Speech has no true
      // auto-detect; the capture-based whisper engine does).
      if (opts.lang) rec.lang = opts.lang;

      let finals = '';
      let interim = '';
      let ended = false;
      let endResolvers: (() => void)[] = [];

      const settleEnd = () => {
        ended = true;
        const pending = endResolvers;
        endResolvers = [];
        for (const resolve of pending) resolve();
      };

      rec.onresult = (event) => {
        interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) finals += result[0].transcript;
          else interim += result[0].transcript;
        }
        const preview = `${finals}${interim}`.trim();
        if (preview) opts.onPartial?.(preview);
      };

      rec.onerror = (event) => {
        // `no-speech` / `aborted` are normal for short holds — stay quiet.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          opts.onError?.(`Speech recognition error: ${event.error}`);
        }
      };

      rec.onend = settleEnd;
      rec.start();

      const transcript = () => `${finals}${interim}`.trim();

      return {
        stop(): Promise<string> {
          if (ended) return Promise.resolve(transcript());
          return new Promise<string>((resolve) => {
            // Late results can still land between stop() and end — resolve
            // from the accumulated state once the recognizer settles (or the
            // safety timeout fires; Chrome occasionally never emits `end`).
            const timer = setTimeout(() => resolve(transcript()), STOP_RESOLVE_TIMEOUT_MS);
            endResolvers.push(() => {
              clearTimeout(timer);
              resolve(transcript());
            });
            try {
              rec.stop();
            } catch {
              clearTimeout(timer);
              resolve(transcript());
            }
          });
        },
        cancel(): void {
          rec.onresult = null;
          rec.onerror = null;
          rec.onend = null;
          try {
            (rec.abort ?? rec.stop).call(rec);
          } catch {
            /* already stopped */
          }
          settleEnd();
        },
      };
    },

    status(): SpeechEngineStatus {
      return BUILTIN_STATUS;
    },

    onStatus(cb: (status: SpeechEngineStatus) => void): () => void {
      // The builtin engine never changes state — emit once, nothing to track.
      cb(BUILTIN_STATUS);
      return () => {};
    },

    warmup(): void {
      /* no enhanced engine to warm */
    },
  };
}
