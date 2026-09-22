/**
 * Transport selection for a realm's synchronous bridges, shared by the JS
 * realm (`js-realm-shared.ts`) and the Pyodide realm (`py-realm-shared.ts`).
 * Both carry the same per-realm token and optional SharedArrayBuffer in their
 * `RealmInitMsg`, so the choice of fast path vs. baseline lives in one place.
 */

import type { RealmPortLike } from './realm-rpc.js';
import type { RealmInitMsg } from './realm-types.js';
import { createSyncFsXhrBridge, type SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SyncSabTransport,
} from './sync-sab-bridge.js';

/**
 * The Atomics/SAB transport (#2043) when the host handed us a shared buffer —
 * only ever on a cross-origin-isolated leader for a realm on its own thread
 * (`Realm.isolatedThread`); `Atomics.wait` is otherwise unavailable or a
 * deadlock. The SW sync-XHR path stays the universal baseline.
 */
export function resolveSyncSabTransport(
  init: RealmInitMsg,
  port: RealmPortLike
): SyncSabTransport | undefined {
  if (!init.syncSab || typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') {
    return undefined;
  }
  return createSyncSabTransport(init.syncSab, port);
}

/**
 * Build the realm's synchronous-fs bridge: the SAB transport when present,
 * else the SW route bound to the init token. Absent (default / in-process
 * tests / boot-before-control) → `undefined`.
 */
export function resolveSyncFsBridge(
  init: RealmInitMsg,
  sab: SyncSabTransport | undefined
): SyncFsPosixBridge | undefined {
  if (sab) return createSyncFsSabBridge(sab);
  return init.syncFsToken ? createSyncFsXhrBridge(init.syncFsToken) : undefined;
}
