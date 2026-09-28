/**
 * Per-tab and bridge-wide locks that serialize CDP work.
 *
 * Extracted from {@link BrowserAPI} so the FIFO chains, re-entry tokens, and
 * contention counters can be reasoned about (and unit-tested) without the rest
 * of the bridge. Attach / session orchestration stays on BrowserAPI; this
 * module owns only the lock state and the grant/release paths.
 */

import { raceAbort, throwIfAborted } from './command-abort.js';

/** Freeze a mutable counter set into the public {@link TabLockStats} shape. */
function statsOf(counters: TabLockCounters | undefined): TabLockStats {
  const c = counters ?? { queueDepth: 0, tabWaitMs: 0, bridgeWaitMs: 0, acquisitions: 0 };
  return {
    queueDepth: c.queueDepth,
    totalWaitMs: c.tabWaitMs + c.bridgeWaitMs,
    tabWaitMs: c.tabWaitMs,
    bridgeWaitMs: c.bridgeWaitMs,
    acquisitions: c.acquisitions,
  };
}

/**
 * A live hold on the bridge-wide lock.
 *
 * `owner` is a private token minted when the hold is taken; presenting it is
 * the ONLY way to re-enter the lock (see {@link TabLockManager.acquireBridgeLock}).
 * `targetId` is the tab the hold is driving, which is how same-tab helpers
 * recover the token.
 */
interface BridgeHold {
  release: () => void;
  owner: symbol;
  targetId: string | null;
}

/** Per-tab and bridge-wide contention counters — see {@link TabLockManager.getStats}. */
export interface TabLockStats {
  queueDepth: number;
  /** All time spent queued: `tabWaitMs + bridgeWaitMs`. */
  totalWaitMs: number;
  /** Time spent waiting for THIS tab's own lock (a sibling driving the same tab). */
  tabWaitMs: number;
  /**
   * Time spent waiting for the bridge-wide lock — the few genuinely global
   * operations (attaching, `Page.bringToFront`), not another tab's command
   * body, which holds nothing bridge-wide.
   */
  bridgeWaitMs: number;
  acquisitions: number;
}

/** Mutable per-target accumulator behind {@link TabLockStats}. */
export interface TabLockCounters {
  queueDepth: number;
  tabWaitMs: number;
  bridgeWaitMs: number;
  acquisitions: number;
}

export class TabLockManager {
  /** Per-target lock chains — commands on different tabs no longer queue behind each other. */
  private readonly tabLocks = new Map<string, Promise<void>>();
  /** Bridge-wide lock chain; see {@link acquireBridgeLock}. */
  private bridgeLock: Promise<void> = Promise.resolve();
  /** Non-null while the bridge-wide lock is held. See {@link BridgeHold}. */
  private bridgeHold: BridgeHold | null = null;
  /** Callers queued for the bridge lock; with no hold either, it is free. */
  private bridgeWaiters = 0;
  private readonly tabLockStats = new Map<string, TabLockCounters>();

  /**
   * Contention metrics for the locks that serialize `withTab` work.
   *
   * Called with a `targetId` it reports that tab alone; called without one it
   * reports bridge-wide totals (the sum over tabs).
   */
  getStats(targetId?: string): TabLockStats {
    if (targetId !== undefined) return statsOf(this.tabLockStats.get(targetId));
    const total: TabLockCounters = {
      queueDepth: 0,
      tabWaitMs: 0,
      bridgeWaitMs: 0,
      acquisitions: 0,
    };
    for (const c of this.tabLockStats.values()) {
      total.queueDepth += c.queueDepth;
      total.tabWaitMs += c.tabWaitMs;
      total.bridgeWaitMs += c.bridgeWaitMs;
      total.acquisitions += c.acquisitions;
    }
    return statsOf(total);
  }

  countersFor(targetId: string): TabLockCounters {
    let counters = this.tabLockStats.get(targetId);
    if (!counters) {
      counters = { queueDepth: 0, tabWaitMs: 0, bridgeWaitMs: 0, acquisitions: 0 };
      this.tabLockStats.set(targetId, counters);
    }
    return counters;
  }

  /** Token of the live bridge hold, if any — used by wake/focus walks. */
  liveOwner(): symbol | undefined {
    return this.bridgeHold?.owner;
  }

  /**
   * The live hold's token, but ONLY when that hold is driving `targetId` —
   * i.e. the caller is running inside that tab's `withTab` body (or its
   * `attachToPage`). Anything else, including a UI timer that happens to fire
   * while a command holds the bridge, gets `undefined` and queues like any
   * other caller.
   */
  reentrantOwner(targetId: string | null): symbol | undefined {
    const hold = this.bridgeHold;
    if (!hold || targetId === null || hold.targetId !== targetId) return undefined;
    return hold.owner;
  }

  /**
   * Hold the per-tab lock for the duration of `body`, keeping queue-depth
   * bookkeeping correct on both the abort-before-grant and normal paths.
   * Session pin / attach / retry stay with the caller (BrowserAPI.withTab).
   */
  async holdTabLock<T>(
    targetId: string,
    signal: AbortSignal | undefined,
    body: (counters: TabLockCounters) => Promise<T>
  ): Promise<T> {
    throwIfAborted(signal, `starting a command on tab ${targetId}`);
    const counters = this.countersFor(targetId);
    counters.queueDepth += 1;
    let releaseTab: () => void;
    try {
      releaseTab = await this.acquireTabLock(targetId, counters, signal);
    } catch (err) {
      // Decremented here on the abort path: a caller that never got the lock
      // is no longer queued, and leaving it counted would inflate the
      // contention note every later command reads.
      counters.queueDepth -= 1;
      throw err;
    }
    try {
      return await body(counters);
    } finally {
      counters.queueDepth -= 1;
      releaseTab();
    }
  }

  /**
   * FIFO lock for one target; different targets never wait on each other.
   *
   * A tab with no chain entry has no predecessor, so it neither waits nor
   * records a wait. Awaiting an already-resolved promise still costs a
   * scheduler turn that `Date.now()` can round up to 1 ms, which turned an
   * uncontended tab into a "1 ms of contention" reading — enough to make the
   * accounting test flaky and enough to mislead the `playwright-cli`
   * contention note it feeds.
   *
   * A `signal` that fires while queued rejects this caller immediately, but
   * its slot in the chain is handed on only once the PREDECESSOR actually
   * finishes — releasing early would let the next caller drive the tab
   * alongside the one still holding it.
   */
  async acquireTabLock(
    targetId: string,
    counters: TabLockCounters,
    signal?: AbortSignal
  ): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.tabLocks.get(targetId);
    this.tabLocks.set(targetId, next);
    const drop = (): void => {
      // Drop the chain once nobody is queued behind us, so a long-lived
      // bridge does not keep a resolved promise per tab it ever touched.
      if (this.tabLocks.get(targetId) === next) this.tabLocks.delete(targetId);
      release();
    };
    if (prev != null) {
      const waitStart = Date.now();
      try {
        await raceAbort(prev, signal, `queued for the lock on tab ${targetId}`);
      } catch (err) {
        counters.tabWaitMs += Date.now() - waitStart;
        void prev.then(drop, drop);
        throw err;
      }
      counters.tabWaitMs += Date.now() - waitStart;
    }
    return drop;
  }

  /**
   * FIFO bridge-wide lock, held for the operations that touch state shared by
   * every tab: the most-recently-used session cursor and the local↔remote
   * transport swap, `Page.bringToFront`, and the screenshot wake-up fallback's
   * focus probe.
   *
   * Re-entry is by TOKEN, not by "a hold exists". `opts.owner` bypasses the
   * queue only when it is the token of the live hold.
   */
  async acquireBridgeLock(opts?: {
    /** Token of the live hold this caller is already running under. */
    owner?: symbol | undefined;
    /** The tab this hold drives; what {@link reentrantOwner} matches on. */
    targetId?: string | null;
    counters?: TabLockCounters;
  }): Promise<() => void> {
    if (opts?.owner !== undefined && this.bridgeHold?.owner === opts.owner) {
      return () => undefined; // our own hold
    }
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.bridgeLock;
    const contended = this.bridgeHold !== null || this.bridgeWaiters > 0;
    this.bridgeLock = next;
    if (contended) {
      // Nobody may be scheduled between the decrement and the hold below, so
      // "no hold and no waiter" is a reliable "the chain is already settled" —
      // which lets the uncontended path skip the await entirely. That keeps
      // taking this lock on the attach path free of an extra scheduler turn,
      // and keeps `bridgeWaitMs` from reporting the turn as contention.
      this.bridgeWaiters += 1;
      const waitStart = Date.now();
      try {
        await prev;
      } finally {
        this.bridgeWaiters -= 1;
      }
      if (opts?.counters) opts.counters.bridgeWaitMs += Date.now() - waitStart;
    }
    const hold: BridgeHold = {
      release,
      owner: Symbol('bridge-hold'),
      targetId: opts?.targetId ?? null,
    };
    this.bridgeHold = hold;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Holds never interleave — every one is taken and released inside a
      // single synchronous-ish global operation — so the live hold IS ours,
      // but check rather than assume.
      if (this.bridgeHold === hold) this.bridgeHold = null;
      release();
    };
  }

  /**
   * Run `fn` holding the bridge-wide lock, re-entering the caller's own hold
   * when it is already driving this tab. Reserved for browser-GLOBAL work:
   * `Page.bringToFront` steals window focus, so two tabs raising themselves
   * concurrently would fight.
   */
  async runGlobal<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireBridgeLock({
      owner: this.reentrantOwner(targetId),
      targetId,
    });
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
