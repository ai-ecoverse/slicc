/**
 * `setup-sw-registration.ts` — service-worker registration block
 * extracted from `main()` in `main.ts`. Handles three concerns:
 *
 * 1. Connect-mode (`?connect=1`) SW detach. The cloudflare worker
 *    serving `/connect` has no `/api/fetch-proxy`, so the llm-proxy SW
 *    (scope `/`) would 404 every cross-origin fetch. We unregister any
 *    SW left from a prior full-app visit on this origin and reload once
 *    to detach.
 *
 * 2. Preview-SW (`/preview/*`) + LLM-proxy SW (`/`) registration. Both
 *    are required for VFS preview rendering and cross-origin LLM calls
 *    respectively. The extension bypasses LLM-proxy via host_permissions
 *    so we only register it in standalone.
 *
 * 3. SW-controller wait + one-shot reload to ensure both SWs are
 *    `clients.claim()`-active before the page proceeds. Otherwise the
 *    first cross-origin provider request slips past the proxy and hits
 *    CORS directly.
 */

import { createLogger } from '../../core/index.js';

const log = createLogger('boot/sw-registration');

/**
 * Run the SW registration sequence. Returns `'reload-pending'` if
 * `location.reload()` has been invoked (the caller should `return`
 * immediately) and `'ready'` otherwise.
 */
export async function setupSwRegistration(): Promise<'ready' | 'reload-pending'> {
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
    const isExtensionForSw = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
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
  } catch (err) {
    log.error('Preview SW registration failed — preview feature will not work', err);
  }
  return 'ready';
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
