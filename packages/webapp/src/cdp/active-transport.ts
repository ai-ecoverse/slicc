import type { BrowserAPI } from './browser-api.js';
import type { CDPTransport } from './transport.js';

interface BrowserHolder {
  __slicc_browser?: BrowserAPI;
}

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
