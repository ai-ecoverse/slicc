/**
 * Fetch factory for the tray-hub leader handshake and control-plane calls
 * (`scoops/tray-leader.ts`'s `LeaderTrayManager`).
 *
 * Lives in `shell/` — not `scoops/` — because this is where a float's
 * topology is decided (#2276, review-patterns category 10): `scoops/` asks
 * for a fetch implementation and gets one, it never asks "am I in the
 * extension?" itself. A sibling of `proxied-fetch.ts` rather than folded
 * into it: both share the realm-probe/proxy-header machinery below, but the
 * tray transport has its own error contract (`TrayProxyFetchError`, not
 * `SecureFetch`'s), and keeping this a separate, small module means nothing
 * that only needs the tray transport drags in `proxied-fetch.ts`'s larger
 * `SecureFetch` surface (binary-cache, progress observers, forbidden-header
 * codecs) it never uses.
 */

import { apiHeaders, getChromeExtensionRealm, resolveApiUrl } from '../base/api-endpoint.js';
import { isProxyError, readProxyErrorMessage } from './proxy-error.js';

/**
 * Thrown by {@link createTrayFetch} when the node-server `/api/fetch-proxy`
 * itself failed to reach the tray worker (a tagged proxy/transport error, not a
 * real upstream HTTP status). Typed so `scoops/tray-leader.ts`'s
 * `shouldRecreateTray` can recognise it and mint a fresh tray instead of
 * leaving the leader inactive — a dead stored tray surfaces here as "Proxy
 * fetch failed", not as a `LeaderTrayHttpError`.
 */
export class TrayProxyFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrayProxyFetchError';
  }
}

/**
 * Build the tray-hub fetch: raw fetch in the real extension realm (CORS
 * bypass via `host_permissions`), proxied through `/api/fetch-proxy`
 * everywhere else. `getChromeExtensionRealm()` reads the realm's cached
 * answer (`base/api-endpoint.ts`) rather than probing directly — the same
 * fact `createProxiedFetch` asks, resolved once per realm.
 */
export function createTrayFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  if (getChromeExtensionRealm()) {
    // Wrap so calling `this.fetchImpl(...)` doesn't rebind `this` to the
    // LeaderTrayManager instance and trigger "Illegal invocation" against
    // the global fetch.
    return (url, init) => fetchImpl(url, init);
  }

  return async (url, init = {}) => {
    const targetUrl = typeof url === 'string' ? url : url.toString();

    // Skip the proxy for same-origin requests (e.g. when served from the worker)
    try {
      const target = new URL(targetUrl);
      if (target.origin === window.location.origin) {
        return fetchImpl(targetUrl, { ...init, cache: 'no-store' as RequestCache });
      }
    } catch {
      // If URL parsing fails, fall through to proxy
    }

    const headers = new Headers(init.headers);
    headers.set('X-Target-URL', targetUrl);
    // Thin-bridge mode (UI hosted, /api on the local node-server) requires
    // the per-process bridge token on cross-origin /api/* calls; same-origin
    // / loopback returns an empty record so the legacy path is unchanged.
    for (const [k, v] of Object.entries(apiHeaders())) headers.set(k, v);

    const response = await fetchImpl(resolveApiUrl('/api/fetch-proxy'), {
      ...init,
      headers,
      cache: 'no-store',
    });
    // Only treat as proxy infrastructure failure when the proxy tagged it.
    // Upstream 4xx/5xx (e.g. tray-worker auth/quotas) must flow through.
    if (isProxyError(response)) {
      throw new TrayProxyFetchError(await readProxyErrorMessage(response));
    }
    return response;
  };
}
