/**
 * Persisted "autodiscover agentic resources" setting (default ON).
 *
 * Gates the `discovery` lick pipeline — the `rel="ai-catalog"` header extractor
 * AND the `/.well-known/ai-catalog.json` + `/llms.txt` well-known probe — in
 * every float. The CLI / standalone / hosted-leader kernel worker reads it in
 * `kernel/host.ts` (`buildDiscoveryWatcherOptions().isDiscoveryEnabled`); the
 * extension service worker keeps its own copy in `chrome.storage.local`.
 *
 * Storage is `localStorage` (key `slicc_discovery_enabled`), the same
 * page↔worker-synced store the other boolean toggles use (`soundscape-enabled`,
 * `slicc_show_timestamps`). This module is imported by the kernel WORKER, so it
 * must stay DOM-free — only `localStorage` (worker shim) and a feature-detected
 * `chrome.runtime` are touched.
 *
 * Extension parity: the settings UI lives on the hosted leader tab, which writes
 * `localStorage`, but the extension's discovery observer runs in the service
 * worker and reads `chrome.storage.local`. `setDiscoveryEnabled` therefore also
 * fire-and-forget mirrors the value to the SW over the same externally-
 * connectable channel the bridge uses, so the toggle gates probing on the
 * extension float too.
 */

import { getExtensionDelegateId } from '../shell/proxied-fetch.js';

const STORAGE_KEY = 'slicc_discovery_enabled';

/** External message the SW's `onMessageExternal` handler recognises. */
export const DISCOVERY_SET_ENABLED_MESSAGE = 'discovery.set-enabled';

/**
 * Read the setting. Defaults to `true` (enabled) when unset or when storage is
 * unavailable — discovery is opt-out, not opt-in.
 */
export function getDiscoveryEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage?.getItem !== 'function')
      return true;
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Persist the setting and mirror it to the extension service worker. */
export function setDiscoveryEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage?.setItem === 'function')
      localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // No-op: in a realm without storage the in-memory default takes over.
  }
  mirrorToExtensionServiceWorker(enabled);
}

/**
 * Push the value to the extension SW (best-effort). No-op outside the extension
 * float or when the delegate id / `chrome.runtime.sendMessage` isn't available
 * — the CLI / standalone floats read `localStorage` directly and need no mirror.
 */
function mirrorToExtensionServiceWorker(enabled: boolean): void {
  try {
    const delegateId = getExtensionDelegateId();
    if (!delegateId) return;
    const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome
      ?.runtime;
    if (typeof runtime?.sendMessage !== 'function') return;
    (runtime.sendMessage as (id: string, message: unknown, cb?: () => void) => void)(
      delegateId,
      { type: DISCOVERY_SET_ENABLED_MESSAGE, enabled },
      () => {
        // Swallow chrome.runtime.lastError — the mirror is best-effort; the SW
        // falls back to its persisted value / ON default if this never lands.
        void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime
          ?.lastError;
      }
    );
  } catch {
    // Best-effort: a mirror failure must never break the settings write.
  }
}
