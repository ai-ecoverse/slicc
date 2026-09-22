import type { RealmPortLike } from './realm-rpc.js';
import type { RealmInitMsg } from './realm-types.js';
import { createSyncFsXhrBridge, type SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SyncSabTransport,
} from './sync-sab-bridge.js';

export function resolveSyncSabTransport(
  init: RealmInitMsg,
  port: RealmPortLike
): SyncSabTransport | undefined {
  if (!init.syncSab || typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') {
    return undefined;
  }
  return createSyncSabTransport(init.syncSab, port);
}

export function resolveSyncFsBridge(
  init: RealmInitMsg,
  sab: SyncSabTransport | undefined
): SyncFsPosixBridge | undefined {
  if (sab) return createSyncFsSabBridge(sab);
  return init.syncFsToken ? createSyncFsXhrBridge(init.syncFsToken) : undefined;
}
