/**
 * The webapp's `ComposerSpeech` controller — the speech stack injected into
 * `<slicc-composer>`'s push-to-talk gesture (and shared by the `hear`
 * command's page-side capture).
 *
 * Two engines behind the one interface the component knows:
 *
 * - **builtin** — the library's Web Speech implementation (instant, network
 *   recognizer, streams interim results). Permission + device enumeration
 *   always delegate here.
 * - **enhanced** — on-device whisper-tiny via `whisper-engine.ts`. `warmup()`
 *   (called on the first granted hold) kicks the lazy ~150 MB model download
 *   in the background; status subscribers see `downloading` with a live
 *   loaded/total/ETA, then `ready`. From then on `start()` records the chosen
 *   microphone and transcribes locally; any capture/engine failure falls back
 *   to the builtin recognizer for that session rather than breaking dictation.
 *
 * Page/offscreen realm only (mic + AudioContext) — the kernel worker reaches
 * this through the `hear-*` panel-RPC ops.
 */

// Deep subpath import (NOT the package barrel): the barrel registers every
// custom element at import time, which breaks DOM-less realms (node tests,
// the kernel worker's type graph). The speech contract module is DOM-free.
import {
  type ComposerSpeech,
  createBuiltinComposerSpeech,
  type SpeechEngineStatus,
  type SpeechSession,
  type SpeechSessionOptions,
} from '@slicc/webcomponents/composer/speech';
import { createLogger } from '../core/logger.js';
import type { DownloadSnapshot } from './download-progress.js';
import { getWhisper, type WhisperAsr, type WhisperProgress } from './whisper-engine.js';
import { startWhisperSession } from './whisper-session.js';

const log = createLogger('speech:composer');

/** Injectable seams for tests (real wiring by default). */
export interface ComposerSpeechDeps {
  builtin?: ComposerSpeech;
  loadWhisper?: (onProgress: WhisperProgress) => Promise<WhisperAsr>;
  startSession?: typeof startWhisperSession;
}

class WebappComposerSpeech implements ComposerSpeech {
  readonly #builtin: ComposerSpeech;
  readonly #loadWhisper: (onProgress: WhisperProgress) => Promise<WhisperAsr>;
  readonly #startSession: typeof startWhisperSession;

  #asr: WhisperAsr | null = null;
  #warmupStarted = false;
  #status: SpeechEngineStatus = { engine: 'builtin', state: 'idle' };
  readonly #subs = new Set<(status: SpeechEngineStatus) => void>();

  constructor(deps: ComposerSpeechDeps = {}) {
    this.#builtin = deps.builtin ?? createBuiltinComposerSpeech();
    this.#loadWhisper = deps.loadWhisper ?? getWhisper;
    this.#startSession = deps.startSession ?? startWhisperSession;
  }

  permission(): Promise<PermissionState> {
    return this.#builtin.permission();
  }

  requestPermission(): Promise<boolean> {
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
    this.#setStatus({ engine: 'builtin', state: 'downloading' });
    this.#loadWhisper((snapshot) => this.#onDownloadProgress(snapshot)).then(
      (asr) => {
        this.#asr = asr;
        this.#setStatus({ engine: 'enhanced', state: 'ready' });
      },
      (err) => {
        // The builtin recognizer keeps dictation working; allow a later
        // warmup() to retry (e.g. the network came back).
        this.#warmupStarted = false;
        this.#setStatus({ engine: 'builtin', state: 'unavailable' });
        log.warn('enhanced speech engine unavailable', err);
      }
    );
  }

  async start(opts: SpeechSessionOptions): Promise<SpeechSession> {
    const asr = this.#asr;
    if (asr) {
      try {
        return await this.#startSession(asr, {
          deviceId: opts.deviceId,
          lang: opts.lang,
          onPartial: opts.onPartial,
          onError: opts.onError,
        });
      } catch (err) {
        // Capture failed (device unplugged, permission revoked mid-session…)
        // — degrade to the builtin recognizer for this session.
        log.warn('whisper session failed to start; falling back to builtin', err);
      }
    }
    return this.#builtin.start(opts);
  }

  /** Whether the enhanced engine is loaded (used by the hear helpers). */
  get enhancedReady(): boolean {
    return this.#asr !== null;
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

/** Build a controller with injectable seams (tests). */
export function createComposerSpeech(deps: ComposerSpeechDeps = {}): ComposerSpeech {
  return new WebappComposerSpeech(deps);
}

let singleton: WebappComposerSpeech | null = null;

/**
 * The shared controller for this realm — the composer's PTT gesture and the
 * `hear` page-side capture use the same instance so the model downloads once
 * and the engine upgrade benefits both.
 */
export function getComposerSpeech(): ComposerSpeech {
  singleton ??= new WebappComposerSpeech();
  return singleton;
}

/** Test-only: drop the realm singleton. */
export function resetComposerSpeechForTests(): void {
  singleton = null;
}
