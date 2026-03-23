import {
  DEFAULT_EXTENSION_TAB_ID,
  isBuiltinExtensionTabId,
  type ExtensionTabId,
} from './tabbed-ui.js';

export type UiRuntimeMode = 'standalone' | 'extension' | 'electron-overlay';

export const ELECTRON_OVERLAY_RUNTIME_QUERY_VALUE = 'electron-overlay';
export const ELECTRON_OVERLAY_RUNTIME_PATH = '/electron';
export const ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE = 'slicc-electron-overlay:set-tab';

export interface ElectronOverlaySetTabMessage {
  type: typeof ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE;
  tab?: string;
}

export function resolveUiRuntimeMode(locationHref: string, isExtension: boolean): UiRuntimeMode {
  if (isExtension) return 'extension';

  try {
    const url = new URL(locationHref);
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
    runtimeMode === 'electron-overlay' || (runtimeMode === 'standalone' && hasRuntimeConfigEndpoint)
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
