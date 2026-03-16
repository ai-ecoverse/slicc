/**
 * HTTP client for DA (Document Authoring) API requests.
 *
 * In CLI mode, routes requests through /api/fetch-proxy to bypass CORS.
 * In extension mode, uses direct fetch (host_permissions grant CORS bypass).
 * Follows the same pattern as git-http.ts.
 */

/**
 * Detect if running as a Chrome extension.
 */
function isExtension(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

/**
 * Fetch wrapper that handles CLI proxy vs extension direct fetch.
 * All DA API calls should go through this.
 */
export async function daFetch(url: string, options?: RequestInit): Promise<Response> {
  if (isExtension()) {
    return fetch(url, options);
  }

  // CLI mode — proxy through /api/fetch-proxy
  const headers: Record<string, string> = {};
  const srcHeaders = options?.headers;
  if (srcHeaders) {
    if (srcHeaders instanceof Headers) {
      srcHeaders.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(srcHeaders)) {
      for (const [k, v] of srcHeaders) { headers[k] = v; }
    } else {
      Object.assign(headers, srcHeaders);
    }
  }
  headers['X-Target-URL'] = url;

  const proxyOpts: RequestInit = {
    ...options,
    headers,
    cache: 'no-store',
  };

  // For FormData bodies, browser sets boundary — don't override Content-Type
  if (options?.body instanceof FormData) {
    delete (proxyOpts.headers as Record<string, string>)['Content-Type'];
  }

  const resp = await fetch('/api/fetch-proxy', proxyOpts);

  // Check for proxy errors
  if (resp.status === 502 || resp.status === 400) {
    const errorText = await resp.text();
    let errorMsg = `Proxy error ${resp.status}`;
    try { errorMsg = JSON.parse(errorText).error ?? errorMsg; } catch { /* not JSON */ }
    throw new Error(errorMsg);
  }

  return resp;
}
