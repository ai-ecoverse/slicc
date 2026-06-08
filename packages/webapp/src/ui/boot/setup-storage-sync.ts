/**
 * `setup-storage-sync.ts` — boot stage that installs the page→worker
 * `localStorage` interceptor and pushes a fresh snapshot of the current
 * `localStorage` so writes that landed between
 * `collectLocalStorageSeed()` (inside `spawnKernelWorker`) and this
 * point are not lost.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:2516–2533).
 * Behavior is unchanged — the interceptor must be installed
 * immediately after `await host.ready` so the window between the seed
 * snapshot and the interceptor install stays closed; the seed-snapshot
 * push that follows is idempotent (the worker's shim just overwrites
 * each key with the same or newer value).
 */

import { installPageStorageSync } from '../../kernel/page-storage-sync.js';
import type { StorageSyncHandle, StorageSyncSetupDeps } from './types.js';

/**
 * Keys that are unforwardable to the worker's `localStorage` shim:
 *   - `setItem`/`removeItem`/`clear` — junk written by a previous
 *     broken interceptor (`Object.defineProperty` on a `Storage`
 *     instance).
 *   - keys containing NUL — `installPageStorageSync` drops them too;
 *     sending them from the seed-snapshot push would create a
 *     diverged view in the worker's shim.
 */
const STORAGE_SKIP = new Set(['setItem', 'removeItem', 'clear']);

/**
 * Install the page→worker `localStorage` interceptor and push the
 * current `localStorage` snapshot to the worker. Returns a
 * `stopStorageSync()` cleanup hook the orchestrator wires into
 * `beforeunload`.
 */
export function setupStorageSync(deps: StorageSyncSetupDeps): StorageSyncHandle {
  const { client, localStorage: ls } = deps;
  const stopStorageSync = installPageStorageSync({
    send: (msg) => client.sendRaw(msg),
  });
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k !== null && !STORAGE_SKIP.has(k) && !k.includes('\0')) {
      const v = ls.getItem(k);
      if (v !== null) {
        client.sendRaw({ type: 'local-storage-set', key: k, value: v });
      }
    }
  }
  return { stopStorageSync };
}
