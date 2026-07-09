import { describe, expect, it, vi } from 'vitest';
import {
  contentTypeOk,
  type ProbeFetch,
  type ProbeResponse,
  probeWellKnown,
} from '../../src/net/well-known-probe.js';

function res(status: number, contentType: string | null): ProbeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
  };
}

/** Build a fetch stub keyed by URL suffix. Unlisted URLs 404. */
function stubFetch(map: Record<string, ProbeResponse>): ProbeFetch {
  return vi.fn(async (url: string) => {
    for (const [suffix, r] of Object.entries(map)) {
      if (url.endsWith(suffix)) return r;
    }
    return res(404, null);
  });
}

describe('probeWellKnown', () => {
  it('returns both artifacts when both answer 200 with plausible content-types', async () => {
    const fetchImpl = stubFetch({
      '/.well-known/ai-catalog.json': res(200, 'application/json'),
      '/llms.txt': res(200, 'text/plain; charset=utf-8'),
    });
    const matches = await probeWellKnown('https://example.com', fetchImpl);
    expect(matches).toEqual([
      { kind: 'ai-catalog', url: 'https://example.com/.well-known/ai-catalog.json' },
      { kind: 'llms-txt', url: 'https://example.com/llms.txt' },
    ]);
  });

  it('normalizes the origin (strips path) before probing', async () => {
    const fetchImpl = stubFetch({
      '/.well-known/ai-catalog.json': res(200, 'application/json'),
    });
    const matches = await probeWellKnown('https://example.com/deep/page?x=1', fetchImpl);
    expect(matches).toEqual([
      { kind: 'ai-catalog', url: 'https://example.com/.well-known/ai-catalog.json' },
    ]);
  });

  it('skips a 404 artifact and keeps the one that answered', async () => {
    const fetchImpl = stubFetch({ '/llms.txt': res(200, 'text/markdown') });
    const matches = await probeWellKnown('https://example.com', fetchImpl);
    expect(matches).toEqual([{ kind: 'llms-txt', url: 'https://example.com/llms.txt' }]);
  });

  it('rejects a 204 No Content response (requires an exact 200)', async () => {
    const fetchImpl = stubFetch({ '/.well-known/ai-catalog.json': res(204, 'application/json') });
    expect(await probeWellKnown('https://example.com', fetchImpl)).toEqual([]);
  });

  it('rejects a 206 Partial Content response (requires an exact 200)', async () => {
    const fetchImpl = stubFetch({ '/llms.txt': res(206, 'text/plain') });
    expect(await probeWellKnown('https://example.com', fetchImpl)).toEqual([]);
  });

  it('rejects a manifest served as HTML', async () => {
    const fetchImpl = stubFetch({
      '/.well-known/ai-catalog.json': res(200, 'text/html'),
    });
    expect(await probeWellKnown('https://example.com', fetchImpl)).toEqual([]);
  });

  it('accepts a missing content-type (lenient)', async () => {
    const fetchImpl = stubFetch({ '/.well-known/ai-catalog.json': res(200, null) });
    const matches = await probeWellKnown('https://example.com', fetchImpl);
    expect(matches.map((m) => m.kind)).toEqual(['ai-catalog']);
  });

  it('treats a fetch rejection as no match (never throws)', async () => {
    const fetchImpl: ProbeFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await probeWellKnown('https://example.com', fetchImpl)).toEqual([]);
  });

  it('returns [] for an unparseable origin', async () => {
    const fetchImpl = vi.fn();
    expect(await probeWellKnown('not a url', fetchImpl as unknown as ProbeFetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes an abort signal to fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return res(404, null);
    });
    await probeWellKnown('https://example.com', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('contentTypeOk', () => {
  it('accepts json / text / octet-stream for ai-catalog, rejects html', () => {
    expect(contentTypeOk('application/json', 'ai-catalog')).toBe(true);
    expect(contentTypeOk('application/ld+json', 'ai-catalog')).toBe(true);
    expect(contentTypeOk('text/plain', 'ai-catalog')).toBe(true);
    expect(contentTypeOk('application/octet-stream', 'ai-catalog')).toBe(true);
    expect(contentTypeOk('text/html; charset=utf-8', 'ai-catalog')).toBe(false);
  });

  it('accepts text/markdown for llms-txt, rejects json and html', () => {
    expect(contentTypeOk('text/plain', 'llms-txt')).toBe(true);
    expect(contentTypeOk('text/markdown', 'llms-txt')).toBe(true);
    expect(contentTypeOk('application/json', 'llms-txt')).toBe(false);
    expect(contentTypeOk('text/html', 'llms-txt')).toBe(false);
  });

  it('is lenient on missing / empty content-type', () => {
    expect(contentTypeOk(null, 'ai-catalog')).toBe(true);
    expect(contentTypeOk('', 'llms-txt')).toBe(true);
  });
});
