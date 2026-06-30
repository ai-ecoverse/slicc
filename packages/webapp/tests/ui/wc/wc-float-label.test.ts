// @vitest-environment jsdom
/**
 * Floatbar runtime fingerprinting: /api/status names the serving runtime —
 * the native Sliccstart server vs the Node CLI — and unknown/unreachable
 * keeps the generic standalone label.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBridgeToken, setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import {
  DEFAULT_STANDALONE_LABEL,
  resolveStandaloneFloatLabel,
} from '../../../src/ui/wc/wc-float-label.js';

function okJson(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
}

afterEach(() => {
  setLocalApiBaseUrl(null);
  setBridgeToken(null);
});

describe('resolveStandaloneFloatLabel', () => {
  it('labels the native Sliccstart server', async () => {
    await expect(
      resolveStandaloneFloatLabel({ fetchFn: okJson({ status: 'ok', service: 'slicc-server' }) })
    ).resolves.toBe('sliccstart · live');
  });

  it('labels the Node CLI', async () => {
    await expect(
      resolveStandaloneFloatLabel({
        fetchFn: okJson({ status: 'ok', service: 'slicc-node-server' }),
      })
    ).resolves.toBe('npx · live');
  });

  it('keeps the generic label for unknown services', async () => {
    await expect(
      resolveStandaloneFloatLabel({ fetchFn: okJson({ status: 'ok', service: 'mystery' }) })
    ).resolves.toBe(DEFAULT_STANDALONE_LABEL);
    await expect(resolveStandaloneFloatLabel({ fetchFn: okJson({ status: 'ok' }) })).resolves.toBe(
      DEFAULT_STANDALONE_LABEL
    );
  });

  it('keeps the generic label on a non-OK response', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(resolveStandaloneFloatLabel({ fetchFn })).resolves.toBe(DEFAULT_STANDALONE_LABEL);
  });

  it('keeps the generic label when the probe throws (cherry iframes, old servers)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(resolveStandaloneFloatLabel({ fetchFn })).resolves.toBe(DEFAULT_STANDALONE_LABEL);
  });

  it('aborts a hung probe after the timeout and falls back', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ) as unknown as typeof fetch;
      const pending = resolveStandaloneFloatLabel({ fetchFn, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      await expect(pending).resolves.toBe(DEFAULT_STANDALONE_LABEL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rewrites URL and attaches X-Bridge-Token in thin-bridge mode', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('test-bridge-token');
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ok', service: 'slicc-node-server' }),
    })) as unknown as typeof fetch;

    await resolveStandaloneFloatLabel({ fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:5710/api/status');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Bridge-Token']).toBe('test-bridge-token');
  });
});
