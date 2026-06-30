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
 * handler (`shell-bridge-handler`). Both surface the SAME actionable set — they
 * share `filterActionableTargets` here, which drops the local SLICC app tab
 * (the `?cup=1` page) and chrome-internal UI targets while KEEPING follower
 * (federated) targets. `getPanelRpc` is injected rather than imported so this
 * scoops-layer module keeps only a type-level dependency on the kernel.
 *
 * No DOM APIs beyond a guarded `typeof window` origin fallback — safe in the
 * kernel worker context (where `window` is undefined and the panel-RPC
 * `page-info` round-trip resolves the origin instead).
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

/**
 * Resolve the origin where the SLICC webapp is served — used to locate the
 * local app tab among a target listing.
 *
 *   - Page context: `window.location.origin`.
 *   - Kernel worker: bridge to the page via panel-RPC `page-info` (the worker
 *     has no `window`). Without this the worker fell back to a hardcoded
 *     `http://localhost:5710`, silently breaking app-tab detection for any
 *     non-default port (e.g. parallel instances on `PORT=5720`).
 *   - Tests / Node fallback: the hardcoded default.
 *
 * Shared by `playwright tab-list` and the cup `/api/targets` bridge so both
 * identify the same app tab. `getPanelRpc` is injected (not imported) to keep
 * this module's kernel dependency type-level only.
 */
export async function resolveAppOrigin(getPanelRpc: () => PanelRpcClient | null): Promise<string> {
  if (typeof window !== 'undefined') return window.location.origin;
  const rpc = getPanelRpc();
  if (rpc) {
    try {
      const info = await rpc.call('page-info', undefined, { timeoutMs: 2000 });
      if (info.origin) return info.origin;
    } catch {
      // Fall through to the default rather than failing the whole listing.
    }
  }
  return 'http://localhost:5710';
}

/**
 * Chrome-internal / non-actionable UI target check — pure over `PageInfo`. The
 * omnibox popup, `chrome://`, `devtools://`, etc. are not drivable pages. Shared
 * by `playwright tab-list` and the cup `/api/targets` bridge so both surface the
 * same actionable set.
 */
export function isChromeInternalUiTarget(page: PageInfo): boolean {
  const url = page.url.trim();
  const title = page.title.trim();

  return (
    title === 'Omnibox Popup' ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-search://') ||
    url.startsWith('chrome-untrusted://') ||
    url.startsWith('devtools://') ||
    (url.length === 0 && /popup$/i.test(title))
  );
}

/**
 * Locate the local SLICC app tab in a target listing — the tab serving the
 * webapp itself (in cup mode the `?cup=1` page that hosts the kernel worker +
 * lick-back channel). Matched among LOCAL targets only (a composite/federated id
 * belongs to a follower and is never the app tab) by app-origin URL prefix,
 * excluding the local `/preview/*` service-worker pages. Returns its targetId,
 * or null when no app tab is present.
 */
export function findAppTabId(pages: PageInfo[], appOrigin: string): string | null {
  const appTab = pages.find(
    (p) =>
      runtimeIdFromTargetId(p.targetId) === null &&
      p.url.startsWith(appOrigin) &&
      !p.url.includes('/preview/')
  );
  return appTab ? appTab.targetId : null;
}

/**
 * Filter a federated target listing down to the actionable set: drop the local
 * SLICC app tab (`appTabId`, when present) and chrome-internal UI targets, while
 * KEEPING follower (federated) targets — the brain should drive those. This is
 * the parity primitive behind both `playwright tab-list` (`getActionablePages`)
 * and the cup `/api/targets` bridge handler.
 */
export function filterActionableTargets(pages: PageInfo[], appTabId: string | null): PageInfo[] {
  return pages.filter((p) => p.targetId !== appTabId && !isChromeInternalUiTarget(p));
}
