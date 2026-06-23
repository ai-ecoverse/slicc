/**
 * Shared helper for joining a multi-browser tray as a follower — the
 * symmetric counterpart to `leaveTray` in `tray-leave.ts`.
 *
 * It reuses `resolveAmbientLeaveTrayTransport`: the wire kinds it
 * resolves (`offscreen-hook` / `extension-panel` / `standalone-page`)
 * are generic transports to whichever runtime owns the tray subsystem,
 * not leave-specific. This helper just dispatches the JOIN variant on
 * each:
 *
 *   - `offscreen-hook`  — extension offscreen drives `__slicc_setTrayRuntime(joinUrl, null)`.
 *   - `extension-panel` — side panel posts `refresh-tray-runtime` with the joinUrl.
 *   - `standalone-page` — page UI dispatches `slicc:tray-join`, handled by `wc-tray.ts`.
 *
 * The standalone kernel-worker case is NOT handled here (the resolver
 * never returns `standalone-worker`): the worker has no ambient global
 * to reach, so `host join` routes through the panel-RPC `tray-join` op
 * instead (see `host-command.ts:buildDefaultJoiner`).
 *
 * Writing the panel's `localStorage` here mirrors `leaveTray` — the side
 * panel reads `TRAY_JOIN_STORAGE_KEY` directly on boot, so persisting it
 * keeps a reload re-joining the same tray rather than booting dormant.
 */

import { createLogger } from '../core/logger.js';
import { type LeaveTrayTransport, resolveAmbientLeaveTrayTransport } from './tray-leave.js';
import { TRAY_JOIN_STORAGE_KEY } from './tray-runtime-config.js';

const log = createLogger('scoops.tray-join');

export interface JoinTrayOptions {
  /**
   * Optional correlation id forwarded into the `slicc:tray-join` event
   * detail so page / worker / shell log entries for one join attempt can
   * be matched up. Mirrors `LeaveTrayOptions.requestId`.
   */
  requestId?: string;
}

/**
 * Start following the tray identified by `joinUrl` on whichever runtime
 * we currently sit in. Returns once the local update has been issued; in
 * the asynchronous transports (extension panel relay, page event) the
 * WebRTC handshake completes a tick later — callers read connection state
 * from follower status snapshots, not from this function's return.
 *
 * Throws when no transport is available — used by `host join` running in
 * the worker context to signal "route through panel-RPC instead".
 */
export async function joinTray(
  joinUrl: string,
  opts: JoinTrayOptions = {},
  transport: LeaveTrayTransport = resolveAmbientLeaveTrayTransport()
): Promise<void> {
  // Storage mirror — keep panel boot config aligned so a reload re-joins.
  // Wrapped because sandboxed contexts can refuse storage writes; the wire
  // dispatch below is authoritative.
  if (transport.storage) {
    try {
      transport.storage.setItem(TRAY_JOIN_STORAGE_KEY, joinUrl);
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
        'or run in a context with chrome.runtime or window'
    );
  }

  switch (transport.wire.kind) {
    case 'offscreen-hook':
      await transport.wire.setTrayRuntime(joinUrl, null);
      return;
    case 'extension-panel':
      await transport.wire.sendMessage({
        source: 'panel' as const,
        payload: {
          type: 'refresh-tray-runtime' as const,
          joinUrl,
          workerBaseUrl: null,
        },
      });
      return;
    case 'standalone-page':
      transport.wire.dispatchEvent(
        new CustomEvent('slicc:tray-join', {
          detail: { joinUrl, requestId: opts.requestId },
        })
      );
      return;
    case 'standalone-worker':
      // The ambient resolver never returns this kind — worker callers
      // inject a panelRpcClient and drive the `tray-join` op themselves.
      // Guard for exhaustiveness so a new wire kind forces a decision.
      throw new Error(
        'joinTray: standalone-worker transport must be driven via panel-RPC tray-join'
      );
  }
}
