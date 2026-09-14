import type { AbortWaiter } from './pending-request-table.js';

export class CommandAbortedError extends Error {
  override readonly name = 'CommandAbortedError';

  constructor(readonly step: string) {
    super(
      `Browser command aborted while ${step}. A CDP round trip already in flight cannot be ` +
        'cancelled, so it may still have been applied to the page; nothing after it was started.'
    );
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, step: string): void {
  if (signal?.aborted) throw new CommandAbortedError(step);
}

export function abortWaiter(
  signal: AbortSignal | undefined,
  step: string
): AbortWaiter | undefined {
  return signal ? { signal, error: () => new CommandAbortedError(step) } : undefined;
}

export function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
  step: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CommandAbortedError(step));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CommandAbortedError(step));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function raceAbort(
  queued: Promise<void>,
  signal: AbortSignal | undefined,
  step: string
): Promise<void> {
  if (!signal) return queued;
  if (signal.aborted) return Promise.reject(new CommandAbortedError(step));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new CommandAbortedError(step));
    signal.addEventListener('abort', onAbort, { once: true });
    queued.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
