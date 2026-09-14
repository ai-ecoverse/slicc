import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_DEV_ORIGINS,
  postDiscoveryToWelcomedLeaderPorts,
} from './bridge-sw.js';
import { createDiscoveryObserver } from './discovery-observer.js';
import { getMsgType, type SwMessageOutcome } from './sw-message-router.js';

const DISCOVERY_ENABLED_KEY = 'slicc_discovery_enabled';
interface DiscoveryStorageValues {
  [DISCOVERY_ENABLED_KEY]?: unknown;
}
const DISCOVERY_ALLOWED_ORIGINS = __SLICC_EXT_DEV__
  ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS]
  : BRIDGE_ALLOWED_ORIGINS;

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

function handleDiscoverySetEnabled(
  message: unknown,
  sender: ChromeMessageSender
): SwMessageOutcome {
  if (getMsgType(message) !== 'discovery.set-enabled') return 'not-handled';
  const origin = senderOrigin(sender);
  if (!origin || !DISCOVERY_ALLOWED_ORIGINS.includes(origin)) return 'not-handled';
  const enabled = (message as { enabled?: unknown }).enabled !== false;
  void chrome.storage.local.set({ [DISCOVERY_ENABLED_KEY]: enabled }).catch(() => {});
  return 'handled';
}

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
