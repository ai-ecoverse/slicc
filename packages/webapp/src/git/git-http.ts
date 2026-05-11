/**
 * Custom HTTP client for isomorphic-git that uses the fetch proxy.
 *
 * Routes through createProxiedFetch which handles dual-mode routing:
 * - CLI mode: /api/fetch-proxy
 * - Extension mode: Port-based chrome.runtime.connect({name: 'fetch-proxy.fetch'})
 */

import type { HttpClient, GitHttpRequest, GitHttpResponse } from 'isomorphic-git';
import { createProxiedFetch } from '../shell/proxied-fetch.js';

let proxiedFetch: ReturnType<typeof createProxiedFetch> | null = null;

function getProxiedFetch() {
  if (!proxiedFetch) {
    proxiedFetch = createProxiedFetch();
  }
  return proxiedFetch;
}

/**
 * Convert a Uint8Array body to an AsyncIterableIterator for isomorphic-git.
 * Yields a single chunk containing the entire response.
 */
async function* singleChunkIterator(
  data: Uint8Array,
  onProgress?: GitHttpRequest['onProgress'],
  contentLength?: number
): AsyncIterableIterator<Uint8Array> {
  if (onProgress) {
    onProgress({
      phase: 'Receiving',
      loaded: data.length,
      total: contentLength ?? data.length,
    });
  }
  yield data;
}

/**
 * Create an HTTP client for isomorphic-git that routes through createProxiedFetch.
 */
export function createGitHttpClient(): HttpClient {
  return {
    request: async (req: GitHttpRequest): Promise<GitHttpResponse> => {
      const { url, method = 'GET', headers = {}, body, onProgress } = req;

      // Collect body if it's an async iterator
      let bodyData: string | undefined;
      if (body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) {
          chunks.push(chunk);
        }
        // Concatenate chunks
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        // Convert to latin1 string for proxiedFetch
        let latin1 = '';
        for (let i = 0; i < merged.length; i += 0x8000) {
          latin1 += String.fromCharCode(...merged.subarray(i, i + 0x8000));
        }
        bodyData = latin1;
      }

      // Call proxiedFetch (routes correctly in both CLI and extension modes)
      const response = await getProxiedFetch()(url, {
        method,
        headers,
        body: bodyData,
      });

      // Convert body Uint8Array to AsyncIterableIterator for isomorphic-git
      const contentLength = parseInt(response.headers['content-length'] ?? '0', 10) || undefined;
      const bodyIterator = singleChunkIterator(response.body, onProgress, contentLength);

      return {
        url: response.url,
        method,
        headers: response.headers,
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
