import { labelDevices } from './devices.js';

export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

export interface SpeechDownloadProgress {
  loaded: number;

  total: number;

  etaSeconds: number | null;
}

export interface SpeechEngineStatus {
  engine: 'builtin' | 'enhanced';
  state: 'idle' | 'downloading' | 'ready' | 'unavailable';
  download?: SpeechDownloadProgress;
  message?: string;
}

export interface SpeechSessionOptions {
  deviceId?: string;

  lang?: string;

  onPartial?: (text: string) => void;

  onError?: (message: string) => void;
}

export interface SpeechSession {
  stop(): Promise<string>;

  cancel(): void;
}

export interface ComposerSpeech {
  permission(): Promise<PermissionState>;

  requestPermission(): Promise<boolean>;

  microphones(): Promise<MicrophoneInfo[]>;

  start(opts: SpeechSessionOptions): Promise<SpeechSession>;

  status(): SpeechEngineStatus;

  onStatus(cb: (status: SpeechEngineStatus) => void): () => void;

  warmup(): void;
}

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

interface WindowWithSpeechRecognition {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as WindowWithSpeechRecognition;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const STOP_RESOLVE_TIMEOUT_MS = 3000;

const BUILTIN_STATUS: SpeechEngineStatus = { engine: 'builtin', state: 'idle' };

export function createBuiltinComposerSpeech(): ComposerSpeech {
  return {
    async permission(): Promise<PermissionState> {
      try {
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        return status.state;
      } catch {
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
          } catch {}
          settleEnd();
        },
      };
    },

    status(): SpeechEngineStatus {
      return BUILTIN_STATUS;
    },

    onStatus(cb: (status: SpeechEngineStatus) => void): () => void {
      cb(BUILTIN_STATUS);
      return () => {};
    },

    warmup(): void {},
  };
}
