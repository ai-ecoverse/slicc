/**
 * `py-realm-pool.ts` — a pool of warm, reusable Pyodide realms.
 *
 * Replaces the one-shot "spawn a DedicatedWorker per `python`
 * invocation, then `worker.terminate()`" model: the interpreter and
 * its FS survive between runs, so only the first call pays the
 * ~1-2 s `loadPyodide` cold boot. Defaults: keep 1 warm idle worker,
 * scale to 2 in parallel, queue (FIFO) beyond that.
 *
 * The pool is signal-agnostic — the runner (`runInPooledRealm`)
 * owns the pid↔lease mapping and calls `lease.evict()` on SIGKILL /
 * error. `evict()` terminates the worker and (if callers are waiting)
 * lazily creates a replacement; `release()` returns the worker idle
 * for reuse, applying the warm-idle / idle-TTL policy.
 */

import type { CommandContext } from 'just-bash';
import type { Realm, RealmFactory, RealmLease, RealmPool } from './realm-runner.js';

export interface PyRealmPoolOptions {
  factory: RealmFactory;
  /** Idle workers kept warm indefinitely. Default 1. */
  warmIdle?: number;
  /** Max workers checked out + creating at once. Default 2. */
  maxConcurrent?: number;
  /** Idle TTL (ms) for workers beyond `warmIdle`. Default 30 s; 0 disables. */
  idleTtlMs?: number;
}

interface PooledWorker {
  realm: Realm;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  ctx: CommandContext;
  resolve(lease: RealmLease): void;
  reject(err: Error): void;
}

class PyRealmPool implements RealmPool {
  private readonly factory: RealmFactory;
  private readonly warmIdle: number;
  private readonly maxConcurrent: number;
  private readonly idleTtlMs: number;
  private readonly idle: PooledWorker[] = [];
  private readonly busy = new Set<PooledWorker>();
  private readonly waiters: Waiter[] = [];
  private creating = 0;
  private disposed = false;

  constructor(opts: PyRealmPoolOptions) {
    this.factory = opts.factory;
    this.warmIdle = opts.warmIdle ?? 1;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.idleTtlMs = opts.idleTtlMs ?? 30_000;
  }

  checkout(ctx: CommandContext): Promise<RealmLease> {
    if (this.disposed) return Promise.reject(new Error('realm pool disposed'));
    return new Promise<RealmLease>((resolve, reject) => {
      this.waiters.push({ ctx, resolve, reject });
      this.pump();
    });
  }

  stats(): { idle: number; busy: number; waiting: number; creating: number } {
    return {
      idle: this.idle.length,
      busy: this.busy.size,
      waiting: this.waiters.length,
      creating: this.creating,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.idle) this.terminate(w);
    this.idle.length = 0;
    for (const w of this.busy) this.terminate(w);
    this.busy.clear();
    const err = new Error('realm pool disposed');
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }

  /** Satisfy waiters from the idle pool, then create up to capacity. */
  private pump(): void {
    if (this.disposed) return;
    while (this.waiters.length > 0 && this.idle.length > 0) {
      const worker = this.idle.shift()!;
      this.clearTimer(worker);
      this.busy.add(worker);
      this.waiters.shift()!.resolve(this.lease(worker));
    }
    while (
      this.waiters.length > this.creating &&
      this.busy.size + this.creating < this.maxConcurrent
    ) {
      const waiter = this.waiters.shift()!;
      this.creating++;
      this.factory({ kind: 'py', ctx: waiter.ctx }).then(
        (realm) => {
          this.creating--;
          if (this.disposed) {
            this.terminateRealm(realm);
            waiter.reject(new Error('realm pool disposed'));
            return;
          }
          const worker: PooledWorker = { realm };
          this.busy.add(worker);
          waiter.resolve(this.lease(worker));
        },
        (err: unknown) => {
          this.creating--;
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
          this.pump();
        }
      );
    }
  }

  private lease(worker: PooledWorker): RealmLease {
    let done = false;
    return {
      realm: worker.realm,
      release: () => {
        if (done) return;
        done = true;
        this.onRelease(worker);
      },
      evict: () => {
        if (done) return;
        done = true;
        this.onEvict(worker);
      },
    };
  }

  private onRelease(worker: PooledWorker): void {
    this.busy.delete(worker);
    if (this.disposed) {
      this.terminate(worker);
      return;
    }
    this.idle.push(worker);
    this.rebalanceIdle();
    this.pump();
  }

  private onEvict(worker: PooledWorker): void {
    this.busy.delete(worker);
    this.terminate(worker);
    // Lazy replacement: pump() creates a fresh worker for any waiter
    // now that a concurrency slot has freed up.
    if (!this.disposed) this.pump();
  }

  /** Keep `warmIdle` workers timer-free; expire the rest after TTL. */
  private rebalanceIdle(): void {
    this.idle.forEach((worker, i) => {
      if (i < this.warmIdle || this.idleTtlMs <= 0) {
        this.clearTimer(worker);
        return;
      }
      if (worker.idleTimer) return;
      worker.idleTimer = setTimeout(() => this.dropIdle(worker), this.idleTtlMs);
      (worker.idleTimer as { unref?: () => void })?.unref?.();
    });
  }

  private dropIdle(worker: PooledWorker): void {
    const i = this.idle.indexOf(worker);
    if (i < 0) return;
    this.idle.splice(i, 1);
    this.terminate(worker);
  }

  private clearTimer(worker: PooledWorker): void {
    if (worker.idleTimer) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = undefined;
    }
  }

  private terminate(worker: PooledWorker): void {
    this.clearTimer(worker);
    this.terminateRealm(worker.realm);
  }

  private terminateRealm(realm: Realm): void {
    try {
      realm.terminate();
    } catch {
      /* idempotent on real workers / iframes */
    }
  }
}

/** Construct a warm Pyodide realm pool. */
export function createPyRealmPool(opts: PyRealmPoolOptions): PyRealmPool {
  return new PyRealmPool(opts);
}

export type { PyRealmPool };
