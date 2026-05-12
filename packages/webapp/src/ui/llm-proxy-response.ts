/**
 * Synthesizes the Response that `llm-proxy-sw.ts`'s
 * `forwardThroughProxy()` hands back to `event.respondWith()`.
 *
 * Extracted from the SW so it can be unit-tested without standing up
 * the full ServiceWorkerGlobalScope. The SW bundle itself stays an
 * IIFE — this module is only imported by tests.
 *
 * Why a wrapper instead of returning the proxy fetch directly: when
 * the intercepted request is an ESM module load, the browser uses
 * `response.url` as the base URL for resolving relative sub-imports.
 * A raw `fetch('/api/fetch-proxy')` Response carries
 * `response.url = 'http://localhost:5710/api/fetch-proxy'`, so a
 * body containing `import './x.mjs'` ends up at
 * `http://localhost:5710/x.mjs` (SPA fallback → text/html → MIME
 * error). Synthetic Responses have no own URL, and the SW contract
 * surfaces them as the original request URL so relative imports
 * route back at the cross-origin host.
 */

export function synthesizeForwardResponse(proxyResponse: Response): Response {
  return new Response(proxyResponse.body, {
    status: proxyResponse.status,
    statusText: proxyResponse.statusText,
    headers: proxyResponse.headers,
  });
}
