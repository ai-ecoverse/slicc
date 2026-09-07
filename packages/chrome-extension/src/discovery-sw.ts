/**
 * Agentic-resource-discovery observer wiring — silent extension parity for the
 * `discovery` lick.
 *
 * Detects a bare `rel="ai-catalog"` `Link` header on main-frame document
 * responses and runs a throttled per-origin well-known probe
 * (`/.well-known/ai-catalog.json`, `/llms.txt`) via the SW's own fetch
 * (host_permissions bypass CORS). Surfaced artifacts ride the welcomed leader
 * Port(s) as `extension.discovery` envelopes; the leader injects a `discovery`
 * LickEvent into the worker `LickManager`. Default ON; flip to disable.
 *
 * Registered as a SEPARATE `onHeadersReceived` listener (not folded into the
 * handoff observer) so the handoff notification/forward path stays untouched —
 * Chrome fans an event out to every registered listener.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_DEV_ORIGINS,
  postDiscoveryToWelcomedLeaderPorts,
} from './bridge-sw.js';
import { createDiscoveryObserver } from './discovery-observer.js';
import { getMsgType, type SwMessageOutcome } from './sw-message-router.js';

// Persisted "autodiscover agentic resources" setting (default ON), mirrored
// from the leader tab's `localStorage` write via `discovery.set-enabled` (see
// `discovery-preference.ts`). The SW keeps its own copy in `chrome.storage.local`
// because the observer runs here, not on the page. The flag is cached in-memory
// and refreshed from storage at boot + on every change so the gate is live.
const DISCOVERY_ENABLED_KEY = 'slicc_discovery_enabled';
interface DiscoveryStorageValues {
  [DISCOVERY_ENABLED_KEY]?: unknown;
}
const DISCOVERY_ALLOWED_ORIGINS = __SLICC_EXT_DEV__
  ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS]
  : BRIDGE_ALLOWED_ORIGINS;

// Fail CLOSED until the persisted value has loaded at least once. On MV3 cold
// boot the `onHeadersReceived` listener is registered synchronously, so the very
// navigation that woke the worker can fire before the async `chrome.storage.local`
// read below resolves. If we defaulted the cached flag to `true` in that window,
// a user who stored OFF would still get header extraction + a well-known probe on
// that first navigation. So `discoveryEnabled` starts `false` and the gate also
// requires `discoveryLoaded` — discovery is treated as disabled while the stored
// value is unknown. After load we honor the stored value: opt-out, not opt-in
// (anything other than an explicit `false` means enabled).
let discoveryLoaded = false;
let discoveryEnabled = false;

function loadDiscoveryPreference(): void {
  void chrome.storage.local
    .get(DISCOVERY_ENABLED_KEY)
    .then((result) => {
      const r = result as DiscoveryStorageValues;
      discoveryEnabled = r[DISCOVERY_ENABLED_KEY] !== false;
      discoveryLoaded = true;
    })
    .catch(() => {
      // Storage read failure → fall back to the ON default (a transient error must
      // not wedge the feature off forever); only the pre-load window fails closed.
      discoveryEnabled = true;
      discoveryLoaded = true;
    });
}

function senderOrigin(sender: ChromeMessageSender): string | undefined {
  if (sender.origin !== undefined) return sender.origin;
  try {
    return new URL(sender.url ?? '').origin;
  } catch {
    return undefined;
  }
}

/**
 * `chrome.runtime.onMessageExternal` branch for `discovery.set-enabled`.
 *
 * The setting UI lives on the hosted leader tab, which writes `localStorage`
 * and mirrors the value here over the same externally-connectable channel the
 * bridge uses. Persist it to `chrome.storage.local` (the `onChanged` listener
 * refreshes the cached flag) after gating on the leader origin allowlist.
 */
function handleDiscoverySetEnabled(
  message: unknown,
  sender: ChromeMessageSender
): SwMessageOutcome {
  if (getMsgType(message) !== 'discovery.set-enabled') return 'not-handled';
  const origin = senderOrigin(sender);
  if (!origin || !DISCOVERY_ALLOWED_ORIGINS.includes(origin)) return 'not-handled';
  const enabled = (message as { enabled?: unknown }).enabled !== false;
  void chrome.storage.local.set({ [DISCOVERY_ENABLED_KEY]: enabled }).catch(() => {
    /* best-effort: the mirror is advisory; the ON default still holds */
  });
  return 'handled';
}

/**
 * Register the discovery observer, its `chrome.storage` preference mirror, and
 * the `onMessageExternal` setting sink. Install AFTER
 * `installHandoffNotifications()` so the handoff observer keeps its position as
 * the first `onHeadersReceived` listener.
 */
export function installDiscoveryObserver(): void {
  loadDiscoveryPreference();

  chrome.storage.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local') return;
    const change = changes[DISCOVERY_ENABLED_KEY];
    if (change) {
      discoveryEnabled = change.newValue !== false;
      discoveryLoaded = true;
    }
  });

  chrome.runtime.onMessageExternal?.addListener?.(
    (message: unknown, sender: ChromeMessageSender): boolean => {
      handleDiscoverySetEnabled(message, sender);
      return false;
    }
  );

  const discoveryObserver = createDiscoveryObserver({
    fetchImpl: (url, init) => fetch(url, init as RequestInit | undefined),
    emit: (discovery) =>
      postDiscoveryToWelcomedLeaderPorts({ kind: 'extension.discovery', ...discovery }),
    isEnabled: () => discoveryLoaded && discoveryEnabled,
  });
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      discoveryObserver.onHeaders({
        url: details.url,
        responseHeaders: details.responseHeaders,
      });
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['responseHeaders']
  );
}
