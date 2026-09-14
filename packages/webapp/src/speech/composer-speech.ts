import {
  type ComposerSpeech,
  createBuiltinComposerSpeech,
  type SpeechEngineStatus,
  type SpeechSession,
  type SpeechSessionOptions,
} from '@slicc/webcomponents/composer/speech';
import { createLogger } from '../base/logger.js';
import { getLeaderPermissionsSurface } from '../core/permissions-surface-registry.js';
import { isExtensionRealm } from '../core/runtime-env.js';
import { callEnsureSpeechAssets } from '../kernel/speech-assets-bridge.js';
import {
  createDownloadTracker,
  type DownloadSnapshot,
  type DownloadTracker,
} from './download-progress.js';
import type { SpeechAssetProgress, SpeechAssetProgressFn } from './ensure-speech-assets.js';
import { getWhisper, type WhisperAsr, type WhisperProgress } from './whisper-engine.js';
import { startWhisperSession } from './whisper-session.js';

const log = createLogger('speech:composer');

const CAPTURE_TIMEOUT_MS = 5000;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

export interface MicPermissionSurface {
  request(
    kind: 'microphone',
    opts?: { constraints?: MediaStreamConstraints }
  ): Promise<{ kind: 'microphone'; stream: MediaStream } | null>;
}

export interface ComposerSpeechDeps {
  builtin?: ComposerSpeech;
  loadWhisper?: (onProgress: WhisperProgress) => Promise<WhisperAsr>;
  startSession?: typeof startWhisperSession;

  getPermissionSurface?: () => MicPermissionSurface | null;

  ensureAssets?: (onProgress: SpeechAssetProgressFn) => Promise<void>;
}

class WebappComposerSpeech implements ComposerSpeech {
  readonly #builtin: ComposerSpeech;
  readonly #loadWhisper: (onProgress: WhisperProgress) => Promise<WhisperAsr>;
  readonly #startSession: typeof startWhisperSession;
  readonly #getPermissionSurface: () => MicPermissionSurface | null;
  readonly #ensureAssets: (onProgress: SpeechAssetProgressFn) => Promise<void>;

  #asr: WhisperAsr | null = null;
  #warmupStarted = false;
  #status: SpeechEngineStatus = { engine: 'builtin', state: 'idle' };
  #stageTracker: DownloadTracker = createDownloadTracker();
  readonly #subs = new Set<(status: SpeechEngineStatus) => void>();

  #heldStream: MediaStream | null = null;

  constructor(deps: ComposerSpeechDeps = {}) {
    this.#builtin = deps.builtin ?? createBuiltinComposerSpeech();
    this.#loadWhisper = deps.loadWhisper ?? getWhisper;
    this.#startSession = deps.startSession ?? startWhisperSession;
    this.#getPermissionSurface = deps.getPermissionSurface ?? defaultPermissionSurfaceLookup;
    this.#ensureAssets = deps.ensureAssets ?? defaultEnsureAssets;
  }

  permission(): Promise<PermissionState> {
    return this.#builtin.permission();
  }

  async requestPermission(): Promise<boolean> {
    const surface = this.#getPermissionSurface();
    if (surface) {
      try {
        const grant = await surface.request('microphone');
        if (!grant) return false;

        this.#setHeldStream(grant.stream);
        return true;
      } catch (err) {
        log.warn('permission surface microphone request failed', err);
        return false;
      }
    }
    return this.#builtin.requestPermission();
  }

  microphones() {
    return this.#builtin.microphones();
  }

  status(): SpeechEngineStatus {
    return this.#status;
  }

  onStatus(cb: (status: SpeechEngineStatus) => void): () => void {
    this.#subs.add(cb);
    cb(this.#status);
    return () => this.#subs.delete(cb);
  }

  warmup(): void {
    if (this.#warmupStarted) return;
    this.#warmupStarted = true;
    this.#stageTracker = createDownloadTracker();
    this.#setStatus({ engine: 'builtin', state: 'downloading' });
    this.#warmupToReady().then(
      (asr) => {
        this.#asr = asr;
        this.#setStatus({ engine: 'enhanced', state: 'ready' });
      },
      (err) => {
        this.#warmupStarted = false;
        this.#setStatus({
          engine: 'builtin',
          state: 'unavailable',
          message: warmupFailureMessage(err),
        });
        log.warn('enhanced speech engine unavailable', err);
      }
    );
  }

  async #warmupToReady(): Promise<WhisperAsr> {
    let stageError: unknown = null;
    try {
      await this.#ensureAssets((progress) => this.#onStageProgress(progress));
    } catch (err) {
      stageError = err;
      log.warn('speech asset staging failed; trying already-present assets', err);
    }
    try {
      return await this.#loadWhisper((snapshot) => this.#onDownloadProgress(snapshot));
    } catch (loadErr) {
      throw stageError ?? loadErr;
    }
  }

  async start(opts: SpeechSessionOptions): Promise<SpeechSession> {
    const asr = this.#asr;
    if (asr) {
      let stream: MediaStream | null = null;
      try {
        stream = await this.#acquireMicrophoneStream(opts.deviceId);
        return await this.#startSession(asr, {
          deviceId: opts.deviceId,
          lang: opts.lang,
          onPartial: opts.onPartial,
          onError: opts.onError,
          stream: stream ?? undefined,
        });
      } catch (err) {
        if (stream) for (const track of stream.getTracks()) track.stop();
        log.warn('whisper session failed to start; falling back to builtin', err);
      }
    }
    return this.#builtin.start(opts);
  }

  async #acquireMicrophoneStream(deviceId: string | undefined): Promise<MediaStream | null> {
    const specificDevice = deviceId && deviceId !== 'default' ? deviceId : undefined;
    const held = this.#takeHeldStream();
    if (held) {
      if (!specificDevice && streamHasLiveAudio(held)) return held;

      for (const track of held.getTracks()) track.stop();
    }
    const surface = this.#getPermissionSurface();
    if (!surface) return null;
    const constraints: MediaStreamConstraints = {
      audio: specificDevice ? { deviceId: { exact: specificDevice } } : true,
    };

    const grant = await withTimeout(
      surface.request('microphone', { constraints }),
      CAPTURE_TIMEOUT_MS,
      'microphone capture'
    );
    if (!grant) throw new Error('microphone permission denied');
    return grant.stream;
  }

  #setHeldStream(stream: MediaStream): void {
    if (this.#heldStream && this.#heldStream !== stream) {
      for (const track of this.#heldStream.getTracks()) track.stop();
    }
    this.#heldStream = stream;
  }

  #takeHeldStream(): MediaStream | null {
    const stream = this.#heldStream;
    this.#heldStream = null;
    return stream;
  }

  get enhancedReady(): boolean {
    return this.#asr !== null;
  }

  #onStageProgress(progress: SpeechAssetProgress): void {
    if (this.#status.state !== 'downloading') return;
    if (progress.bytesTotal != null || progress.bytesLoaded != null) {
      this.#stageTracker.update(
        progress.asset,
        progress.bytesLoaded ?? 0,
        progress.bytesTotal ?? 0
      );
    }
    const snapshot = this.#stageTracker.snapshot();
    if (snapshot.total <= 0) return;
    this.#setStatus({
      engine: 'builtin',
      state: 'downloading',
      download: {
        loaded: snapshot.loaded,
        total: snapshot.total,
        etaSeconds: snapshot.etaSeconds,
      },
    });
  }

  #onDownloadProgress(snapshot: DownloadSnapshot): void {
    if (this.#status.state !== 'downloading') return;
    this.#setStatus({
      engine: 'builtin',
      state: 'downloading',
      download: {
        loaded: snapshot.loaded,
        total: snapshot.total,
        etaSeconds: snapshot.etaSeconds,
      },
    });
  }

  #setStatus(status: SpeechEngineStatus): void {
    this.#status = status;
    for (const sub of this.#subs) sub(status);
  }
}

function defaultPermissionSurfaceLookup(): MicPermissionSurface | null {
  const surface = getLeaderPermissionsSurface();
  if (!surface) return null;
  return {
    async request(kind, opts) {
      const grant = await surface.request(kind, opts);
      if (grant?.kind !== 'microphone') return null;
      return { kind: 'microphone', stream: grant.stream };
    },
  };
}

function streamHasLiveAudio(stream: MediaStream): boolean {
  const tracks = stream.getTracks();
  return tracks.length > 0 && tracks.some((track) => track.readyState !== 'ended');
}

function warmupFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Enhanced speech unavailable: ${detail}`;
}

const isExtensionFloat = isExtensionRealm;

let assetsInstanceId: string | undefined;

export function setComposerSpeechInstanceId(instanceId: string | undefined): void {
  assetsInstanceId = instanceId;
}

function defaultEnsureAssets(onProgress: SpeechAssetProgressFn): Promise<void> {
  if (isExtensionFloat()) return Promise.resolve();
  return callEnsureSpeechAssets({ instanceId: assetsInstanceId, onProgress });
}

export function createComposerSpeech(deps: ComposerSpeechDeps = {}): ComposerSpeech {
  return new WebappComposerSpeech(deps);
}

let singleton: WebappComposerSpeech | null = null;

export function getComposerSpeech(): ComposerSpeech {
  singleton ??= new WebappComposerSpeech();
  return singleton;
}

export function resetComposerSpeechForTests(): void {
  singleton = null;
}
