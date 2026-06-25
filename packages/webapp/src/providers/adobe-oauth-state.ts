/**
 * Pure helper: build the Adobe IMS implicit-flow `redirect_uri`, OAuth `state`,
 * and expected nonce for the page-context login path.
 *
 * Two flavors depending on how the SPA is served:
 *
 *   - **Classic CLI** (node-server / swift-server serves `dist/ui/` on
 *     `http://localhost:<port>`): state carries `{ port, path, nonce }` (the
 *     default `source: 'local'`); the worker's relay bounces the IMS hash
 *     response back to `http://localhost:<port>/auth/callback`, where the
 *     local server's callback page handles delivery.
 *
 *   - **Worker-served / thin-bridge / hosted-leader**: SPA is served by the
 *     cloudflare-worker — either the production relay (`https://www.sliccy.ai`)
 *     or `wrangler dev` on `http://localhost:8787`. `redirect_uri` MUST be the
 *     hardcoded production relay (`configuredRedirectUri`) because that is the
 *     only origin Adobe IMS allowlists; pinning to the page's own origin
 *     (especially `http://localhost:8787`) makes IMS reject the request.
 *
 *     - **Hosted-leader** (`pageOrigin === relayOrigin`): state uses
 *       `source:'opener'`; the relay's HTML `postMessage`s the full callback
 *       URL (with the implicit-flow hash) to `window.opener` directly.
 *     - **Wrangler dev** (`pageOrigin` is a localhost/127.0.0.1 origin with a
 *       port): state uses `source:'local'` + the page's port; the prod relay
 *       forwards the IMS hash back to `http://localhost:<port>/auth/callback`,
 *       and the local relay (same worker code) trips its self-origin guard
 *       (`localOrigin === location.origin`) and delivers to the opener.
 *
 *     If `configuredRedirectUri` is absent in the worker-served path we fall
 *     back to the previous degraded behavior (`source:'opener'` pinned to
 *     `${pageOrigin}/auth/callback`); this only works when IMS happens to
 *     allowlist the page origin, but it never makes a missing config worse.
 *
 * Detection: the thin-bridge launch params include `?bridge=<ws-url>`. When
 * that query param is present on the page URL the SPA is being served by the
 * worker; the node-server (if any) is only the local CDP/API bridge.
 *
 * Helper is intentionally framework-free so it can be unit-tested without
 * importing `adobe.ts` (which uses `import.meta.glob`).
 */

import { BRIDGE_WS_QUERY_PARAM } from '../ui/boot/bridge-launch-params.js';

export interface BuildAdobeOAuthStateInput {
  /** The page's full URL (`window.location.href` or the panel-RPC equivalent). */
  pageHref: string;
  /** The page's origin (`window.location.origin`). */
  pageOrigin: string;
  /** Build-time `adobe-config.json` `redirectUri`, if any. */
  configuredRedirectUri?: string;
}

export interface BuildAdobeOAuthStateResult {
  redirectUri: string;
  /** Base64-encoded JSON state envelope sent on the IMS authorize call. */
  oauthState: string;
  /** Nonce the post-callback verifier compares `?nonce=` against. */
  expectedNonce: string;
  /** Which relay branch this state targets (for diagnostics + tests). */
  source: 'local' | 'opener';
}

/**
 * True when the SPA was launched by the thin-bridge / hosted-leader (worker
 * serves the SPA, optional node-server is only the local API/CDP bridge).
 *
 * Pure URL parse: returns `false` (classic CLI) on any parse failure rather
 * than throwing — a malformed launch URL must not block a classic login.
 */
export function isWorkerServedSpa(pageHref: string): boolean {
  try {
    const url = new URL(pageHref);
    if (url.searchParams.has(BRIDGE_WS_QUERY_PARAM)) return true;
    const host = url.hostname;
    return host !== 'localhost' && host !== '127.0.0.1';
  } catch {
    return false;
  }
}

export function buildAdobeOAuthState(
  input: BuildAdobeOAuthStateInput,
  nonceFactory: () => string
): BuildAdobeOAuthStateResult {
  const workerServed = isWorkerServedSpa(input.pageHref);
  const nonce = nonceFactory();

  if (workerServed) {
    // Worker-served path: redirect_uri MUST be the hardcoded prod relay
    // (the only origin IMS allowlists). Branch state shape on whether the
    // page IS the relay (hosted-leader → opener delivery) or a localhost
    // dev host (wrangler → trampoline via prod relay → local relay's
    // self-origin guard → opener).
    if (input.configuredRedirectUri) {
      let relayOrigin = '';
      try {
        relayOrigin = new URL(input.configuredRedirectUri).origin;
      } catch {
        relayOrigin = '';
      }

      if (relayOrigin && input.pageOrigin === relayOrigin) {
        const oauthState = btoa(
          JSON.stringify({ source: 'opener', path: '/auth/callback', nonce })
        );
        return {
          redirectUri: input.configuredRedirectUri,
          oauthState,
          expectedNonce: nonce,
          source: 'opener',
        };
      }

      let pageUrl: URL | null = null;
      try {
        pageUrl = new URL(input.pageHref);
      } catch {
        pageUrl = null;
      }
      const isLocalhostWithPort =
        pageUrl !== null &&
        pageUrl.protocol === 'http:' &&
        (pageUrl.hostname === 'localhost' || pageUrl.hostname === '127.0.0.1') &&
        pageUrl.port !== '';
      if (isLocalhostWithPort && pageUrl) {
        const port = parseInt(pageUrl.port, 10);
        const oauthState = btoa(
          JSON.stringify({ source: 'local', port, path: '/auth/callback', nonce })
        );
        return {
          redirectUri: input.configuredRedirectUri,
          oauthState,
          expectedNonce: nonce,
          source: 'local',
        };
      }
      // Unknown worker-served topology (configured prod relay present but
      // pageOrigin matches neither relay nor localhost-with-port). Fall
      // through to the degraded same-origin opener path below.
    }

    // Degraded fallback: no configured prod relay (or unknown topology).
    // Pin redirect_uri to the opener's own origin; works only when IMS
    // allowlists that origin, but it never makes the missing config worse.
    const redirectUri = `${input.pageOrigin}/auth/callback`;
    const oauthState = btoa(
      JSON.stringify({
        source: 'opener',
        path: '/auth/callback',
        nonce,
      })
    );
    return { redirectUri, oauthState, expectedNonce: nonce, source: 'opener' };
  }

  // Classic CLI (node-server-served SPA on http://localhost:<port>): unchanged
  // behavior — relay bounces back to the local server's callback page.
  const redirectUri = input.configuredRedirectUri ?? `${input.pageOrigin}/auth/callback`;
  const port = parseInt(new URL(input.pageHref).port || '5710', 10);
  const oauthState = btoa(
    JSON.stringify({
      port,
      path: '/auth/callback',
      nonce,
    })
  );
  return { redirectUri, oauthState, expectedNonce: nonce, source: 'local' };
}
