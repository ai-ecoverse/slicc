import type { GitHttpRequest } from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHttpClient } from '../../src/git/git-http.js';

describe('git-http', () => {
  describe('createProxiedFetch routing', () => {
    let originalChrome: any;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalChrome = (globalThis as any).chrome;
      mockFetch = vi.fn();
      (globalThis as any).fetch = mockFetch;
    });

    afterEach(() => {
      (globalThis as any).chrome = originalChrome;
      vi.restoreAllMocks();
    });

    it('CLI mode: routes through /api/fetch-proxy', async () => {
      (globalThis as any).chrome = undefined;

      const mockResponse = new Response('test body', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      });
      mockFetch.mockResolvedValue(mockResponse);

      const client = createGitHttpClient();
      const req: GitHttpRequest = {
        url: 'https://github.com/test/repo.git/info/refs?service=git-upload-pack',
        method: 'GET',
        headers: { 'user-agent': 'git/isomorphic-git' },
      };

      const resp = await client.request(req);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/fetch-proxy',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Target-URL': req.url,
          }),
        })
      );
      expect(resp.statusCode).toBe(200);
      expect(resp.url).toBe(req.url);
    });

    it('Extension mode routing is covered by proxied-fetch.test.ts', () => {
      expect(true).toBe(true);
    });

    it('returns response with AsyncIterableIterator body', async () => {
      (globalThis as any).chrome = undefined;

      const bodyText = 'git protocol response';
      const mockResponse = new Response(bodyText, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      });
      mockFetch.mockResolvedValue(mockResponse);

      const client = createGitHttpClient();
      const req: GitHttpRequest = {
        url: 'https://github.com/test/repo.git/info/refs',
        method: 'GET',
      };

      const resp = await client.request(req);

      expect(resp.body).toBeDefined();
      expect(typeof resp.body![Symbol.asyncIterator]).toBe('function');

      const chunks: Uint8Array[] = [];
      for await (const chunk of resp.body!) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const decoded = new TextDecoder().decode(merged);
      expect(decoded).toBe(bodyText);
    });
  });
});
