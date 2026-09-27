import { raceAbort, throwIfAborted } from './command-abort.js';

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

interface BridgeHold {
  release: () => void;
  owner: symbol;
  targetId: string | null;
}

export interface TabLockStats {
  queueDepth: number;

  totalWaitMs: number;

  tabWaitMs: number;

  bridgeWaitMs: number;
  acquisitions: number;
}

export interface TabLockCounters {
  queueDepth: number;
  tabWaitMs: number;
  bridgeWaitMs: number;
  acquisitions: number;
}

export class TabLockManager {
  private readonly tabLocks = new Map<string, Promise<void>>();

  private bridgeLock: Promise<void> = Promise.resolve();

  private bridgeHold: BridgeHold | null = null;

  private bridgeWaiters = 0;
  private readonly tabLockStats = new Map<string, TabLockCounters>();

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

  liveOwner(): symbol | undefined {
    return this.bridgeHold?.owner;
  }

  reentrantOwner(targetId: string | null): symbol | undefined {
    const hold = this.bridgeHold;
    if (!hold || targetId === null || hold.targetId !== targetId) return undefined;
    return hold.owner;
  }

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
      if (this.tabLocks.get(targetId) === next) this.tabLocks.delete(targetId);
      release();
    };
    if (prev) {
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

  async acquireBridgeLock(opts?: {
    owner?: symbol | undefined;

    targetId?: string | null;
    counters?: TabLockCounters;
  }): Promise<() => void> {
    if (opts?.owner !== undefined && this.bridgeHold?.owner === opts.owner) {
      return () => undefined;
    }
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.bridgeLock;
    const contended = this.bridgeHold !== null || this.bridgeWaiters > 0;
    this.bridgeLock = next;
    if (contended) {
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

      if (this.bridgeHold === hold) this.bridgeHold = null;
      release();
    };
  }

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
