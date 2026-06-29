// tva
/**
 * Federated target listing — local CDP tabs plus the tray fleet (followers).
 *
 * The worker-side `BrowserAPI.listAllTargets()` returns local tabs only: its
 * tray provider is the panel-RPC *driving* provider whose `getTargets()` is
 * empty by design (see `cdp/panel-rpc-tray-provider.ts`). The follower fleet is
 * reachable only through the page-side `BrowserAPI` (which owns the tray sync),
 * so listing supplements the local set with a `list-remote-targets` panel-RPC
 * round-trip and dedupes by `targetId`.
 *
 * The single raw listing both target consumers build on: the `playwright
 * tab-list` command (`getActionablePages`) and the cup `/api/targets` bridge
 * handler (`shell-bridge-handler`). They are NOT identical sets — `tab-list`
 * additionally post-filters to actionable pages (dropping the app tab +
 * chrome-internal targets via `isActionablePage`), whereas `/api/targets`
 * returns this listing unfiltered (the cup SKILL.md warns the brain to skip the
 * `?cup=1` app tab itself). `getPanelRpc` is injected rather than imported so
 * this scoops-layer module keeps only a type-level dependency on the kernel.
 *
 * No DOM APIs — safe in the kernel worker context.
 */

import type { BrowserAPI, PageInfo } from '../cdp/index.js';
import { createLogger } from '../core/logger.js';
import type { PanelRpcClient } from '../kernel/panel-rpc.js';
import { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY } from './tray-runtime-config.js';

const log = createLogger('federated-targets');

/**
 * Cheap, synchronous check for whether a multi-browser tray is configured
 * (leader worker URL or follower join URL present). Reads `globalThis.localStorage`
 * — the real Storage on the page, or the page-seeded shim in the kernel worker.
 * Used to skip the `list-remote-targets` panel-RPC round-trip entirely when no
 * tray exists, so plain (non-tray) callers stay at one local call.
 */
export function isTrayConfigured(): boolean {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    return !!(ls.getItem(TRAY_WORKER_STORAGE_KEY) || ls.getItem(TRAY_JOIN_STORAGE_KEY));
  } catch {
    return false;
  }
}

/**
 * Extract the runtime id from a target id. Remote/federated targets use the
 * composite `"{runtimeId}:{localTargetId}"` format; a local target has no colon
 * and belongs to the local runtime (`null`).
 */
export function runtimeIdFromTargetId(targetId: string): string | null {
  const idx = targetId.indexOf(':');
  return idx === -1 ? null : targetId.slice(0, idx);
}

/**
 * List all browser targets — local CDP tabs plus the federated tray fleet.
 *
 * Local targets come from `listAllTargets()`; follower targets are supplemented
 * via a tray-gated `list-remote-targets` panel-RPC round-trip and deduped by
 * `targetId`. A failed or absent supplement degrades to the local set rather
 * than failing the whole listing.
 */
export async function listFederatedTargets(
  browser: BrowserAPI,
  getPanelRpc: () => PanelRpcClient | null
): Promise<PageInfo[]> {
  let pages: PageInfo[];
  if (typeof browser.listAllTargets === 'function') {
    pages = await browser.listAllTargets();
    const rpc = isTrayConfigured() ? getPanelRpc() : null;
    if (rpc) {
      try {
        const { targets } = await rpc.call('list-remote-targets', undefined, { timeoutMs: 3000 });
        const seen = new Set(pages.map((p) => p.targetId));
        for (const t of targets) {
          if (!seen.has(t.targetId)) {
            seen.add(t.targetId);
            pages.push({ targetId: t.targetId, title: t.title, url: t.url });
          }
        }
      } catch (err) {
        log.debug('panel-rpc list-remote-targets failed', { err: String(err) });
      }
    }
  } else {
    pages = await browser.listPages();
  }
  return pages;
}
