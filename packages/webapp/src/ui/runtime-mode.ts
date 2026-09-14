import { ELECTRON_OVERLAY_APP_PATH } from '@slicc/shared-ts';
import { DETACHED_RUNTIME_QUERY_NAME } from '../kernel/messages.js';
import {
  type RuntimeConfigStorage,
  resolveFollowerJoinUrl,
} from '../scoops/tray-runtime-config.js';

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

export { DETACHED_RUNTIME_QUERY_NAME } from '../kernel/messages.js';

export function resolveUiRuntimeMode(
  locationHref: string,
  isExtension: boolean,
  storage?: RuntimeConfigStorage | null
): UiRuntimeMode {
  if (isExtension) {
    try {
      const url = new URL(locationHref);
      if (url.searchParams.has(DETACHED_RUNTIME_QUERY_NAME)) {
        return 'extension-detached';
      }
    } catch {}
    return 'extension';
  }
  try {
    const url = new URL(locationHref);

    if (url.searchParams.get('connect') === '1') {
      return 'connect';
    }

    if (url.searchParams.get('runtime') === HOSTED_LEADER_RUNTIME_QUERY_VALUE) {
      return 'hosted-leader';
    }
    if (url.searchParams.get('cherry') === '1') {
      return 'cherry';
    }

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

function isElectronOverlayUrl(url: URL): boolean {
  return (
    url.pathname === ELECTRON_OVERLAY_APP_PATH ||
    url.pathname === `${ELECTRON_OVERLAY_APP_PATH}/` ||
    url.searchParams.get('runtime') === ELECTRON_OVERLAY_RUNTIME_QUERY_VALUE
  );
}
