/**
 * Tests for git-http client routing through createProxiedFetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGitHttpClient } from '../../src/git/git-http.js';
import type { GitHttpRequest } from 'isomorphic-git';

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
      // Arrange: No chrome runtime (CLI mode)
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

      // Act
      const resp = await client.request(req);

      // Assert
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
      // Note: Extension Port-based routing is tested comprehensively in
      // packages/webapp/tests/shell/proxied-fetch.test.ts. This file
      // tests the isomorphic-git adapter layer, which is transport-agnostic.
      // The CLI test above verifies the core git-http.ts logic works correctly.
      expect(true).toBe(true);
    });

    it('returns response with AsyncIterableIterator body', async () => {
      // Arrange: CLI mode
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

      // Act
      const resp = await client.request(req);

      // Assert
      expect(resp.body).toBeDefined();
      expect(typeof resp.body![Symbol.asyncIterator]).toBe('function');

      // Consume body
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
