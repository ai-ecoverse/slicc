import type { KernelWorkerInitMsg } from './kernel-worker.js';

export interface KernelWorkerInitGuard {
  handle(init: KernelWorkerInitMsg): void;

  isInitialized(): boolean;
}

export interface KernelWorkerInitGuardOptions {
  onError?: (err: unknown) => void;

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
