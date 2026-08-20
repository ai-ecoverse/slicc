/**
 * Cone-approval sudo broker + pending-request registry.
 *
 * In NanoClaw, the cone agent (not the human user) reviews scoop-originated
 * sudo requests. The broker is the seam: a scoop's gated FS / shell call
 * goes through {@link SudoBroker.requestApproval}, which here enqueues a
 * pending request keyed by an id and returns a promise that resolves only
 * when (a) the cone calls `resolveSudoRequest(id, decision)`, (b) the
 * scoop is dropped, or (c) the configured timeout fires — all three of
 * (b) and (c) resolve fail-closed (`deny`) so a stalled cone never lets
 * a scoop slip through.
 *
 * The registry is intentionally a plain in-memory store with no UI / IPC
 * concerns; delivery of the request to the cone (lick + queued message)
 * is the orchestrator's job — see {@link ConeApprovalRouter}.
 *
 * Out of scope here: the `sudo_request` / `lick_confirm` tools that the cone
 * will use, and the wiring of this broker into `ScoopContext` for non-cone
 * scoops (the cone keeps the user broker). Those land in follow-up tasks.
 */

import { timedOutDecision } from './approval-timeout.js';
import type { SudoBroker, SudoDecision, SudoRequest } from './types.js';

/**
 * Default fail-closed timeout for a single pending sudo request. Matches
 * `USER_SUDO_TIMEOUT_MS` (the cone → user leg) so both hops of a delegated
 * approval expire on the same budget.
 */
export const CONE_SUDO_TIMEOUT_MS = 5 * 60 * 1000;

/** Snapshot of a single pending request (read-only view for listing surfaces). */
export interface PendingSudoRequest {
  id: string;
  scoopJid: string;
  request: SudoRequest;
}

/**
 * Why the registry settled a request fail-closed WITHOUT a cone decision.
 * Surfaced to the owner (the {@link ScoopApprovalRouter}) so it can flip the
 * persisted lick card off `pending`:
 *   - `expired`      — the per-request fail-closed timer fired.
 *   - `scoop-dropped`— the requesting scoop was unregistered.
 *   - `shutdown`     — the orchestrator drained everything on shutdown.
 */
export type SudoSettleReason = 'expired' | 'scoop-dropped' | 'shutdown';

/**
 * Trusted-realm seam between {@link createConeApprovalBroker} and whatever
 * owns the cone-side delivery + resolution (the {@link Orchestrator}, or a
 * fake in tests). A scoop's `requestApproval` becomes
 * `enqueueSudoRequest(scoopJid, request)`; the implementation generates an
 * id, delivers a cone-facing message, and returns the pending promise.
 */
export interface ConeApprovalRouter {
  enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision>;
}

/**
 * Build the per-scoop {@link SudoBroker}. The scoop's gated FS / shell sees
 * a regular broker; under the hood every call routes through `router` so
 * the orchestrator can deliver it to the cone and resolve it asynchronously.
 */
export function createConeApprovalBroker(scoopJid: string, router: ConeApprovalRouter): SudoBroker {
  return {
    requestApproval(request: SudoRequest): Promise<SudoDecision> {
      return router.enqueueSudoRequest(scoopJid, request);
    },
  };
}

/** Constructor options for {@link ConeRequestRegistry}. */
export interface ConeRequestRegistryOptions {
  /**
   * Fail-closed timeout per request. Defaults to {@link CONE_SUDO_TIMEOUT_MS}.
   * Pass `0` / a negative value / `Infinity` to disable the timer entirely
   * (used by tests that drive resolution manually).
   */
  timeoutMs?: number;
  /** ID generator. Defaults to a `lick-<timestamp-ms>-<rand>` string. Override in tests. */
  newId?: () => string;
  /** Timer factory. Defaults to `setTimeout`. Override in tests. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Timer canceller. Defaults to `clearTimeout`. Override in tests. */
  clearTimer?: (handle: unknown) => void;
  /**
   * Notified whenever a request is settled fail-closed WITHOUT a cone
   * decision — timeout, scoop drop, or shutdown. The owner uses it to flip
   * the persisted lick card off `pending`. Never fired for a normal
   * {@link ConeRequestRegistry.resolve} (the cone already knows). Best-effort:
   * any error thrown by the callback is swallowed so it can't wedge teardown.
   */
  onAutoSettle?: (id: string, reason: SudoSettleReason) => void;
}

interface RegistryEntry {
  scoopJid: string;
  request: SudoRequest;
  resolve: (decision: SudoDecision) => void;
  timerHandle: unknown;
}

function defaultId(): string {
  return `lick-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-memory pending-request store. The orchestrator owns one instance and
 * exposes:
 *   - `register(scoopJid, request)` — called from `enqueueSudoRequest` AFTER
 *     the cone-delivery side-effects (so a delivery failure can call
 *     `resolve(id, deny)` to keep the scoop from hanging).
 *   - `resolve(id, decision)` — called by the cone-side `lick_confirm` tool
 *     (or its replacement in tests).
 *   - `failScoop(scoopJid)` — called from `unregisterScoop` to fail-closed
 *     every request a dropped scoop had in flight.
 *   - `failAll()` — called from `shutdown` for the same reason.
 *
 * The registry stays purely synchronous so timer / id / clock can be
 * injected (see {@link ConeRequestRegistryOptions}).
 */
export class ConeRequestRegistry {
  private pending: Map<string, RegistryEntry> = new Map();
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onAutoSettle: (id: string, reason: SudoSettleReason) => void;

  constructor(opts: ConeRequestRegistryOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? CONE_SUDO_TIMEOUT_MS;
    this.newId = opts.newId ?? defaultId;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onAutoSettle = opts.onAutoSettle ?? (() => {});
  }

  /** Fire the auto-settle hook, isolating a throwing callback from teardown. */
  private notifyAutoSettle(id: string, reason: SudoSettleReason): void {
    try {
      this.onAutoSettle(id, reason);
    } catch {
      // Best-effort: a broken card-flip must never wedge timeout / drop / shutdown.
    }
  }

  /**
   * Register a new request and return its id alongside a promise that
   * resolves when {@link resolve} is called for that id (or the timer
   * fires fail-closed). The caller is expected to deliver the request
   * to the cone AFTER this returns and to fail-closed via
   * `resolve(id, { decision: 'deny' })` on any delivery error.
   */
  register(scoopJid: string, request: SudoRequest): { id: string; pending: Promise<SudoDecision> } {
    const id = this.newId();
    const pending = new Promise<SudoDecision>((resolve) => {
      let timerHandle: unknown = null;
      if (Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
        timerHandle = this.setTimer(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          // `cone-timeout` (not `user-timeout`): no human was ever prompted on
          // this leg, so the scoop's gate must not tell it to wait for the
          // user — the cone is the approver that never answered.
          entry.resolve(timedOutDecision('cone-timeout'));
          this.notifyAutoSettle(id, 'expired');
        }, this.timeoutMs);
      }
      this.pending.set(id, { scoopJid, request, resolve, timerHandle });
    });
    return { id, pending };
  }

  /**
   * Resolve a pending request. Returns `true` if a pending entry was
   * actually settled, `false` for an unknown / already-settled id —
   * callers can surface that to the cone as "this request expired".
   */
  resolve(id: string, decision: SudoDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (entry.timerHandle != null) this.clearTimer(entry.timerHandle);
    entry.resolve(decision);
    return true;
  }

  /**
   * Fail-closed every pending request for the given scoop. Returns the
   * number of requests that were resolved. Used by `unregisterScoop` so
   * a dropped scoop's outstanding sudo calls don't dangle.
   */
  failScoop(scoopJid: string): number {
    let count = 0;
    for (const [id, entry] of this.pending) {
      if (entry.scoopJid !== scoopJid) continue;
      this.pending.delete(id);
      if (entry.timerHandle != null) this.clearTimer(entry.timerHandle);
      entry.resolve({ decision: 'deny' });
      this.notifyAutoSettle(id, 'scoop-dropped');
      count++;
    }
    return count;
  }

  /** Fail-closed every pending request. Used by `Orchestrator.shutdown`. */
  failAll(): number {
    let count = 0;
    for (const [id, entry] of this.pending) {
      if (entry.timerHandle != null) this.clearTimer(entry.timerHandle);
      entry.resolve({ decision: 'deny' });
      this.notifyAutoSettle(id, 'shutdown');
      count++;
    }
    this.pending.clear();
    return count;
  }

  /** Snapshot a single pending request, or `null` when the id is unknown. */
  get(id: string): PendingSudoRequest | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    return { id, scoopJid: entry.scoopJid, request: entry.request };
  }

  /** Snapshot all pending requests (insertion order). Listing surface for the cone. */
  list(): PendingSudoRequest[] {
    const out: PendingSudoRequest[] = [];
    for (const [id, entry] of this.pending) {
      out.push({ id, scoopJid: entry.scoopJid, request: entry.request });
    }
    return out;
  }

  /** Number of pending requests. */
  size(): number {
    return this.pending.size;
  }
}
