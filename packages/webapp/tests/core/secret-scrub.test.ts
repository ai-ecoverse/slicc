import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getIdentityToolResultScrubber,
  getToolResultScrubber,
} from '../../src/core/secret-scrub.js';
import { callSecretsBridge } from '../../src/core/secrets-bridge-client.js';
import {
  setBridgeToken,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../../src/shell/proxied-fetch.js';

// The extension-delegate (thin-bridge) topology routes the scrub over the
// secrets.crud Port; mock that transport so we can assert the call site uses it
// instead of REST.
vi.mock('../../src/core/secrets-bridge-client.js', () => ({
  callSecretsBridge: vi.fn(),
}));

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

  describe('extension-delegate branch', () => {
    beforeEach(() => {
      delete (globalThis as any).chrome;
      setExtensionDelegateId('delegate-id');
      vi.mocked(callSecretsBridge).mockReset();
    });

    afterEach(() => {
      setExtensionDelegateId(null);
    });

    it('routes the scrub through callSecretsBridge (not REST)', async () => {
      vi.mocked(callSecretsBridge).mockResolvedValueOnce({ text: 'scrubbed: y' });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const scrub = getToolResultScrubber();
      const out = await scrub('input');
      expect(out).toBe('scrubbed: y');
      expect(callSecretsBridge).toHaveBeenCalledWith('secrets.scrub-tool-result', {
        text: 'input',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns input unchanged when the bridge returns an error', async () => {
      vi.mocked(callSecretsBridge).mockResolvedValueOnce({ text: 'input', error: 'boom' });
      const scrub = getToolResultScrubber();
      expect(await scrub('input')).toBe('input');
    });

    it('returns input unchanged when the bridge is unavailable (undefined)', async () => {
      vi.mocked(callSecretsBridge).mockResolvedValueOnce(undefined);
      const scrub = getToolResultScrubber();
      expect(await scrub('input')).toBe('input');
    });
  });

  describe('connect branch', () => {
    let originalConnectMode: unknown;

    beforeEach(() => {
      delete (globalThis as any).chrome;
      setExtensionDelegateId(null);
      vi.mocked(callSecretsBridge).mockReset();
      originalConnectMode = (globalThis as Record<string, unknown>).__slicc_connect_mode;
      (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    });

    afterEach(() => {
      (globalThis as Record<string, unknown>).__slicc_connect_mode = originalConnectMode;
    });

    it('is an identity scrub (no REST, no bridge)', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const scrub = getToolResultScrubber();
      expect(await scrub('untouched')).toBe('untouched');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(callSecretsBridge).not.toHaveBeenCalled();
    });
  });
});

describe('secret-scrub.getToolResultScrubber — thin-bridge URL + token', () => {
  // Mirrors signed-fetch / http-broker / transformers-env: cover legacy
  // same-origin + the three thin-bridge cases so the `apiHeaders` /
  // `resolveApiUrl` wiring at the call site can't silently regress.
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;

  beforeEach(() => {
    // Default: no chrome → CLI/fetch branch (the thin-bridge surface).
    delete (globalThis as any).chrome;
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  afterEach(() => {
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    globalThis.fetch = originalFetch;
    if (originalChrome !== undefined) {
      (globalThis as any).chrome = originalChrome;
    } else {
      delete (globalThis as any).chrome;
    }
  });

  function captureCall(): {
    getUrl: () => string | null;
    getHeaders: () => Record<string, string> | null;
  } {
    let capturedUrl: string | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? null) as Record<string, string> | null;
      return new Response(JSON.stringify({ text: 'scrubbed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { getUrl: () => capturedUrl, getHeaders: () => capturedHeaders };
  }

  it('legacy / same-origin: POSTs the relative /api/secrets/scrub with no X-Bridge-Token', async () => {
    const cap = captureCall();
    const scrub = getToolResultScrubber();
    await scrub('hello');
    expect(cap.getUrl()).toBe('/api/secrets/scrub');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBeUndefined();
    expect(headers!['content-type']).toBe('application/json');
  });

  it('thin-bridge: POSTs to the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const cap = captureCall();
    const scrub = getToolResultScrubber();
    await scrub('hello');
    expect(cap.getUrl()).toBe('http://localhost:5710/api/secrets/scrub');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBe('abc-123');
    expect(headers!['content-type']).toBe('application/json');
  });

  it('thin-bridge: base set but no token → absolute URL, still no X-Bridge-Token', async () => {
    // apiHeaders attaches the token ONLY when both base AND token are set.
    setLocalApiBaseUrl('http://localhost:5710');
    const cap = captureCall();
    const scrub = getToolResultScrubber();
    await scrub('hello');
    expect(cap.getUrl()).toBe('http://localhost:5710/api/secrets/scrub');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBeUndefined();
  });

  it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
    // Symmetric to the proxied-fetch rule: the token is a cross-origin
    // capability and must not leak on the loopback / bundled-UI path.
    setBridgeToken('abc-123');
    const cap = captureCall();
    const scrub = getToolResultScrubber();
    await scrub('hello');
    expect(cap.getUrl()).toBe('/api/secrets/scrub');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBeUndefined();
  });
});

describe('secret-scrub.getIdentityToolResultScrubber', () => {
  it('returns input unchanged', async () => {
    const scrub = getIdentityToolResultScrubber();
    expect(await scrub('anything')).toBe('anything');
    expect(await scrub('')).toBe('');
  });
});
