/**
 * LickbackRegistry — the substrate-owned ownership + buffering core of the
 * lick-back channel (the webapp's outbound event channel to an external brain).
 *
 * N orchestrators can drive one substrate body, each with its own
 * `X-Slicc-Session`. A browser-originated event (a chat message, an `upgrade`
 * lick, …) must reach exactly ONE responder, so ownership is an atomic claim
 * the substrate owns rather than a check each orchestrator races independently:
 *
 *   - `claim` — first caller wins a channel; a different, non-expired session is
 *     rejected with the current owner; the owner (or an expired channel) renews.
 *   - `heartbeat` — the owner renews its lease without re-claiming.
 *   - `subscribe` — the owner attaches an SSE drain; buffered events flush in
 *     order, then live events deliver immediately. Holding the drain pins the
 *     lease open (a connected owner never times out).
 *   - `enqueue` — append a browser-originated event; delivered live to an
 *     attached drain, else buffered in a bounded queue (oldest dropped on
 *     overflow) until a drain reconnects or a new owner claims.
 *
 * GC is lazy + deterministic: a lease is only ever evaluated against the
 * injected `now()` clock at `claim` time (a dead owner frees the channel for
 * the next claimant). No timers — tests advance a fake clock.
 *
 * Parity: N/A — substrate is standalone-only; the extension float has no
 * node-server (spec §11).
 */
// tva

/** Result of an atomic channel claim. */
export type ClaimResult =
  | { ok: true; owner: string; leaseMs: number }
  | { ok: false; owner: string };

/** Result of an SSE-drain subscription attempt. `owner` is `null` when the
 *  channel was never claimed. */
export type SubscribeResult =
  | { ok: true; unsubscribe: () => void }
  | { ok: false; owner: string | null };

export interface LickbackRegistryOptions {
  /** Injected clock for lease/GC math. Defaults to `Date.now`. */
  now?: () => number;
  /** Idle window before a non-draining owner can be displaced. Default 45s. */
  leaseMs?: number;
  /** Max buffered events per channel before the oldest is dropped. Default 100. */
  queueMax?: number;
  /** Called with each event dropped on bounded-queue overflow (default: warn). */
  onDrop?: (channel: string, event: unknown) => void;
}

export interface LickbackRegistry {
  /** Atomically claim a channel. First caller (or the owner / an expired
   *  channel) wins; a different live owner rejects with its session. */
  claim(channel: string, session: string): ClaimResult;
  /** Renew the owner's lease. False for a non-owner or unclaimed channel. */
  heartbeat(channel: string, session: string): boolean;
  /** Whether `session` currently owns `channel`. */
  isOwner(channel: string, session: string): boolean;
  /** Append a browser-originated event (live to a drain, else bounded-buffer). */
  enqueue(channel: string, event: unknown): void;
  /** Attach an SSE drain for the owner; flushes the buffer then goes live. */
  subscribe(channel: string, session: string, onEvent: (event: unknown) => void): SubscribeResult;
}

interface ChannelState {
  owner: string | null;
  /** `now()` at the last claim / heartbeat / drain disconnect. */
  lastActivity: number;
  /** True while an SSE drain is attached — pins the lease open. */
  draining: boolean;
  subscriber: ((event: unknown) => void) | null;
  queue: unknown[];
}

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_QUEUE_MAX = 100;

export function createLickbackRegistry(options: LickbackRegistryOptions = {}): LickbackRegistry {
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const queueMax = options.queueMax ?? DEFAULT_QUEUE_MAX;
  const onDrop =
    options.onDrop ??
    ((channel: string) => {
      console.warn(`[lickback] channel "${channel}" queue overflow — dropped oldest event`);
    });
  const channels = new Map<string, ChannelState>();

  function getOrCreate(channel: string): ChannelState {
    let st = channels.get(channel);
    if (!st) {
      st = { owner: null, lastActivity: 0, draining: false, subscriber: null, queue: [] };
      channels.set(channel, st);
    }
    return st;
  }

  /** A channel is reclaimable when unowned, or when its owner has been idle
   *  for >= leaseMs AND no drain is currently held. */
  function isExpired(st: ChannelState): boolean {
    if (st.owner === null) return true;
    if (st.draining) return false;
    return now() - st.lastActivity >= leaseMs;
  }

  function claim(channel: string, session: string): ClaimResult {
    const st = getOrCreate(channel);
    if (st.owner === session) {
      st.lastActivity = now();
      return { ok: true, owner: session, leaseMs };
    }
    if (st.owner === null || isExpired(st)) {
      // First claim, or a takeover of an expired owner. A stale subscriber from
      // the prior owner is dropped defensively — its SSE socket must never see
      // this channel's events once a new session owns it. (Queued events are
      // intentionally preserved so the new owner drains the backlog.)
      st.owner = session;
      st.lastActivity = now();
      st.draining = false;
      st.subscriber = null;
      return { ok: true, owner: session, leaseMs };
    }
    return { ok: false, owner: st.owner };
  }

  function heartbeat(channel: string, session: string): boolean {
    const st = channels.get(channel);
    if (!st || st.owner !== session) return false;
    st.lastActivity = now();
    return true;
  }

  function isOwner(channel: string, session: string): boolean {
    return channels.get(channel)?.owner === session;
  }

  function enqueue(channel: string, event: unknown): void {
    const st = getOrCreate(channel);
    if (st.subscriber) {
      st.subscriber(event);
      return;
    }
    st.queue.push(event);
    while (st.queue.length > queueMax) {
      const dropped = st.queue.shift();
      onDrop(channel, dropped);
    }
  }

  function subscribe(
    channel: string,
    session: string,
    onEvent: (event: unknown) => void
  ): SubscribeResult {
    const st = getOrCreate(channel);
    if (st.owner !== session) {
      return { ok: false, owner: st.owner };
    }
    // Flush the buffered backlog in order BEFORE attaching for live delivery,
    // so a reconnecting owner gets everything it missed exactly once.
    st.draining = true;
    st.lastActivity = now();
    const buffered = st.queue;
    st.queue = [];
    for (const e of buffered) onEvent(e);
    st.subscriber = onEvent;

    let active = true;
    return {
      ok: true,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        // Only clear if still ours — a later subscriber may have replaced us.
        if (st.subscriber === onEvent) st.subscriber = null;
        st.draining = false;
        // The lease starts ticking from the disconnect moment.
        st.lastActivity = now();
      },
    };
  }

  return { claim, heartbeat, isOwner, enqueue, subscribe };
}
