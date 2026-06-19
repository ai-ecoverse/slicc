/**
 * Active CDP transport accessor.
 *
 * Returns the underlying {@link CDPTransport} of whatever `BrowserAPI` was
 * registered by the kernel host (`packages/webapp/src/kernel/host.ts`)
 * — which is the `WorkerCdpProxy` over WebSocket in standalone CLI mode,
 * and the `ExtensionBridgeTransport` (thin extension `chrome.runtime`
 * Port to the service-worker `chrome.debugger` proxy) in extension mode.
 *
 * Used by the OAuth interception launcher
 * ({@link import('../providers/intercepted-oauth.js').createInterceptingOAuthLauncher})
 * to drive a controlled tab without owning the transport itself.
 */

import type { BrowserAPI } from './browser-api.js';
import type { CDPTransport } from './transport.js';

interface BrowserHolder {
  __slicc_browser?: BrowserAPI;
}

/**
 * Returns the CDP transport for the kernel host's active BrowserAPI, or
 * `null` when no kernel host is running in the current realm (e.g. on the
 * page side, where the host lives in the worker / offscreen document).
 */
export async function getActiveCdpTransport(): Promise<CDPTransport | null> {
  const browser = (globalThis as unknown as BrowserHolder).__slicc_browser;
  if (!browser) return null;
  try {
    return browser.getTransport();
  } catch (err) {
    console.warn(
      '[active-transport] BrowserAPI.getTransport() threw:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
