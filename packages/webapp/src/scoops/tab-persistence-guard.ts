/**
 * Prevents the host browser tab from being discarded by Chrome's memory
 * pressure heuristics while followers are attached to a tray leader.
 *
 * Chrome considers tabs with active inaudible audio playback, held Web Locks,
 * and registered `beforeunload` handlers as "important" and rarely discards
 * them. We combine all three to maximize the chance the leader stays
 * resident while followers are connected.
 *
 * The guard is a no-op in environments where AudioContext / navigator.locks
 * are unavailable (e.g. node tests, restricted iframes); failures are logged
 * but never propagated.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('tab-persistence-guard');

export interface TabPersistenceGuardOptions {
  /** Override the AudioContext constructor (testing). */
  audioContextFactory?: () => AudioContextLike | null;
  /** Override navigator.locks-style API (testing). */
  lockManager?: LockManagerLike | null;
  /** Override window for adding beforeunload listener (testing). */
  windowRef?: WindowLike | null;
}

export interface AudioContextLike {
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): { connect(node: unknown): void; start(): void; stop(): void };
  createGain(): { connect(node: unknown): void; gain: { value: number } };
  readonly destination: unknown;
}

export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; signal?: AbortSignal },
    callback: () => Promise<unknown>
  ): Promise<unknown>;
}

export interface WindowLike {
  addEventListener(type: 'beforeunload', listener: () => void): void;
  removeEventListener(type: 'beforeunload', listener: () => void): void;
}

const LOCK_NAME = 'slicc-tray-leader-active';

export class TabPersistenceGuard {
  private active = false;
  private audioCtx: AudioContextLike | null = null;
  private oscillator: { stop(): void } | null = null;
  private lockController: AbortController | null = null;
  private beforeUnloadHandler: (() => void) | null = null;

  constructor(private readonly options: TabPersistenceGuardOptions = {}) {}

  /**
   * Start holding all the anti-discard signals. Idempotent.
   */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.startSilentAudio();
    this.acquireWebLock();
    this.installBeforeUnload();
    log.info('Tab persistence guard activated');
  }

  /**
   * Release all anti-discard signals. Idempotent.
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.stopSilentAudio();
    this.releaseWebLock();
    this.removeBeforeUnload();
    log.info('Tab persistence guard deactivated');
  }

  isActive(): boolean {
    return this.active;
  }

  private startSilentAudio(): void {
    try {
      const factory =
        this.options.audioContextFactory ??
        (() => {
          const Ctor =
            typeof globalThis !== 'undefined'
              ? ((globalThis as { AudioContext?: { new (): AudioContextLike } }).AudioContext ??
                (globalThis as { webkitAudioContext?: { new (): AudioContextLike } })
                  .webkitAudioContext)
              : undefined;
          return Ctor ? new Ctor() : null;
        });
      const ctx = factory();
      if (!ctx) {
        log.warn('AudioContext unavailable — discard prevention via silent audio disabled');
        return;
      }
      // Resume the context (browsers often start it suspended without a gesture).
      void ctx.resume?.().catch(() => {});
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      // Silent: gain of 0 keeps the audio graph "active" without emitting sound.
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      this.audioCtx = ctx;
      this.oscillator = oscillator;
    } catch (error) {
      log.warn('Failed to start silent audio guard', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopSilentAudio(): void {
    try {
      this.oscillator?.stop();
    } catch {
      // Already stopped.
    }
    this.oscillator = null;
    if (this.audioCtx) {
      void this.audioCtx.close?.().catch(() => {});
      this.audioCtx = null;
    }
  }

  private acquireWebLock(): void {
    try {
      const manager =
        this.options.lockManager ??
        (typeof navigator !== 'undefined' && 'locks' in navigator
          ? (navigator as unknown as { locks: LockManagerLike }).locks
          : null);
      if (!manager) {
        log.warn('navigator.locks unavailable — discard prevention via Web Lock disabled');
        return;
      }
      const controller = new AbortController();
      this.lockController = controller;
      // Hold the lock indefinitely by returning a promise that only resolves
      // when the abort signal fires.
      manager
        .request(LOCK_NAME, { mode: 'exclusive', signal: controller.signal }, () => {
          return new Promise<void>((resolve) => {
            // The abort may already have happened between AbortController
            // construction and the lock manager invoking the callback. In
            // that case the 'abort' event will not fire again, so we'd
            // hold the lock forever — short-circuit on signal.aborted.
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            const onAbort = () => {
              controller.signal.removeEventListener('abort', onAbort);
              resolve();
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
        })
        .catch((error: unknown) => {
          // AbortError is expected during deactivate.
          const name = (error as { name?: string } | null)?.name;
          if (name !== 'AbortError') {
            log.warn('Web Lock request rejected', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
    } catch (error) {
      log.warn('Failed to acquire Web Lock', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private releaseWebLock(): void {
    try {
      this.lockController?.abort();
    } catch {
      // Ignore.
    }
    this.lockController = null;
  }

  private installBeforeUnload(): void {
    try {
      const win =
        this.options.windowRef ??
        (typeof window !== 'undefined' ? (window as unknown as WindowLike) : null);
      if (!win) return;
      const handler = () => {
        // Presence of the listener is the discard-prevention signal; we
        // intentionally do not show a confirmation prompt.
      };
      win.addEventListener('beforeunload', handler);
      this.beforeUnloadHandler = handler;
    } catch {
      // Ignore.
    }
  }

  private removeBeforeUnload(): void {
    try {
      const win =
        this.options.windowRef ??
        (typeof window !== 'undefined' ? (window as unknown as WindowLike) : null);
      if (win && this.beforeUnloadHandler) {
        win.removeEventListener('beforeunload', this.beforeUnloadHandler);
      }
    } catch {
      // Ignore.
    }
    this.beforeUnloadHandler = null;
  }
}
