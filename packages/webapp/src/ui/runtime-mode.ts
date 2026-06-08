import {
  DETACHED_RUNTIME_QUERY_NAME,
  DETACHED_RUNTIME_QUERY_VALUE,
} from '../../../chrome-extension/src/messages.js';
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
  | 'cherry';

export const ELECTRON_OVERLAY_RUNTIME_QUERY_VALUE = 'electron-overlay';
export const HOSTED_LEADER_RUNTIME_QUERY_VALUE = 'hosted-leader';
export const ELECTRON_OVERLAY_RUNTIME_PATH = '/electron';
export const ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE = 'slicc-electron-overlay:set-tab';
export const ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE = 'slicc-electron-overlay:close';
export const ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE =
  'slicc-electron-overlay:follower-status';

/**
 * Three visible follower states the floating launcher pill renders. The inner
 * app maps its richer `FollowerTrayRuntimeStatus.state` down to this enum
 * before posting it to the overlay shell — see `mapFollowerStateToOverlay`
 * in `main.ts`.
 */
export type ElectronOverlayFollowerStatus = 'disconnected' | 'connected' | 'error';
// Re-export shared detached-runtime constants from chrome-extension/messages.ts
// so panel-side code (resolveUiRuntimeMode) and SW-side code share the same
// source of truth.
export {
  DETACHED_RUNTIME_QUERY_NAME,
  DETACHED_RUNTIME_QUERY_VALUE,
} from '../../../chrome-extension/src/messages.js';

export interface ElectronOverlaySetTabMessage {
  type: typeof ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE;
  tab?: string;
}

export interface ElectronOverlayCloseMessage {
  type: typeof ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE;
}

export interface ElectronOverlayFollowerStatusMessage {
  type: typeof ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE;
  status: ElectronOverlayFollowerStatus;
}

/**
 * Map the rich `FollowerTrayRuntimeStatus.state` enum down to the three
 * visible launcher states: `connected` is the only "synced" case; `error`
 * keeps its own icon (crossed-out eyes); everything else (`inactive`,
 * `connecting`, `reconnecting`) falls back to `disconnected`.
 */
export function mapFollowerStateToOverlayStatus(
  state: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'error'
): ElectronOverlayFollowerStatus {
  if (state === 'connected') return 'connected';
  if (state === 'error') return 'error';
  return 'disconnected';
}

export function resolveUiRuntimeMode(locationHref: string, isExtension: boolean): UiRuntimeMode {
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
    url.pathname === ELECTRON_OVERLAY_RUNTIME_PATH ||
    url.pathname === `${ELECTRON_OVERLAY_RUNTIME_PATH}/` ||
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

export function isElectronOverlaySetTabMessage(
  value: unknown
): value is ElectronOverlaySetTabMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as Record<string, unknown>).type === ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE
  );
}

export function isElectronOverlayCloseMessage(
  value: unknown
): value is ElectronOverlayCloseMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as Record<string, unknown>).type === ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE
  );
}

export function isElectronOverlayFollowerStatusMessage(
  value: unknown
): value is ElectronOverlayFollowerStatusMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE) return false;
  const status = record.status;
  return status === 'disconnected' || status === 'connected' || status === 'error';
}
