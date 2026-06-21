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
import { callEnsureSpeechAssets } from '../kernel/speech-assets-bridge.js';
import { getLeaderPermissionsSurface } from '../ui/wc/wc-permissions-registry.js';
import {
  createDownloadTracker,
  type DownloadSnapshot,
  type DownloadTracker,
} from './download-progress.js';
import type { SpeechAssetProgress, SpeechAssetProgressFn } from './ensure-speech-assets.js';
import { getWhisper, type WhisperAsr, type WhisperProgress } from './whisper-engine.js';
import { startWhisperSession } from './whisper-session.js';

const log = createLogger('speech:composer');

/**
 * Minimal seam for the leader `<slicc-permissions>` surface — just the slice
 * we need to request a microphone grant. Defined locally so tests can fake it
 * without constructing the full custom element, and so this module can keep
 * its DOM-free import discipline (the real type is loaded `import type`-only).
 */
export interface MicPermissionSurface {
  request(
    kind: 'microphone',
    opts?: { constraints?: MediaStreamConstraints }
  ): Promise<{ kind: 'microphone'; stream: MediaStream } | null>;
}

/** Injectable seams for tests (real wiring by default). */
export interface ComposerSpeechDeps {
  builtin?: ComposerSpeech;
  loadWhisper?: (onProgress: WhisperProgress) => Promise<WhisperAsr>;
  startSession?: typeof startWhisperSession;
  /** Returns the mounted leader permission surface, or `null` when none. */
  getPermissionSurface?: () => MicPermissionSurface | null;
  /** Stage the on-device speech assets into the VFS before loading (R10). */
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
    // Route through the leader `<slicc-permissions>` surface when mounted so
    // every hardware grant in the leader tab funnels through one gesture-gated
    // surface (camera/mic/screenshare + usb/hid/serial + filesystem). PTT
    // press is the user activation; `surface.request('microphone')` runs the
    // native prompt under it. Probe-and-release: stop tracks before returning
    // — `start()` re-acquires a fresh stream when dictation actually begins.
    const surface = this.#getPermissionSurface();
    if (surface) {
      try {
        const grant = await surface.request('microphone');
        if (!grant) return false;
        for (const track of grant.stream.getTracks()) track.stop();
        return true;
      } catch (err) {
        // The surface emits its own `slicc-permission-deny` event for cancel
        // / unavailable / error paths — treat any throw as denied and let
        // the composer render the blocked-permission overlay.
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
        // The builtin recognizer keeps dictation working; allow a later
        // warmup() to retry (e.g. the network came back).
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

  /**
   * Stage the on-device assets (R10) then load whisper from the VFS. A staging
   * failure is not fatal on its own — the assets may already be present, in
   * which case the VFS-direct `getWhisper()` still succeeds. Only when BOTH the
   * staging AND the load fail does warmup reject (→ `unavailable`). The staging
   * error wins the message: it carries the host-named, actionable reason
   * (offline / HF unreachable / proxy down) when assets were never staged.
   */
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
      try {
        // Acquire the mic stream through the leader surface so capture
        // shares the same one-gesture path as `requestPermission`. The
        // grant returned from the page-realm `request()` call carries the
        // real `MediaStream`; cross-realm callers would subscribe to the
        // `slicc-permission-grant` event instead, but the composer lives
        // in the same realm as the surface and can use the return value.
        const stream = await this.#acquireMicrophoneStream(opts.deviceId);
        return await this.#startSession(asr, {
          deviceId: opts.deviceId,
          lang: opts.lang,
          onPartial: opts.onPartial,
          onError: opts.onError,
          stream: stream ?? undefined,
        });
      } catch (err) {
        // Capture failed (device unplugged, permission revoked mid-session…)
        // — degrade to the builtin recognizer for this session.
        log.warn('whisper session failed to start; falling back to builtin', err);
      }
    }
    return this.#builtin.start(opts);
  }

  /**
   * Get a fresh microphone `MediaStream` for a whisper session, preferring the
   * leader permission surface. Returns `null` when the surface isn't mounted
   * (early boot / non-WC mount) so `startWhisperSession` falls back to its own
   * `getUserMedia`. Throws when the surface is mounted but denies — letting
   * the caller route to the builtin recognizer for this session.
   */
  async #acquireMicrophoneStream(deviceId: string | undefined): Promise<MediaStream | null> {
    const surface = this.#getPermissionSurface();
    if (!surface) return null;
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    };
    const grant = await surface.request('microphone', { constraints });
    if (!grant) throw new Error('microphone permission denied');
    return grant.stream;
  }

  /** Whether the enhanced engine is loaded (used by the hear helpers). */
  get enhancedReady(): boolean {
    return this.#asr !== null;
  }

  /**
   * Map R10 staging progress into the `downloading` snapshot. The per-asset
   * tracker reuses `download-progress`'s aggregation: the `listing` phase
   * carries the byte totals and later file events carry cumulative loaded (the
   * tracker keeps the largest total seen per asset). Until a repo has been
   * listed there are no totals — `download` stays unset so the composer shows
   * its "preparing enhanced speech…" line.
   */
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

/**
 * Resolve the page-realm `<slicc-permissions>` element via the shared
 * registry. Returns `null` before the WC shell's attach pass mounts the
 * surface (early-boot races) — callers fall back to direct `getUserMedia`.
 *
 * The surface's `request(kind, opts)` signature is wider than the slice we
 * need (every `PermissionKind`, every `PermissionGrant` variant); cast down
 * to the microphone-only seam — we only ever pass `'microphone'` and the
 * surface's `#requestMicrophone` always returns a `microphone`-kind grant.
 */
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

/** A short, actionable failure note for the composer's status line. */
function warmupFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Enhanced speech unavailable: ${detail}`;
}

const isExtensionFloat = (): boolean => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

/** Kernel-worker instance id used to scope the page→worker speech-assets bridge. */
let assetsInstanceId: string | undefined;

/**
 * Wire the kernel-worker instance id so the realm singleton's warmup can reach
 * the page→worker speech-assets bridge (R10). Called by the WC live boot before
 * the composer's `speech` is set.
 */
export function setComposerSpeechInstanceId(instanceId: string | undefined): void {
  assetsInstanceId = instanceId;
}

/**
 * Default asset-staging seam: drive the page→worker bridge so the kernel worker
 * stages the ort runtime + whisper/kokoro weights into the VFS, streaming coarse
 * progress back. The extension float loads speech assets directly under
 * `host_permissions` (no VFS staging), so it skips the bridge — N/A by design,
 * and warmup then proceeds straight to the VFS-direct `getWhisper()` load.
 */
function defaultEnsureAssets(onProgress: SpeechAssetProgressFn): Promise<void> {
  if (isExtensionFloat()) return Promise.resolve();
  return callEnsureSpeechAssets({ instanceId: assetsInstanceId, onProgress });
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
