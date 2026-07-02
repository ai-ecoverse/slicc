import { ELECTRON_OVERLAY_APP_PATH } from '@slicc/shared-ts';
import {
  DETACHED_RUNTIME_QUERY_NAME,
  DETACHED_RUNTIME_QUERY_VALUE,
} from '../../../chrome-extension/src/messages.js';
import {
  type RuntimeConfigStorage,
  resolveFollowerJoinUrl,
} from '../scoops/tray-runtime-config.js';
import {
  DEFAULT_EXTENSION_TAB_ID,
  type ExtensionTabId,
  isBuiltinExtensionTabId,
} from './tabbed-ui.js';

export type UiRuntimeMode =
  | 'standalone'
  | 'extension'
  | 'electron-overlay'
  | 'extension-detached'
  | 'hosted-leader'
  | 'connect'
  | 'cherry'
  | 'follower';

export const ELECTRON_OVERLAY_RUNTIME_QUERY_VALUE = 'electron-overlay';
export const HOSTED_LEADER_RUNTIME_QUERY_VALUE = 'hosted-leader';

// Re-export shared detached-runtime constants from chrome-extension/messages.ts
// so panel-side code (resolveUiRuntimeMode) and SW-side code share the same
// source of truth.
export {
  DETACHED_RUNTIME_QUERY_NAME,
  DETACHED_RUNTIME_QUERY_VALUE,
} from '../../../chrome-extension/src/messages.js';

export function resolveUiRuntimeMode(
  locationHref: string,
  isExtension: boolean,
  storage?: RuntimeConfigStorage | null
): UiRuntimeMode {
  if (isExtension) {
    try {
      const url = new URL(locationHref);
      if (url.searchParams.get(DETACHED_RUNTIME_QUERY_NAME) === DETACHED_RUNTIME_QUERY_VALUE) {
        return 'extension-detached';
      }
    } catch {
      // Fall through to plain 'extension' mode.
    }
    return 'extension';
  }
  try {
    const url = new URL(locationHref);
    // Check for connect mode
    if (url.searchParams.get('connect') === '1') {
      return 'connect';
    }
    // Check for hosted-leader first, before path-based detection
    if (url.searchParams.get('runtime') === HOSTED_LEADER_RUNTIME_QUERY_VALUE) {
      return 'hosted-leader';
    }
    if (url.searchParams.get('cherry') === '1') {
      return 'cherry';
    }
    // Follower fast-path: a validated join URL (path, ?tray= query, or stored key).
    // Resolve storage lazily and DOM-safely so this stays callable in Node tests.
    // NOTE: only an OMITTED storage arg falls back to ambient window.localStorage;
    // an explicit `null` means "no storage" (tests pass null to assert URL-only
    // detection) and must NOT reach for the global.
    const followerStorage =
      storage === undefined
        ? typeof window !== 'undefined'
          ? window.localStorage
          : null
        : storage;
    if (resolveFollowerJoinUrl(locationHref, followerStorage)) return 'follower';
    return isElectronOverlayUrl(url) ? 'electron-overlay' : 'standalone';
  } catch {
    return 'standalone';
  }
}

export function shouldUseRuntimeModeTrayDefaults(
  runtimeMode: UiRuntimeMode,
  hasRuntimeConfigEndpoint: boolean
): boolean {
  return (
    runtimeMode === 'electron-overlay' ||
    runtimeMode === 'hosted-leader' ||
    (runtimeMode === 'standalone' && hasRuntimeConfigEndpoint)
  );
}

export function getElectronOverlayInitialTab(locationHref: string): ExtensionTabId {
  try {
    const url = new URL(locationHref);
    const tab = url.searchParams.get('tab');
    return tab && isBuiltinExtensionTabId(tab) ? tab : DEFAULT_EXTENSION_TAB_ID;
  } catch {
    return DEFAULT_EXTENSION_TAB_ID;
  }
}

function isElectronOverlayUrl(url: URL): boolean {
  return (
    url.pathname === ELECTRON_OVERLAY_APP_PATH ||
    url.pathname === `${ELECTRON_OVERLAY_APP_PATH}/` ||
    url.searchParams.get('runtime') === ELECTRON_OVERLAY_RUNTIME_QUERY_VALUE
  );
}

export function getLickWebSocketUrl(locationHref: string): string {
  const url = new URL(locationHref);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/licks-ws`;
}

export function getWebhookUrl(locationHref: string, webhookId: string): string {
  const url = new URL(locationHref);
  return `${url.origin}/webhooks/${webhookId}`;
}

/** Construct a per-webhook URL under a tray webhook capability URL. */
export function getTrayWebhookUrl(trayWebhookUrl: string, webhookId: string): string {
  const normalizedBase = trayWebhookUrl.replace(/\/+$/, '');
  const normalizedWebhookId = webhookId.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedWebhookId}`;
}
