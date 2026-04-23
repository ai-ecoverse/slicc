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

/**
 * Create an OAuthLauncher appropriate for the current runtime.
 *
 * `prewarmedPopup` is an optional window handle the caller opened synchronously
 * inside a user gesture (e.g. a click handler). Chrome suppresses popups
 * whose `window.open` runs after any `await`, so providers that do async
 * config work before calling the launcher would otherwise get blocked by
 * the popup blocker. The caller opens `about:blank` up-front; we navigate
 * it to the authorize URL here once the provider has built the URL.
 *
 * Only used in CLI mode — the extension path uses `chrome.identity.launchWebAuthFlow`
 * which has no popup-blocker constraint.
 */
export function createOAuthLauncher(prewarmedPopup?: Window | null): OAuthLauncher {
  if (isExtension) return launchOAuthExtension;
  return (authorizeUrl: string) => launchOAuthCli(authorizeUrl, prewarmedPopup ?? null);
}

/**
 * CLI mode: open a popup to the authorize URL.
 * The OAuth provider redirects to /auth/callback which postMessages the
 * redirect URL back to this window, then auto-closes.
 *
 * In Electron overlay mode, window.open opens the system browser so
 * window.opener is null and postMessage won't work. The callback page
 * falls back to POSTing the result to the CLI server, and we poll for it.
 */
async function launchOAuthCli(
  authorizeUrl: string,
  prewarmedPopup: Window | null
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    // If the caller pre-opened a placeholder window inside a user gesture,
    // navigate it instead of calling window.open again (which would be
    // popup-blocked because we've lost user-activation across awaits).
    let popup: Window | null;
    if (prewarmedPopup && !prewarmedPopup.closed) {
      try {
        prewarmedPopup.location.href = authorizeUrl;
        popup = prewarmedPopup;
      } catch {
        // Some environments throw on cross-origin assignment — fall
        // back to opening a fresh window, which may be blocked but
        // is at least not a silent no-op.
        popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
      }
    } else {
      popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
    }

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
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

    // Poll the server for the OAuth result — Electron overlay only.
    // In Electron overlay mode, window.open opens the system browser so
    // window.opener is null and postMessage won't work. The callback page
    // falls back to POSTing the result to /api/oauth-result, and we poll.
    // In normal CLI mode, postMessage works so polling is unnecessary.
    const isElectronOverlay =
      location.pathname.startsWith('/electron') ||
      new URLSearchParams(location.search).get('runtime') === 'electron-overlay';
    if (isElectronOverlay) {
      pollTimer = setInterval(async () => {
        if (resolved) return;
        try {
          const res = await fetch('/api/oauth-result');
          if (res.status === 204) return; // no result yet
          const data = (await res.json()) as { redirectUrl?: string; error?: string };
          if (resolved) return;
          cleanup();

          if (data.error) {
            console.error('[oauth-service] Server relay OAuth error:', data.error);
            resolve(null);
            return;
          }

          resolve(data.redirectUrl ?? null);
        } catch (err) {
          // Network error or JSON parse failure — keep polling
          console.warn(
            '[oauth-service] Poll failed:',
            err instanceof Error ? err.message : String(err)
          );
        }
      }, 1000);
    }

    // Timeout after 2 minutes
    const timer = setTimeout(() => {
      cleanup();
      try {
        popup?.close();
      } catch {
        /* best-effort */
      }
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
    (chrome as any).runtime
      .sendMessage({
        source: 'panel',
        payload: { type: 'oauth-request', providerId: 'oauth', authorizeUrl },
      })
      .catch((err: unknown) => {
        console.error('[oauth-service] Failed to send OAuth request to service worker:', err);
      });

    // Timeout after 2 minutes (same as CLI launcher)
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 120000);
  });
}
