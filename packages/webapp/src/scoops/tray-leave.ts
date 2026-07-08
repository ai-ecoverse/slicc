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

/**
 * Result returned by the page-side leave executor (`performTrayLeave` in
 * `ui/tray-leave-runtime.ts`) and propagated over panel-RPC to the
 * worker-side `host leave` shell command.
 *
 * Discriminated by `kind` so the three semantically distinct outcomes
 * each have a fitting shape:
 *   - `noop`     — runtime was already dormant; nothing to leave from.
 *   - `left`     — stopped an active leader/follower; stayed dormant.
 *   - `switched` — stopped any active role and started a fresh leader
 *                  on `workerBaseUrl` (also covers role-create from
 *                  inactive, e.g. `host leave --leader <url>`).
 *
 * Crucially, the unreachable-but-otherwise-typeable `{ previousMode:
 * 'inactive', workerBaseUrl: null }` quadrant of a naive Cartesian
 * product is not representable. Each formatter narrows on `kind`.
 */
export type TrayLeaveResult =
  | { kind: 'noop' }
  | { kind: 'left'; previousMode: 'leader' | 'follower' }
  | {
      kind: 'switched';
      previousMode: 'leader' | 'follower' | 'inactive';
      workerBaseUrl: string;
    };

export interface LeaveTrayOptions {
  /**
   * When a non-empty string, switch into leader mode on this worker
   * after leaving. When `null` (default), leave entirely (clear both
   * storage keys, stop the runtime).
   */
  workerBaseUrl?: string | null;
  /**
   * Optional correlation id forwarded into the panel-RPC payload and
   * the `slicc:tray-leave` event detail. The page-side executor
   * includes it in failure log meta so the panel / worker / shell log
   * entries that share a leave attempt can be matched up.
   */
  requestId?: string;
}

/** A storage that can be written to keep panel + worker shim aligned. */
export interface LeaveTrayStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Exactly one of these is picked by the resolver. The discriminant
 * `kind` matches the two-transport list at the top of the file.
 */
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
  /**
   * The selected wire transport. `null` only when the resolver could
   * not find any usable transport in the ambient context — in that case
   * `leaveTray` throws (worker callers must inject `panelRpcClient`).
   */
  wire: LeaveTrayWire | null;
  /**
   * Optional storage mirror. Orthogonal to `wire`: writing storage and
   * dispatching the wire update are independent concerns (the storage
   * write keeps panel boot config aligned; the wire update is what
   * actually stops the runtime).
   */
  storage?: LeaveTrayStorage | null;
}

/**
 * Detect a transport from ambient globals: a page context (working
 * `window`) gets the `standalone-page` event dispatcher. Worker callers
 * (standalone kernel worker) must inject `panelRpcClient` explicitly via
 * the second argument of `leaveTray` — there is no ambient global the
 * worker can reach.
 */
export function resolveAmbientLeaveTrayTransport(): LeaveTrayTransport {
  // Panel/page localStorage write (best-effort). Worker contexts get a
  // Map-backed shim seeded by `installPageStorageSync` so writes still
  // mutate state that the page later observes.
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

/**
 * Drive a tray-leave (or follower → leader switch) on whichever runtime
 * we currently sit in. The wire transport is selected by the discriminated
 * `wire` field on `transport`. Returns once the local update has been
 * issued; in the asynchronous page-event transport the actual tray
 * teardown may complete a tick later — that is fine because every
 * consumer reads its state from post-leave status snapshots, not from
 * this function's return.
 *
 * Throws when no transport is available — used by `host leave` running
 * in the worker context to surface "inject a panelRpcClient".
 */
export async function leaveTray(
  opts: LeaveTrayOptions = {},
  transport: LeaveTrayTransport = resolveAmbientLeaveTrayTransport()
): Promise<void> {
  const workerBaseUrl = opts.workerBaseUrl ?? null;

  // Storage mirror — keep panel boot config aligned with the runtime's
  // view. Worker writes are mirrored to the page via `installPageStorageSync`
  // so a panel reload picks up the same view. Wrapped because sandboxed
  // contexts can refuse storage writes; the wire dispatch is authoritative.
  if (transport.storage) {
    try {
      transport.storage.removeItem(TRAY_JOIN_STORAGE_KEY);
      if (workerBaseUrl === null) {
        transport.storage.removeItem(TRAY_WORKER_STORAGE_KEY);
      } else {
        transport.storage.setItem(TRAY_WORKER_STORAGE_KEY, workerBaseUrl);
      }
    } catch (err) {
      // Sandboxed storage (incognito blocked, sandbox iframe, etc.).
      // The wire dispatch below is authoritative — the runtime will be
      // in the right state — but boot-time persistence is now out of
      // step with the wire and a reload will boot stale. Log so the
      // skew is at least auditable.
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
