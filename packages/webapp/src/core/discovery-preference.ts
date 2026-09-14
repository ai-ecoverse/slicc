import { getExtensionDelegateId } from '../shell/proxied-fetch.js';

const STORAGE_KEY = 'slicc_discovery_enabled';

export const DISCOVERY_SET_ENABLED_MESSAGE = 'discovery.set-enabled';

export function getDiscoveryEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage?.getItem !== 'function')
      return true;
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setDiscoveryEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage?.setItem === 'function')
      localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {}
  mirrorToExtensionServiceWorker(enabled);
}

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
        void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime
          ?.lastError;
      }
    );
  } catch {}
}
