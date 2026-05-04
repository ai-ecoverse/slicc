/**
 * proxy-headers — pure helpers for the `/api/fetch-proxy` forbidden-header
 * transport.
 *
 * The browser silently strips a small set of "forbidden" request headers
 * (Cookie, Origin, Referer, Proxy-*) when calling `fetch()` from page code.
 * The proxy server restores them by reading `X-Proxy-*` headers we send in
 * their place. Likewise, `Set-Cookie` is stripped from response headers,
 * so the proxy bundles all `Set-Cookie` values into a JSON-encoded
 * `X-Proxy-Set-Cookie` header that the browser can read.
 *
 * Extracted from `proxied-fetch.ts` so the LLM-proxy service worker can
 * reuse them — the SW build is a standalone IIFE bundle and can't import
 * the shell-side `proxied-fetch` module which pulls in a much larger graph.
 */

/**
 * Encode request headers that browsers silently strip (forbidden headers).
 * Cookie → X-Proxy-Cookie, Origin → X-Proxy-Origin, Referer → X-Proxy-Referer, Proxy-* → X-Proxy-Proxy-*
 */
export function encodeForbiddenRequestHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie') {
      result['X-Proxy-Cookie'] = value;
    } else if (lower === 'origin') {
      result['X-Proxy-Origin'] = value;
    } else if (lower === 'referer') {
      result['X-Proxy-Referer'] = value;
    } else if (lower.startsWith('proxy-')) {
      result[`X-Proxy-${key}`] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decode response headers that the proxy transported under non-forbidden names.
 * X-Proxy-Set-Cookie (JSON array) → set-cookie (JSON array string)
 */
export function decodeForbiddenResponseHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'x-proxy-set-cookie') {
      // Value is a JSON array of Set-Cookie strings from the proxy.
      // Keep as JSON array string since Record<string,string> can only hold one value.
      result['set-cookie'] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Convert Headers or Record<string, string> to a plain Record<string, string>. */
export function headersToRecord(
  headers: Record<string, string> | Headers | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const rec: Record<string, string> = {};
    headers.forEach((v, k) => {
      rec[k] = v;
    });
    return rec;
  }
  return headers;
}
