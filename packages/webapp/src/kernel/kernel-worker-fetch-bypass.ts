/**
 * Same-origin fetch wrapper for the kernel worker.
 *
 * Lives in its own module so tests can import the helper without
 * triggering kernel-worker.ts's module-load side effect
 * (`self.addEventListener('message', …)`), which crashes in a node
 * test environment where `self` is undefined.
 *
 * Why this exists: the page registers `/llm-proxy-sw.js` at scope
 * `/`, which intercepts cross-origin fetches and reroutes them
 * through `/api/fetch-proxy`. The SW already short-circuits same-
 * origin requests, so for THOSE the `x-bypass-llm-proxy: 1` header
 * is purely a future-proofing marker. We stamp it on same-origin
 * requests only because adding the header on a cross-origin request
 * turns it into a CORS-preflighted request, and CDNs that lock down
 * `Access-Control-Allow-Headers` (jsdelivr, etc.) reject the
 * preflight outright. Pyodide and ImageMagick both dump CORS errors
 * into the console when that happens, even though their non-
 * streaming fallback eventually completes the load.
 *
 * Cross-origin worker fetches are left bare so the SW can route them
 * through `/api/fetch-proxy`; that costs a server hop for one-time
 * wasm/asset payloads but works uniformly across CDNs and matches
 * the path `proxiedFetch` uses for everything else.
 *
 * Thin-bridge exception: any `/api/*` endpoint on the local node-server
 * is OUR infra, not a third-party CDN, and is reachable cross-origin
 * from a hosted-leader / wrangler-served UI. When the worker realm calls
 * these endpoints directly (e.g. `/api/fetch-proxy`, `/api/da-sign-and-forward`,
 * `/api/s3-sign-and-forward`) we must stamp the bypass header so the
 * page-installed SW skips re-interception — re-proxying strips
 * `X-Bridge-Token` and causes the node-server's CORS gate to reject with
 * `bridge-token-required`. The bridge already handles the resulting CORS
 * preflight via `createThinBridgeCorsMiddleware`, so the CDN-preflight
 * rationale above doesn't apply. The caller wires `getBridgeProxyOrigin`
 * to `() => getLocalApiBaseUrl()`-derived origin so the check stays
 * dynamic (the bridge origin is set AFTER `installFetchBypass` runs).
 */

const BYPASS_HEADER = 'x-bypass-llm-proxy';
const BYPASS_VALUE = '1';

// Track the global `fetch` signature so the wrapper composes
// transparently and stays in lockstep with lib.dom updates.
export type FetchFn = typeof fetch;

/**
 * Lazy lookup for the known bridge origin (e.g. `http://localhost:5710`).
 * Returns `null` outside thin-bridge mode. Called per-request so the
 * wrapper picks up the bridge config the boot path sets AFTER
 * `installFetchBypass` runs.
 */
export type BridgeProxyOriginGetter = () => string | null;

/**
 * Build a same-origin-aware fetch wrapper around `orig`. The wrapper
 * stamps `x-bypass-llm-proxy` on requests whose target origin matches
 * `selfOrigin`, plus — when `getBridgeProxyOrigin` is supplied and
 * resolves to an origin — on calls to that origin's own `/api/fetch-proxy`
 * (the worker realm's thin-bridge proxied-fetch target). Pass
 * `selfOrigin = undefined` (the runtime default in environments without
 * `self.location`) to disable the wrapper entirely — the caller still
 * gets back an inert pass-through.
 */
export function makeSameOriginBypassFetch(
  orig: FetchFn,
  selfOrigin: string | undefined,
  getBridgeProxyOrigin?: BridgeProxyOriginGetter
): FetchFn {
  if (!selfOrigin) return orig;
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!shouldStampBypass(input, selfOrigin, getBridgeProxyOrigin)) {
      return orig(input, init);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has(BYPASS_HEADER)) headers.set(BYPASS_HEADER, BYPASS_VALUE);
    return orig(input, { ...init, headers });
  };
}

/**
 * Decide whether to stamp the bypass header. Same-origin always stamps;
 * the known bridge `/api/fetch-proxy` endpoint stamps even cross-origin.
 * Everything else passes through bare.
 */
function shouldStampBypass(
  input: RequestInfo | URL,
  selfOrigin: string,
  getBridgeProxyOrigin: BridgeProxyOriginGetter | undefined
): boolean {
  if (isSameOrigin(input, selfOrigin)) return true;
  const bridgeOrigin = getBridgeProxyOrigin?.() ?? null;
  if (!bridgeOrigin) return false;
  return isBridgeLocalApiTarget(input, bridgeOrigin, selfOrigin);
}

/**
 * `true` when `input`'s target URL is any `/api/*` endpoint on the bridge
 * origin (origin + `/api/` prefix match). Covers `/api/fetch-proxy`,
 * `/api/da-sign-and-forward`, `/api/s3-sign-and-forward`, etc. — all direct
 * calls to the local node-server's API surface that already carry
 * `X-Bridge-Token` via `apiHeaders()` and must NOT be re-routed through the
 * LLM proxy SW's fetch-proxy chain (which would strip the token).
 * Unparseable inputs return `false`.
 */
export function isBridgeLocalApiTarget(
  input: RequestInfo | URL,
  bridgeOrigin: string,
  selfOrigin: string
): boolean {
  const urlStr = inputUrlString(input);
  let target: URL;
  let bridge: URL;
  try {
    target = new URL(urlStr, selfOrigin);
    bridge = new URL(bridgeOrigin);
  } catch {
    return false;
  }
  return target.origin === bridge.origin && target.pathname.startsWith('/api/');
}

/**
 * `true` when `input`'s target URL has the same origin as `selfOrigin`.
 * Relative URLs resolve against `selfOrigin` and count as same-origin.
 * Unparseable inputs default to same-origin so we never silently drop
 * the header on a request that previously worked.
 */
export function isSameOrigin(input: RequestInfo | URL, selfOrigin: string): boolean {
  const urlStr = inputUrlString(input);
  try {
    return new URL(urlStr, selfOrigin).origin === selfOrigin;
  } catch {
    return true;
  }
}

/** Extract the URL string from any `fetch()` first-arg shape. */
function inputUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
