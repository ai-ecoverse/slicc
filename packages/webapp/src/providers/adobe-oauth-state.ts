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
 *     cloudflare-worker (`https://www.sliccy.ai`, or `http://localhost:8787`
 *     in `wrangler dev`). Routing back through localhost would self-loop the
 *     relay (or worse, fail because no local callback exists). Instead the
 *     relay delivers the callback URL straight to `window.opener` via
 *     `postMessage` — `state.source: 'opener'`, redirect_uri pinned to the
 *     opener's own origin.
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
    return new URL(pageHref).searchParams.has(BRIDGE_WS_QUERY_PARAM);
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
    // Worker-served: opener is same-origin as the relay. Bypass the
    // (cross-origin, prod) `configuredRedirectUri` — IMS would redirect to a
    // different host than the opener, and the relay can't postMessage back
    // across that origin boundary. Pin redirect_uri to the opener's origin.
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
