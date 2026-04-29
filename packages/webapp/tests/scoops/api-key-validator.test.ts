import { describe, it, expect, vi } from 'vitest';
import { validateApiKey, __test__ } from '../../src/scoops/api-key-validator.js';

function fakeFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return await impl(String(input), init ?? {});
  }) as unknown as typeof fetch;
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('validateApiKey', () => {
  it('rejects an empty key without making any network call', async () => {
    const fetchSpy = vi.fn();
    const result = await validateApiKey({
      provider: 'openai',
      apiKey: '   ',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result.kind).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips validation for unknown providers (no network call either)', async () => {
    const fetchSpy = vi.fn();
    const result = await validateApiKey({
      provider: 'totally-made-up-provider',
      apiKey: 'sk-xxx',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result.kind).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok when the provider returns 200', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('https://api.openai.com/v1/models');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-good');
      return jsonResp(200, { data: [] });
    });
    const result = await validateApiKey({
      provider: 'openai',
      apiKey: 'sk-good',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('returns failed with a friendly message on 401', async () => {
    const fetchImpl = fakeFetch(() => jsonResp(401, { error: { message: 'Invalid API key' } }));
    const result = await validateApiKey({
      provider: 'anthropic',
      apiKey: 'bad',
      fetchImpl,
    });
    expect(result.kind).toBe('failed');
    expect((result as { status: number }).status).toBe(401);
    expect((result as { message: string }).message.toLowerCase()).toContain('authentication');
  });

  it('sends Anthropic-specific headers on the probe', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      const h = init.headers as Record<string, string>;
      expect(h['x-api-key']).toBe('sk-ant-xxx');
      expect(h['anthropic-version']).toBeTruthy();
      return jsonResp(200, { data: [] });
    });
    await validateApiKey({ provider: 'anthropic', apiKey: 'sk-ant-xxx', fetchImpl });
  });

  it('passes Google keys via query string instead of headers', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toContain('key=AIzaSy');
      expect(init.headers ?? {}).toEqual({});
      return jsonResp(200, {});
    });
    await validateApiKey({
      provider: 'google',
      apiKey: 'AIzaSy_real_key',
      fetchImpl,
    });
  });

  it('honours an explicit baseUrl override', async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url.startsWith('https://my.proxy/openai')).toBe(true);
      return jsonResp(200, {});
    });
    await validateApiKey({
      provider: 'openai',
      apiKey: 'sk-x',
      baseUrl: 'https://my.proxy/openai',
      fetchImpl,
    });
  });

  it('reports a skip when the request itself fails (CORS / offline)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const result = await validateApiKey({
      provider: 'openai',
      apiKey: 'sk-x',
      fetchImpl,
    });
    expect(result.kind).toBe('skipped');
  });

  it('propagates an AbortError so callers can cancel cleanly', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    ctrl.abort();
    await expect(
      validateApiKey({
        provider: 'openai',
        apiKey: 'sk',
        fetchImpl,
        signal: ctrl.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exposes a probe table for every advertised provider', () => {
    for (const id of ['openai', 'anthropic', 'google', 'groq']) {
      expect(__test__.PROBES[id]).toBeDefined();
      expect(typeof __test__.PROBES[id].url).toBe('function');
    }
  });
});
