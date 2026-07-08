/**
 * Shared helper for joining a multi-browser tray as a follower — the
 * symmetric counterpart to `leaveTray` in `tray-leave.ts`.
 *
 * It reuses `resolveAmbientLeaveTrayTransport`: the `standalone-page`
 * wire kind it resolves is a generic transport to whichever runtime
 * owns the tray subsystem, not leave-specific. This helper dispatches
 * the JOIN variant on it:
 *
 *   - `standalone-page` — page UI dispatches `slicc:tray-join`, handled by `wc-tray.ts`.
 *
 * The standalone kernel-worker case is NOT handled here (the resolver
 * never returns `standalone-worker`): the worker has no ambient global
 * to reach, so `host join` routes through the panel-RPC `tray-join` op
 * instead (see `host-command.ts:buildDefaultJoiner`).
 *
 * Writing the panel's `localStorage` here mirrors `leaveTray`'s two-key
 * touch — the side panel reads `TRAY_JOIN_STORAGE_KEY` directly on boot, so
 * persisting it (plus the derived worker base) keeps a reload re-joining the
 * same tray rather than booting dormant.
 */

import { createLogger } from '../core/logger.js';
import { type LeaveTrayTransport, resolveAmbientLeaveTrayTransport } from './tray-leave.js';
import {
  parseTrayJoinUrlValue,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from './tray-runtime-config.js';

const log = createLogger('scoops.tray-join');

export interface JoinTrayOptions {
  requestId?: string;
}

export async function joinTray(
  joinUrl: string,
  opts: JoinTrayOptions = {},
  transport: LeaveTrayTransport = resolveAmbientLeaveTrayTransport()
): Promise<void> {
  if (transport.storage) {
    const parsed = parseTrayJoinUrlValue(joinUrl);
    try {
      transport.storage.setItem(TRAY_JOIN_STORAGE_KEY, parsed?.joinUrl ?? joinUrl);
      if (parsed) {
        transport.storage.setItem(TRAY_WORKER_STORAGE_KEY, parsed.workerBaseUrl);
      }
    } catch (err) {
      log.error('tray-join storage write failed', {
        requestId: opts.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!transport.wire) {
    throw new Error(
      'joinTray: no transport available — inject a panelRpcClient (worker) ' +
        'or run in a context with window'
    );
  }

  switch (transport.wire.kind) {
    case 'standalone-page':
      transport.wire.dispatchEvent(
        new CustomEvent('slicc:tray-join', {
          detail: { joinUrl, requestId: opts.requestId },
        })
      );
      return;
    case 'standalone-worker':
      throw new Error(
        'joinTray: standalone-worker transport must be driven via panel-RPC tray-join'
      );
  }
}
