import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { createProxiedFetch } from '../shell/proxied-fetch.js';

let proxiedFetch: ReturnType<typeof createProxiedFetch> | null = null;

function getProxiedFetch() {
  if (!proxiedFetch) {
    proxiedFetch = createProxiedFetch();
  }
  return proxiedFetch;
}

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

export function createGitHttpClient(): HttpClient {
  return {
    request: async (req: GitHttpRequest): Promise<GitHttpResponse> => {
      const { url, method = 'GET', headers = {}, body, onProgress } = req;

      let bodyData: string | undefined;
      if (body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) {
          chunks.push(chunk);
        }

        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }

        let latin1 = '';
        for (let i = 0; i < merged.length; i += 0x8000) {
          latin1 += String.fromCharCode(...merged.subarray(i, i + 0x8000));
        }
        bodyData = latin1;
      }

      const response = await getProxiedFetch()(url, {
        method,
        headers,
        body: bodyData,
      });

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

export const gitHttp = createGitHttpClient();
