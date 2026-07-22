/**
 * Tests for the fail-closed known-secret batch redactor client.
 *
 * Every error path throws TranscriptExportError('redaction-unavailable').
 * This is the strict counterpart of getToolResultScrubber() which is fail-open.
 */
import { TranscriptExportError } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callSecretsBridge } from '../../src/core/secrets-bridge-client.js';
import {
  setBridgeToken,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../../src/shell/proxied-fetch.js';
import { getStrictKnownSecretRedactor } from '../../src/transcript/strict-secret-client.js';

vi.mock('../../src/core/secrets-bridge-client.js', () => ({
  callSecretsBridge: vi.fn(),
}));

const TEXTS = ['hello world', 'foo bar'];
const REDACTED = ['hello ⟦REDACTED:known-secret:k1⟧', 'foo ⟦REDACTED:known-secret:k1⟧'];

describe('getStrictKnownSecretRedactor — node-rest branch', () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as any).chrome;

  beforeEach(() => {
    delete (globalThis as any).chrome;
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    setExtensionDelegateId(null);
    vi.mocked(callSecretsBridge).mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalChrome !== undefined) {
      (globalThis as any).chrome = originalChrome;
    } else {
      delete (globalThis as any).chrome;
    }
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    setExtensionDelegateId(null);
  });

  it('POSTs to /api/secrets/redact-export and returns redacted texts', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ texts: REDACTED, redactionCount: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    const result = await redactor.redact(TEXTS);
    expect(result).toEqual(REDACTED);
  });

  it('throws redaction-unavailable on non-2xx response', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'redaction-unavailable' }), { status: 503 })
    ) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable when fetch throws (network failure)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable on array-length mismatch', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ texts: ['only-one'], redactionCount: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    // TEXTS has 2 items but response has 1
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable on malformed response (texts not array)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ texts: 'not-an-array', redactionCount: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('does not echo input texts in the thrown error', async () => {
    const sensitiveText = 'my-super-secret-real-token-value';
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'redaction-unavailable' }), { status: 503 })
    ) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    let caught: unknown;
    try {
      await redactor.redact([sensitiveText]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught)).not.toContain(sensitiveText);
  });

  it('uses absolute URL and X-Bridge-Token in thin-bridge mode', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('tok-xyz');

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ texts: REDACTED, redactionCount: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const redactor = getStrictKnownSecretRedactor();
    await redactor.redact(TEXTS);
    expect(capturedUrl).toBe('http://localhost:5710/api/secrets/redact-export');
    expect(capturedHeaders?.['X-Bridge-Token']).toBe('tok-xyz');
  });
});

describe('getStrictKnownSecretRedactor — connect topology', () => {
  let originalConnectMode: unknown;

  beforeEach(() => {
    delete (globalThis as any).chrome;
    setExtensionDelegateId(null);
    originalConnectMode = (globalThis as Record<string, unknown>).__slicc_connect_mode;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).__slicc_connect_mode = originalConnectMode;
    setExtensionDelegateId(null);
  });

  it('throws redaction-unavailable immediately (connect has no secret pipeline)', async () => {
    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });
});

describe('getStrictKnownSecretRedactor — extension-direct branch', () => {
  const originalChrome = (globalThis as any).chrome;

  beforeEach(() => {
    setExtensionDelegateId(null);
    (globalThis as any).chrome = {
      runtime: { id: 'test-ext-id' },
    };
  });

  afterEach(() => {
    if (originalChrome !== undefined) {
      (globalThis as any).chrome = originalChrome;
    } else {
      delete (globalThis as any).chrome;
    }
    setExtensionDelegateId(null);
  });

  it('sends secrets.redact-export via chrome.runtime.sendMessage and returns texts', async () => {
    (globalThis as any).chrome.runtime.sendMessage = vi.fn(
      (_msg: unknown, cb: (resp: unknown) => void) => {
        cb({ texts: REDACTED, redactionCount: 2 });
      }
    );

    const redactor = getStrictKnownSecretRedactor();
    const result = await redactor.redact(TEXTS);
    expect(result).toEqual(REDACTED);
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'secrets.redact-export', texts: TEXTS },
      expect.any(Function)
    );
  });

  it('throws redaction-unavailable when SW responds with error', async () => {
    (globalThis as any).chrome.runtime.sendMessage = vi.fn(
      (_msg: unknown, cb: (resp: unknown) => void) => {
        cb({ error: 'redaction-unavailable' });
      }
    );

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable on array-length mismatch from SW', async () => {
    (globalThis as any).chrome.runtime.sendMessage = vi.fn(
      (_msg: unknown, cb: (resp: unknown) => void) => {
        cb({ texts: ['only-one'], redactionCount: 1 });
      }
    );

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable when sendMessage throws', async () => {
    (globalThis as any).chrome.runtime.sendMessage = vi.fn(() => {
      throw new Error('disconnected');
    });

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });
});

describe('getStrictKnownSecretRedactor — extension-delegate branch', () => {
  const originalChrome = (globalThis as any).chrome;

  beforeEach(() => {
    delete (globalThis as any).chrome;
    setExtensionDelegateId('delegate-ext-id');
    vi.mocked(callSecretsBridge).mockReset();
  });

  afterEach(() => {
    if (originalChrome !== undefined) {
      (globalThis as any).chrome = originalChrome;
    } else {
      delete (globalThis as any).chrome;
    }
    setExtensionDelegateId(null);
  });

  it('routes through callSecretsBridge and returns redacted texts', async () => {
    vi.mocked(callSecretsBridge).mockResolvedValueOnce({ texts: REDACTED, redactionCount: 2 });

    const redactor = getStrictKnownSecretRedactor();
    const result = await redactor.redact(TEXTS);
    expect(result).toEqual(REDACTED);
    expect(callSecretsBridge).toHaveBeenCalledWith('secrets.redact-export', { texts: TEXTS });
  });

  it('throws redaction-unavailable when bridge returns error', async () => {
    vi.mocked(callSecretsBridge).mockResolvedValueOnce({ error: 'redaction-unavailable' });

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable when bridge resolves undefined (unavailable)', async () => {
    vi.mocked(callSecretsBridge).mockResolvedValueOnce(undefined);

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable on array-length mismatch from bridge', async () => {
    vi.mocked(callSecretsBridge).mockResolvedValueOnce({
      texts: ['only-one'],
      redactionCount: 1,
    });

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable when the bridge call throws', async () => {
    vi.mocked(callSecretsBridge).mockRejectedValueOnce(new Error('timeout'));

    const redactor = getStrictKnownSecretRedactor();
    await expect(redactor.redact(TEXTS)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('does not echo input texts in the thrown error (bridge failure)', async () => {
    const sensitiveText = 'my-super-secret-real-token-value';
    vi.mocked(callSecretsBridge).mockRejectedValueOnce(new Error('timeout'));

    const redactor = getStrictKnownSecretRedactor();
    let caught: unknown;
    try {
      await redactor.redact([sensitiveText]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught)).not.toContain(sensitiveText);
  });
});
