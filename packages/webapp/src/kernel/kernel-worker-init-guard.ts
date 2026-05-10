/**
 * Init re-entrancy guard for `kernel-worker.ts`.
 *
 * Lives in its own module so tests can import the factory without
 * triggering kernel-worker.ts's module-load side effect
 * (`self.addEventListener('message', …)`), which crashes in a node
 * test environment where `self` is undefined.
 *
 * The guard pattern: a second `kernel-worker-init` arriving before
 * the first boot has fully resolved is dropped with a warning.
 * Without the guard, two concurrent `boot()` calls would race on
 * `createKernelHost`, `orchestrator.init`, and
 * `globalThis.__slicc_pm`, leaving the host in indeterminate state.
 *
 * Reset-on-error: if the boot promise rejects, the guard resets so
 * the page can retry. Successful boots leave the guard latched —
 * the worker is single-shot.
 */

import type { KernelWorkerInitMsg } from './kernel-worker.js';

export interface KernelWorkerInitGuard {
  /** Process an init message. First call runs `bootFn`; subsequent calls drop. */
  handle(init: KernelWorkerInitMsg): void;
  /** Reflect the guard's latched state. Used by tests. */
  isInitialized(): boolean;
}

export interface KernelWorkerInitGuardOptions {
  /** Called when `bootFn` rejects. Default logs to console. */
  onError?: (err: unknown) => void;
  /** Called when a duplicate init is dropped. Default logs to console. */
  onDuplicate?: () => void;
}

export function makeKernelWorkerInitGuard(
  bootFn: (init: KernelWorkerInitMsg) => Promise<void>,
  options: KernelWorkerInitGuardOptions = {}
): KernelWorkerInitGuard {
  const onError =
    options.onError ?? ((err: unknown) => console.error('[kernel-worker] boot failed', err));
  const onDuplicate =
    options.onDuplicate ??
    (() => console.warn('[kernel-worker] received duplicate kernel-worker-init; ignoring'));
  let initialized = false;
  return {
    handle(init: KernelWorkerInitMsg): void {
      if (initialized) {
        onDuplicate();
        return;
      }
      initialized = true;
      void bootFn(init).catch((err) => {
        initialized = false;
        onError(err);
      });
    },
    isInitialized(): boolean {
      return initialized;
    },
  };
}
