/**
 * Zero-dependency panel-RPC realm probes. They live in `base/` so `fs/` (and
 * anything else below `kernel/`) can pick between local-DOM and bridged
 * execution without value-importing `kernel/panel-rpc.ts` (#3728).
 * `kernel/panel-rpc.ts` re-exports both, so existing callers keep their
 * import path.
 */

import type { PanelRpcClient } from '../kernel/panel-rpc.js';

/**
 * Returns the bridge client published on `globalThis.__slicc_panelRpc`
 * by `kernel-worker.ts`, or null when none is published. Null is NOT a
 * realm signal: page realms never publish one, but a worker also returns
 * null before (or without) publication. Pair with `hasLocalDom()` to pick
 * local-DOM execution, and treat "no DOM and no client" as unavailable.
 */
export function getPanelRpcClient(): PanelRpcClient | null {
  const g = globalThis as unknown as { __slicc_panelRpc?: PanelRpcClient };
  return g.__slicc_panelRpc ?? null;
}

/**
 * `true` when the current realm has a real DOM. False inside a
 * DedicatedWorker, irrespective of whether the bridge client is
 * published.
 */
export function hasLocalDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
