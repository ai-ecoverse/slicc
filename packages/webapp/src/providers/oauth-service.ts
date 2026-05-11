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
import { getPanelRpcClient } from '../kernel/panel-rpc.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

/** Create an OAuthLauncher appropriate for the current runtime. */
export function createOAuthLauncher(): OAuthLauncher {
  if (isExtension) return launchOAuthExtension;
  // DedicatedWorker (kernel-worker.ts) has no `window`; route the popup
  // through the panel-RPC bridge so the page can open the real window.
  if (typeof window === 'undefined') return launchOAuthViaPanel;
  return launchOAuthCli;
}

/**
 * Worker-context OAuth launcher. Delegates to the page via panel-RPC so the
 * page can open a real popup window (workers have no `window.open`).
 */
async function launchOAuthViaPanel(authorizeUrl: string): Promise<string | null> {
  const rpcClient = getPanelRpcClient();
  if (!rpcClient) {
    console.error('[oauth-service] panel-RPC client unavailable in worker');
    return null;
  }
  try {
    const result = await rpcClient.call(
      'oauth-popup',
      { url: authorizeUrl },
      { timeoutMs: 130_000 }
    );
    return result.redirectUrl;
  } catch (err) {
    console.error(
      '[oauth-service] oauth-popup RPC failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
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
async function launchOAuthCli(authorizeUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');

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
      if (event.origin !== window.location.origin) return;
      if (popup && event.source !== popup) return;
      cleanup();

      if (event.data.error) {
        console.error('[oauth-service] CLI OAuth error:', event.data.error);
        resolve(null);
        return;
      }

      const redirectUrl = event.data.redirectUrl;
      if (typeof redirectUrl !== 'string' && redirectUrl !== null && redirectUrl !== undefined)
        return;
      resolve(redirectUrl ?? null);
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
