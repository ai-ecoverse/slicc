/**
 * `setup-standalone-host-ready.ts` — runs the `await hostReady` join,
 * disarms the migration splash on failure, requests state from the
 * worker, attaches the frozen-sessions sidebar to the now-live
 * `VfsRpcHost`, and installs the page→worker localStorage interceptor.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:318–352).
 * The ordering is load-bearing: `attachScoopsVfs()` MUST run after
 * `hostReady` (the worker's `VfsRpcHost` only starts listening at the
 * tail of `boot()`), and `setupStorageSync` MUST run after `hostReady`
 * so the worker's bridge is ready to receive `local-storage-*` messages.
 */

import type { OffscreenClient } from '../offscreen-client.js';
import { setupStorageSync } from './setup-storage-sync.js';
import type { BootStageLogger, FrozenSessionsHandle, StorageSyncHandle } from './types.js';

export interface StandaloneHostReadyDeps {
  client: OffscreenClient;
  hostReady: Promise<void>;
  disarmMigrationSplash(): void;
  frozenSessions: FrozenSessionsHandle;
  /** Page-level `localStorage` (injectable for tests). */
  localStorage: Storage;
  log: BootStageLogger;
}

export async function setupStandaloneHostReady(
  deps: StandaloneHostReadyDeps
): Promise<StorageSyncHandle> {
  const { client, hostReady, disarmMigrationSplash, frozenSessions, localStorage, log } = deps;
  try {
    await hostReady;
    log.info('Worker boot handshake complete');
  } catch (err) {
    log.error('Worker failed to signal ready', err);
    disarmMigrationSplash();
    throw err;
  }
  client.requestState();
  frozenSessions.attachScoopsVfs();
  return setupStorageSync({ client, localStorage });
}
