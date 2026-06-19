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

import { getPanelRpcClient } from '../kernel/panel-rpc.js';
import { getBridgeToken, getLocalApiBaseUrl } from '../shell/proxied-fetch.js';
import { createInterceptingOAuthLauncher } from './intercepted-oauth.js';
import type { InterceptingOAuthLauncher, OAuthLauncher } from './types.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

/**
 * Resolve the GET target for the OAuth-result poll. In classic CLI (UI
 * served by the local node-server) this is the legacy same-origin path;
 * in thin-bridge mode (UI hosted at sliccy.ai, /api on the local
 * node-server) `setLocalApiBaseUrl` has been called during boot and we
 * route to that absolute origin so the poll doesn't hit the wrangler UI
 * and parse the SPA index.html as JSON.
 */
function resolveOAuthResultUrl(): string {
  const base = getLocalApiBaseUrl();
  return base ? `${base}/api/oauth-result` : '/api/oauth-result';
}

/**
 * Build the request headers for the OAuth-result poll. Same gating as
 * `createProxiedFetch` in CLI mode: only attach `X-Bridge-Token` when
 * both a bridge token and a local API base are configured — same-origin
 * / loopback callers don't need it and the local node-server only
 * enforces it on cross-origin /api/* in thin-bridge mode.
 */
function buildOAuthResultHeaders(): Record<string, string> {
  const base = getLocalApiBaseUrl();
  const token = getBridgeToken();
  return base && token ? { 'X-Bridge-Token': token } : {};
}

/** Create an OAuthLauncher appropriate for the current runtime. */
export function createOAuthLauncher(): OAuthLauncher {
  if (isExtension) return launchOAuthExtension;
  // DedicatedWorker (kernel-worker.ts) has no `window`; route the popup
  // through the panel-RPC bridge so the page can open the real window.
  if (typeof window === 'undefined') return launchOAuthViaPanel;
  return launchOAuthCli;
}

/**
 * Resolve the active CDP transport and build an
 * {@link InterceptingOAuthLauncher} bound to it. Returns null when no
 * transport is available in the current runtime (e.g. plain webapp with no
 * controlled browser attached), so the caller can fall back gracefully.
 *
 * Intentionally async + lazy: the transport-lookup paths differ by mode
 * (DebuggerClient in extension mode, CDPClient in CLI/node-server mode) and
 * we don't want to import them eagerly.
 */
export async function createInterceptingOAuthLauncherForCurrentRuntime(): Promise<InterceptingOAuthLauncher | null> {
  const transport = await resolveActiveCdpTransport();
  if (!transport) return null;
  return createInterceptingOAuthLauncher(transport);
}

async function resolveActiveCdpTransport() {
  try {
    const { getActiveCdpTransport } = await import('../cdp/active-transport.js');
    return await getActiveCdpTransport();
  } catch (err) {
    console.warn(
      '[oauth-service] could not resolve active CDP transport:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Worker-aware page origin lookup. Provider `onOAuthLogin` implementations
 * construct redirect URIs and OAuth `state` payloads from
 * `window.location.origin` / `window.location.href`, but when the shell
 * command `oauth-token <provider>` invokes them they run inside the kernel
 * `DedicatedWorker` where `window` is undefined. This helper returns the page
 * origin directly when called in the page (or extension offscreen DOM), and
 * routes through panel-RPC `page-info` when called from the worker.
 *
 * Throws when neither path is available so callers surface a clear error
 * instead of `ReferenceError: window is not defined`.
 */
export async function getOAuthPageOrigin(): Promise<{ origin: string; href: string }> {
  if (typeof window !== 'undefined') {
    return { origin: window.location.origin, href: window.location.href };
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    throw new Error(
      'OAuth from worker context requires the panel-RPC bridge (no page-info available)'
    );
  }
  const info = await rpc.call('page-info', undefined);
  return { origin: info.origin, href: info.href };
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
 *
 * Two parallel signals race to deliver the redirect URL:
 *   1. postMessage from the /auth/callback page back to this window
 *      (works when window.opener is intact).
 *   2. Polling /api/oauth-result on the backing server (works even when
 *      window.opener is severed — e.g. by a COOP `same-origin` provider
 *      such as GitHub/Google/Microsoft, or in Electron overlay mode
 *      where window.open spawns the system browser).
 *
 * Whichever signal arrives first resolves the launcher promise; the
 * other is cancelled in cleanup(). The 120 s timeout still applies.
 */
async function launchOAuthCli(authorizeUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');

    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closedTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (closedTimer) clearInterval(closedTimer);
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

    // Always poll the server for the OAuth result as a fallback to
    // postMessage. The callback page POSTs the result to /api/oauth-result
    // when window.opener is null; both node-server and swift-server stash
    // it for GET retrieval. Whichever signal arrives first wins.
    pollTimer = setInterval(async () => {
      if (resolved) return;
      try {
        const res = await fetch(resolveOAuthResultUrl(), {
          headers: buildOAuthResultHeaders(),
        });
        if (res.status === 204) return; // no result yet
        if (!res.ok) return; // server hiccup — keep polling
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
        // Network error or JSON parse failure — log and keep polling
        console.warn(
          '[oauth-service] Poll failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }, 1000);

    // Resolve null when the user closes the popup (cancelled flow).
    //
    // Important: the callback page fires `fetch(POST /api/oauth-result)` and
    // then calls `window.close()` synchronously, so the POST may still be
    // in-flight when `popup.closed` first becomes true. Resolving null
    // immediately would race against the 1000ms poll timer that reads the
    // stored redirect — cancelling login before the server result arrives.
    //
    // Fix: stop the closed-poll but let pollTimer run for one extra grace
    // period (1500ms > one poll interval). If the result lands in that window
    // pollTimer resolves first; otherwise we resolve null after the grace.
    if (popup) {
      closedTimer = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(closedTimer!);
        closedTimer = null;
        setTimeout(() => {
          if (!resolved) {
            cleanup();
            resolve(null);
          }
        }, 1500);
      }, 500);
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
 * Opens a URL in a popup for a fixed duration to clear an IdP browser session,
 * then closes the popup. Fire-and-forget — does not wait for any OAuth callback.
 *
 * Only runs in CLI (window-based) runtime; skipped silently in extension/worker
 * runtimes where popup control is not available.
 */
export async function openIdpLogoutUrl(
  url: string,
  timeoutMs = 3 * 60 * 1000 // 3 minutes: generous enough for the user to sign out
): Promise<void> {
  if (typeof window === 'undefined') return; // worker runtime — skip
  if (isExtension) return; // extension runtime — skip
  const popup = window.open(url, '_blank', 'width=500,height=600,popup=yes');
  if (!popup) {
    console.warn('[oauth-service] Could not open IdP logout popup — popups may be blocked');
    return;
  }
  // Wait for the user to close the popup themselves (e.g. after clicking Sign Out
  // on the IdP page). Auto-close after timeoutMs as a fallback.
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      try {
        popup.close();
      } catch {
        /* best-effort */
      }
      resolve();
    }, timeoutMs);
    const poll = setInterval(() => {
      if (popup.closed) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      }
    }, 500);
  });
}

/**
 * Extension mode: route through service worker → chrome.identity.launchWebAuthFlow.
 * The service worker returns the redirect URL (with fragment) via a broadcast message.
 */
async function launchOAuthExtension(
  authorizeUrl: string,
  opts?: { interactive?: boolean }
): Promise<string | null> {
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
        payload: {
          type: 'oauth-request',
          providerId: 'oauth',
          authorizeUrl,
          interactive: opts?.interactive ?? true,
        },
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
