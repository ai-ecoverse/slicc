/**
 * Generic OAuth launcher — provides the transport layer for OAuth flows.
 *
 * Slicc provides the OAuth *transport* (open a window, get the redirect URL back).
 * The provider handles everything else (what URL to open, what to do with the result).
 *
 * Two implementations:
 *   CLI:       popup → /auth/callback → postMessage back to opener
 *   Extension: chrome.identity.launchWebAuthFlow via service worker
 */

import type { OAuthLauncher } from './types.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

/** Create an OAuthLauncher appropriate for the current runtime. */
export function createOAuthLauncher(): OAuthLauncher {
  return isExtension ? launchOAuthExtension : launchOAuthCli;
}

/**
 * CLI mode: open a popup to the authorize URL.
 * The OAuth provider redirects to /auth/callback which postMessages the
 * redirect URL back to this window, then auto-closes.
 */
async function launchOAuthCli(authorizeUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');

    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
    };

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'oauth-callback') return;
      cleanup();

      if (event.data.error) {
        console.error('[oauth-service] CLI OAuth error:', event.data.error);
        resolve(null);
        return;
      }

      resolve(event.data.redirectUrl ?? null);
    };

    window.addEventListener('message', handler);

    // Timeout after 2 minutes
    const timer = setTimeout(() => {
      cleanup();
      try { popup?.close(); } catch { /* best-effort */ }
      resolve(null);
    }, 120000);
  });
}

/**
 * Extension mode: route through service worker → chrome.identity.launchWebAuthFlow.
 * The service worker returns the redirect URL (with fragment) via a broadcast message.
 */
async function launchOAuthExtension(authorizeUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      (chrome as any).runtime.onMessage.removeListener(handler);
      clearTimeout(timer);
    };

    const handler = (message: any) => {
      if (message?.source !== 'service-worker') return;
      if (message?.payload?.type !== 'oauth-result') return;
      cleanup();

      if (message.payload.error) {
        console.error('[oauth-service] Extension OAuth error:', message.payload.error);
        resolve(null);
        return;
      }

      resolve(message.payload.redirectUrl ?? null);
    };

    (chrome as any).runtime.onMessage.addListener(handler);
    (chrome as any).runtime.sendMessage({
      source: 'panel',
      payload: { type: 'oauth-request', providerId: 'oauth', authorizeUrl },
    }).catch((err: unknown) => {
      console.error('[oauth-service] Failed to send OAuth request to service worker:', err);
    });

    // Timeout after 2 minutes (same as CLI launcher)
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 120000);
  });
}
