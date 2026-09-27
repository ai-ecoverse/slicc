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
  if (!init.syncSab || !canWaitAtomically()) return undefined;
  return createSyncSabTransport(init.syncSab, port);
}

function canWaitAtomically(): boolean {
  return typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function';
}

export function hasSyncFsBridge(init: RealmInitMsg): boolean {
  return Boolean(init.syncFsToken) || (Boolean(init.syncSab) && canWaitAtomically());
}

export function resolveSyncFsBridge(
  init: RealmInitMsg,
  sab: SyncSabTransport | undefined
): SyncFsPosixBridge | undefined {
  if (sab) return createSyncFsSabBridge(sab);
  return init.syncFsToken ? createSyncFsXhrBridge(init.syncFsToken) : undefined;
}
