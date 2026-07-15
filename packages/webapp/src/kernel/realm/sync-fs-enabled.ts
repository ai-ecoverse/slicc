/**
 * Kernel-worker flag: is the synchronous-fs SW bridge enabled for realms?
 *
 * Set once at kernel-worker init (`kernel-worker.ts`) from
 * `KernelWorkerInitMsg.syncFsBridgeEnabled`, which the page (`main.ts`) sets
 * only after confirming a controlling Service Worker — a realm's sync XHR would
 * otherwise miss the SW and hit the network. Read by `jsh-executor` when
 * building `RunInRealmOptions`.
 *
 * Default `false` → realms keep the bounded in-memory snapshot (the pre-bridge
 * behavior). This is also what the in-process test factory sees (it never calls
 * the init path), so it must never drive a synchronous XHR (which would
 * deadlock on the kernel thread).
 */

let enabled = false;

export function setSyncFsBridgeEnabled(value: boolean): void {
  enabled = value;
}

export function isSyncFsBridgeEnabled(): boolean {
  return enabled;
}
