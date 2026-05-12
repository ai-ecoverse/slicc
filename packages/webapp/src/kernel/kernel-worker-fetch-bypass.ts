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
 */

const BYPASS_HEADER = 'x-bypass-llm-proxy';
const BYPASS_VALUE = '1';

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Build a same-origin-aware fetch wrapper around `orig`. The wrapper
 * only stamps `x-bypass-llm-proxy` on requests whose target origin
 * matches `selfOrigin`. Pass `selfOrigin = undefined` (the runtime
 * default in environments without `self.location`) to disable the
 * wrapper entirely — the caller still gets back an inert pass-through.
 */
export function makeSameOriginBypassFetch(orig: FetchFn, selfOrigin: string | undefined): FetchFn {
  if (!selfOrigin) return orig;
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isSameOrigin(input, selfOrigin)) return orig(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has(BYPASS_HEADER)) headers.set(BYPASS_HEADER, BYPASS_VALUE);
    return orig(input, { ...init, headers });
  };
}

/**
 * `true` when `input`'s target URL has the same origin as `selfOrigin`.
 * Relative URLs resolve against `selfOrigin` and count as same-origin.
 * Unparseable inputs default to same-origin so we never silently drop
 * the header on a request that previously worked.
 */
export function isSameOrigin(input: RequestInfo | URL, selfOrigin: string): boolean {
  let urlStr: string;
  if (typeof input === 'string') {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.href;
  } else {
    urlStr = input.url;
  }
  try {
    return new URL(urlStr, selfOrigin).origin === selfOrigin;
  } catch {
    return true;
  }
}
