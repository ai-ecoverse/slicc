import { apiHeaders, getChromeExtensionRealm, resolveApiUrl } from '../base/api-endpoint.js';
import { isProxyError, readProxyErrorMessage } from './proxy-error.js';

export class TrayProxyFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrayProxyFetchError';
  }
}

export function createTrayFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  if (getChromeExtensionRealm()) {
    return (url, init) => fetchImpl(url, init);
  }

  return async (url, init = {}) => {
    const targetUrl = typeof url === 'string' ? url : url.toString();

    try {
      const target = new URL(targetUrl);
      if (target.origin === window.location.origin) {
        return fetchImpl(targetUrl, { ...init, cache: 'no-store' as RequestCache });
      }
    } catch {}

    const headers = new Headers(init.headers);
    headers.set('X-Target-URL', targetUrl);

    for (const [k, v] of Object.entries(apiHeaders())) headers.set(k, v);

    const response = await fetchImpl(resolveApiUrl('/api/fetch-proxy'), {
      ...init,
      headers,
      cache: 'no-store',
    });

    if (isProxyError(response)) {
      throw new TrayProxyFetchError(await readProxyErrorMessage(response));
    }
    return response;
  };
}
