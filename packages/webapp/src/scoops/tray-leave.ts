/**
 * Shared helper for leaving the multi-browser tray (or switching role
 * from follower to leader). Symmetric counterpart to the join flow.
 *
 * Two wire transports, exactly one is picked per call (encoded as a
 * discriminated `LeaveTrayWire` union so the resolver's choice is
 * type-honest, not a runtime if-ladder over an optional bag):
 *
 *   - `standalone-worker` — the standalone kernel-worker shell calls
 *     panel-RPC `tray-leave`; the page-side handler runs
 *     `performTrayLeave` against the live tray handles.
 *   - `standalone-page` — page UI (avatar popover) dispatches
 *     `slicc:tray-leave`, handled by `main.ts`.
 *
 * Writing the panel's `localStorage` from this helper is intentional:
 * the side panel reads `TRAY_JOIN_STORAGE_KEY` directly on boot
 * (`ui/main.ts` `onReady`) and would re-push the stale join URL on
 * next reload otherwise.
 */

import { createLogger } from '../core/logger.js';
import { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY } from './tray-runtime-config.js';

const log = createLogger('scoops.tray-leave');

export type TrayLeaveResult =
  | { kind: 'noop' }
  | { kind: 'left'; previousMode: 'leader' | 'follower' }
  | {
      kind: 'switched';
      previousMode: 'leader' | 'follower' | 'inactive';
      workerBaseUrl: string;
    };

export interface LeaveTrayOptions {
  workerBaseUrl?: string | null;
  requestId?: string;
}

export interface LeaveTrayStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LeaveTrayWire =
  | {
      kind: 'standalone-worker';
      panelRpcClient: {
        call(
          op: 'tray-leave',
          payload: { workerBaseUrl: string | null; requestId?: string }
        ): Promise<unknown>;
      };
    }
  | {
      kind: 'standalone-page';
      dispatchEvent: (event: Event) => boolean;
    };

export interface LeaveTrayTransport {
  wire: LeaveTrayWire | null;
  storage?: LeaveTrayStorage | null;
}

export function resolveAmbientLeaveTrayTransport(): LeaveTrayTransport {
  const ls = (globalThis as { localStorage?: LeaveTrayStorage }).localStorage;
  const storage: LeaveTrayStorage | null =
    ls && typeof ls.setItem === 'function' && typeof ls.removeItem === 'function' ? ls : null;

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    return {
      wire: {
        kind: 'standalone-page',
        dispatchEvent: (event) => window.dispatchEvent(event),
      },
      storage,
    };
  }

  return { wire: null, storage };
}

export async function leaveTray(
  opts: LeaveTrayOptions = {},
  transport: LeaveTrayTransport = resolveAmbientLeaveTrayTransport()
): Promise<void> {
  const workerBaseUrl = opts.workerBaseUrl ?? null;

  if (transport.storage) {
    try {
      transport.storage.removeItem(TRAY_JOIN_STORAGE_KEY);
      if (workerBaseUrl === null) {
        transport.storage.removeItem(TRAY_WORKER_STORAGE_KEY);
      } else {
        transport.storage.setItem(TRAY_WORKER_STORAGE_KEY, workerBaseUrl);
      }
    } catch (err) {
      log.error('tray-leave storage write failed', {
        workerBaseUrl,
        requestId: opts.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!transport.wire) {
    throw new Error(
      'leaveTray: no transport available — inject a panelRpcClient (worker) ' +
        'or run in a context with window'
    );
  }

  switch (transport.wire.kind) {
    case 'standalone-worker':
      await transport.wire.panelRpcClient.call('tray-leave', {
        workerBaseUrl,
        requestId: opts.requestId,
      });
      return;
    case 'standalone-page':
      transport.wire.dispatchEvent(
        new CustomEvent('slicc:tray-leave', {
          detail: { workerBaseUrl, requestId: opts.requestId },
        })
      );
      return;
  }
}
