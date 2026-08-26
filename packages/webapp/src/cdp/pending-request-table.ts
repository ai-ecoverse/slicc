/**
 * Shared request-table + event-waiter primitives for `CDPTransport`
 * implementations.
 *
 * Every transport (`CDPClient`, `RemoteCDPTransport`, `CherryHostTransport`,
 * `PreviewBridgeCdpTransport`, `CdpTransportBridge`) needs the same two
 * pieces: a map of in-flight requests keyed by wire id with a per-request
 * timeout, and a `once(event)` waiter that unsubscribes on both settle and
 * timeout. Only the wire encoding differs, so it stays in the transports and
 * the plumbing lives here.
 *
 * Worker safety: timers, `Map` and `Promise` only — no DOM, no chrome.*.
 */

import type { CDPPayload } from '@slicc/shared-ts';

interface PendingEntry<Result> {
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRequestTable<Id, Result = CDPPayload> {
  private readonly pending = new Map<Id, PendingEntry<Result>>();

  /**
   * Register a request under `id` and return the promise the caller awaits.
   * The entry self-removes and rejects with `timeoutMessage` after
   * `timeoutMs`. Callers send on the wire AFTER calling this so a synchronous
   * response can still find the entry.
   */
  issue(id: Id, timeoutMs: number, timeoutMessage: string): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** True while `id` is in flight — for arrival paths that buffer partial responses. */
  has(id: Id): boolean {
    return this.pending.has(id);
  }

  /** Settle `id` successfully. No-op when it already timed out or settled. */
  resolve(id: Id, result: Result): void {
    const entry = this.take(id);
    entry?.resolve(result);
  }

  /** Settle `id` with a failure. No-op when it already timed out or settled. */
  reject(id: Id, error: Error): void {
    const entry = this.take(id);
    entry?.reject(error);
  }

  /** Fail every in-flight request with `reason` and empty the table. */
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

/**
 * Resolve with the first value delivered by `subscribe`, or reject with
 * `timeoutMessage` after `timeoutMs`. Unsubscribes on both paths.
 */
export function waitForEvent<T>(
  subscribe: (handler: (value: T) => void) => () => void,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      unsubscribe?.();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    unsubscribe = subscribe((value) => {
      clearTimeout(timer);
      settled = true;
      unsubscribe?.();
      resolve(value);
    });
    // A subscriber that delivered synchronously settled before `unsubscribe`
    // was assigned — tear it down now.
    if (settled) unsubscribe();
  });
}
