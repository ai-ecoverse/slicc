import type { CDPPayload } from '@slicc/shared-ts';

interface PendingEntry<Result> {
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRequestTable<Id, Result = CDPPayload> {
  private readonly pending = new Map<Id, PendingEntry<Result>>();

  issue(id: Id, timeoutMs: number, timeoutMessage: string): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  has(id: Id): boolean {
    return this.pending.has(id);
  }

  resolve(id: Id, result: Result): void {
    const entry = this.take(id);
    entry?.resolve(result);
  }

  reject(id: Id, error: Error): void {
    const entry = this.take(id);
    entry?.reject(error);
  }

  rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  private take(id: Id): PendingEntry<Result> | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }
}

export interface AbortWaiter {
  signal: AbortSignal | undefined;
  error: () => Error;
}

export function waitForEvent<T>(
  subscribe: (handler: (value: T) => void) => () => void,
  timeoutMs: number,
  timeoutMessage: string,
  abort?: AbortWaiter
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (abort?.signal?.aborted) {
      reject(abort.error());
      return;
    }
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    let onAbort: (() => void) | undefined;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      if (onAbort) abort?.signal?.removeEventListener('abort', onAbort);
      unsubscribe?.();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    if (abort?.signal) {
      onAbort = (): void => {
        finish();
        reject(abort.error());
      };
      abort.signal.addEventListener('abort', onAbort, { once: true });
    }
    unsubscribe = subscribe((value) => {
      finish();
      resolve(value);
    });

    if (settled) unsubscribe();
  });
}
