/**
 * Custom HTTP client for isomorphic-git that uses the fetch proxy.
 *
 * In CLI mode, routes requests through /api/fetch-proxy to bypass CORS.
 * In extension mode, uses direct fetch (host_permissions grant CORS bypass).
 */

import type { HttpClient, GitHttpRequest, GitHttpResponse } from 'isomorphic-git';

/**
 * Detect if running as a Chrome extension.
 */
function isExtension(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

/**
 * Create an HTTP client for isomorphic-git that handles CORS.
 */
export function createGitHttpClient(): HttpClient {
  return {
    request: async (req: GitHttpRequest): Promise<GitHttpResponse> => {
      const { url, method = 'GET', headers = {}, body, onProgress } = req;

      // Collect body if it's an async iterator
      let bodyData: Uint8Array | undefined;
      if (body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) {
          chunks.push(chunk);
        }
        // Concatenate chunks
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        bodyData = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          bodyData.set(chunk, offset);
          offset += chunk.length;
        }
      }

      let response: Response;

      // Convert Uint8Array to Blob for fetch body (TypeScript compatibility)
      const contentType = headers['content-type'] ?? 'application/octet-stream';
      const fetchBody = bodyData
        ? new Blob([bodyData.buffer as ArrayBuffer], { type: contentType })
        : undefined;

      if (isExtension()) {
        // Extension mode — direct fetch with host_permissions
        response = await fetch(url, {
          method,
          headers,
          body: fetchBody,
        });
      } else {
        // CLI mode — proxy through /api/fetch-proxy
        const proxyHeaders: Record<string, string> = {
          ...headers,
          'X-Target-URL': url,
        };

        // Git protocol uses specific content types
        if (headers['content-type']) {
          proxyHeaders['Content-Type'] = headers['content-type'];
        }

        response = await fetch('/api/fetch-proxy', {
          method,
          headers: proxyHeaders,
          body: fetchBody,
        });

        // Check for proxy errors
        if (response.status === 502 || response.status === 400) {
          const errorText = await response.text();
          let errorMsg = `Proxy error ${response.status}`;
          try {
            errorMsg = JSON.parse(errorText).error ?? errorMsg;
          } catch {
            // Not JSON
          }
          throw new Error(errorMsg);
        }
      }

      // Convert response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Create async iterator for response body
      const responseBody = response.body;
      let bodyIterator: AsyncIterableIterator<Uint8Array> | undefined;

      if (responseBody) {
        const reader = responseBody.getReader();
        let totalLoaded = 0;

        bodyIterator = {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next(): Promise<IteratorResult<Uint8Array>> {
            const { done, value } = await reader.read();
            if (done) {
              return { done: true, value: undefined };
            }
            totalLoaded += value.length;
            if (onProgress) {
              onProgress({
                phase: 'Receiving',
                loaded: totalLoaded,
                total: parseInt(responseHeaders['content-length'] ?? '0', 10) || totalLoaded,
              });
            }
            return { done: false, value };
          },
        };
      }

      return {
        url: response.url || url,
        method,
        headers: responseHeaders,
        body: bodyIterator,
        statusCode: response.status,
        statusMessage: response.statusText,
      };
    },
  };
}

/**
 * Singleton HTTP client instance.
 */
export const gitHttp = createGitHttpClient();
