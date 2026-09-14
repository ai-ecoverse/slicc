import { createLogger } from '../../core/index.js';
import { isExtensionRealm } from '../../core/runtime-env.js';
import {
  type BridgeConfigMessage,
  type ExtensionDelegateConfigMessage,
  SW_BRIDGE_CONFIG_MESSAGE,
  SW_EXTENSION_DELEGATE_MESSAGE,
} from '../llm-proxy-sw-config.js';

const log = createLogger('boot/sw-registration');

export interface SwRegistrationBridgeConfig {
  apiBaseUrl: string | null;
  token: string | null;
}

export interface SwRegistrationExtensionDelegate {
  extensionId: string;
}

export async function setupSwRegistration(
  bridge: SwRegistrationBridgeConfig | null = null,
  extensionDelegate: SwRegistrationExtensionDelegate | null = null
): Promise<'ready' | 'reload-pending'> {
  const isConnectModeForSw = (() => {
    try {
      return new URL(window.location.href).searchParams.get('connect') === '1';
    } catch {
      return false;
    }
  })();

  if ('serviceWorker' in navigator && isConnectModeForSw) {
    const reloaded = await detachServiceWorkerForConnectMode();
    if (reloaded) return 'reload-pending';
  }

  if (!('serviceWorker' in navigator) || isConnectModeForSw) return 'ready';

  try {
    await navigator.serviceWorker.register('/preview-sw.js', { scope: '/preview/' });
    log.info('Preview SW registered');
    const isExtensionForSw = isExtensionRealm();
    if (!isExtensionForSw) {
      try {
        await navigator.serviceWorker.register('/llm-proxy-sw.js', { scope: '/' });
        log.info('LLM-proxy SW registered');
      } catch (err) {
        log.error('LLM-proxy SW registration failed — cross-origin LLM calls will hit CORS', err);
      }
    }
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          })
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    if (!navigator.serviceWorker.controller && !sessionStorage.getItem('slicc-sw-reloaded')) {
      sessionStorage.setItem('slicc-sw-reloaded', '1');
      log.info('Reloading once to gain SW control');
      location.reload();
      return 'reload-pending';
    }
    sessionStorage.removeItem('slicc-sw-reloaded');

    if (bridge) {
      pushBridgeConfigToController(bridge);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        pushBridgeConfigToController(bridge);
      });
    }
    if (extensionDelegate) {
      pushExtensionDelegateToController(extensionDelegate);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        pushExtensionDelegateToController(extensionDelegate);
      });
    }
  } catch (err) {
    log.error('Preview SW registration failed — preview feature will not work', err);
  }
  return 'ready';
}

function pushBridgeConfigToController(bridge: SwRegistrationBridgeConfig): void {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const message: BridgeConfigMessage = {
    type: SW_BRIDGE_CONFIG_MESSAGE,
    apiBaseUrl: bridge.apiBaseUrl,
    token: bridge.token,
  };
  try {
    controller.postMessage(message);
  } catch (err) {
    log.warn('LLM-proxy SW bridge-config postMessage failed', err);
  }
}

function pushExtensionDelegateToController(delegate: SwRegistrationExtensionDelegate): void {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const message: ExtensionDelegateConfigMessage = {
    type: SW_EXTENSION_DELEGATE_MESSAGE,
    extensionId: delegate.extensionId,
  };
  try {
    controller.postMessage(message);
  } catch (err) {
    log.warn('LLM-proxy SW extension-delegate postMessage failed', err);
  }
}

async function detachServiceWorkerForConnectMode(): Promise<boolean> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    if (navigator.serviceWorker.controller && !sessionStorage.getItem('slicc-connect-sw-cleared')) {
      sessionStorage.setItem('slicc-connect-sw-cleared', '1');
      log.info('connect mode: detaching from service worker (no proxy on worker origin)');
      location.reload();
      return true;
    }
    sessionStorage.removeItem('slicc-connect-sw-cleared');
  } catch (err) {
    log.error('connect-mode SW cleanup failed', err);
  }
  return false;
}
