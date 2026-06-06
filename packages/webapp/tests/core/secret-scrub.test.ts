import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getIdentityToolResultScrubber,
  getToolResultScrubber,
} from '../../src/core/secret-scrub.js';

describe('secret-scrub.getToolResultScrubber', () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;

  beforeEach(() => {
    // Default: no chrome → CLI/fetch branch.
    delete (globalThis as any).chrome;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalChrome !== undefined) {
      (globalThis as any).chrome = originalChrome;
    } else {
      delete (globalThis as any).chrome;
    }
  });

  describe('CLI / node-server branch', () => {
    it('POSTs to /api/secrets/scrub and returns the scrubbed text', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        return new Response(JSON.stringify({ text: body.text.replace('ghp_real', 'ghp_MASK') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const scrub = getToolResultScrubber();
      const out = await scrub('hello ghp_real world');
      expect(out).toBe('hello ghp_MASK world');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/secrets/scrub',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('skips the RPC for empty input', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const scrub = getToolResultScrubber();
      expect(await scrub('')).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the input unchanged when the endpoint is unavailable', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch;
      const scrub = getToolResultScrubber();
      expect(await scrub('untouched')).toBe('untouched');
    });

    it('returns the input unchanged on non-ok status', async () => {
      globalThis.fetch = vi.fn(
        async () => new Response('nope', { status: 500 })
      ) as unknown as typeof fetch;
      const scrub = getToolResultScrubber();
      expect(await scrub('untouched')).toBe('untouched');
    });

    it('is idempotent for already-masked input (server returns the same text)', async () => {
      const fetchMock = vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response((init?.body as string) ?? '{"text":""}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const scrub = getToolResultScrubber();
      const masked = 'ghp_MASKED____';
      expect(await scrub(masked)).toBe(masked);
      expect(await scrub(masked)).toBe(masked);
    });
  });

  describe('extension branch', () => {
    it('uses chrome.runtime.sendMessage and returns scrubbed text', async () => {
      const sendMessage = vi.fn((_msg: any, cb: (resp: unknown) => void) => {
        cb({ text: 'scrubbed: x' });
      });
      (globalThis as any).chrome = {
        runtime: { id: 'abc', sendMessage },
      };
      const scrub = getToolResultScrubber();
      const out = await scrub('input');
      expect(out).toBe('scrubbed: x');
      expect(sendMessage).toHaveBeenCalledWith(
        { type: 'secrets.scrub-tool-result', text: 'input' },
        expect.any(Function)
      );
    });

    it('returns input unchanged when SW responds with error', async () => {
      const sendMessage = vi.fn((_msg: any, cb: (resp: unknown) => void) => {
        cb({ text: 'input', error: 'boom' });
      });
      (globalThis as any).chrome = {
        runtime: { id: 'abc', sendMessage },
      };
      const scrub = getToolResultScrubber();
      expect(await scrub('input')).toBe('input');
    });

    it('returns input unchanged when sendMessage throws', async () => {
      const sendMessage = vi.fn(() => {
        throw new Error('disconnected');
      });
      (globalThis as any).chrome = {
        runtime: { id: 'abc', sendMessage },
      };
      const scrub = getToolResultScrubber();
      expect(await scrub('input')).toBe('input');
    });

    it('returns input unchanged when SW response is malformed', async () => {
      const sendMessage = vi.fn((_msg: any, cb: (resp: unknown) => void) => {
        cb({});
      });
      (globalThis as any).chrome = {
        runtime: { id: 'abc', sendMessage },
      };
      const scrub = getToolResultScrubber();
      expect(await scrub('input')).toBe('input');
    });
  });
});

describe('secret-scrub.getIdentityToolResultScrubber', () => {
  it('returns input unchanged', async () => {
    const scrub = getIdentityToolResultScrubber();
    expect(await scrub('anything')).toBe('anything');
    expect(await scrub('')).toBe('');
  });
});
