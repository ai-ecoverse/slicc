import { describe, it, expect, vi } from 'vitest';
import { discoverLinks } from '../../src/net/discover-links.js';
import { parseLinkHeader } from '../../src/net/link-header.js';

function makeFetch(map: Record<string, { status?: number; contentType?: string; body: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = map[url];
    if (!entry) {
      return new Response('not found', { status: 404 });
    }
    return new Response(entry.body, {
      status: entry.status ?? 200,
      headers: { 'content-type': entry.contentType ?? 'text/plain' },
    });
  });
}

describe('discoverLinks', () => {
  it('fetches each P0 rel and assigns to the right field', async () => {
    const links = parseLinkHeader(
      [
        '</.well-known/api-catalog>; rel="api-catalog"',
        '</openapi.json>; rel="service-desc"',
        '</status>; rel="status"',
        '</llms.txt>; rel="https://llmstxt.org/rel/llms-txt"',
      ].join(', '),
      'https://example.com/'
    );
    const fetchImpl = makeFetch({
      'https://example.com/.well-known/api-catalog': {
        contentType: 'application/linkset+json',
        body: '{"linkset":[{"anchor":"/"}]}',
      },
      'https://example.com/openapi.json': {
        contentType: 'application/json',
        body: '{"openapi":"3.0.0"}',
      },
      'https://example.com/status': {
        contentType: 'application/json',
        body: '{"ok":true}',
      },
      'https://example.com/llms.txt': {
        contentType: 'text/markdown',
        body: '# example\n',
      },
    });

    const result = await discoverLinks(links, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.catalog).toEqual({ linkset: [{ anchor: '/' }] });
    expect(result.serviceDesc).toEqual({ openapi: '3.0.0' });
    expect(result.status).toEqual({ ok: true });
    expect(result.llmsTxt).toBe('# example\n');
    expect(result.failures).toEqual([]);
  });

  it('records failures without throwing when one rel 404s', async () => {
    const links = parseLinkHeader(
      ['</api-catalog>; rel="api-catalog"', '</openapi.json>; rel="service-desc"'].join(', '),
      'https://example.com/'
    );
    const fetchImpl = makeFetch({
      'https://example.com/openapi.json': {
        contentType: 'application/json',
        body: '{"openapi":"3.0.0"}',
      },
    });

    const result = await discoverLinks(links, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.serviceDesc).toEqual({ openapi: '3.0.0' });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].rel).toBe('api-catalog');
    expect(result.failures[0].error).toContain('404');
  });

  it('skips links whose rel is not P0', async () => {
    const links = parseLinkHeader('</foo>; rel="next"', 'https://example.com/');
    const fetchImpl = vi.fn();
    const result = await discoverLinks(links, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.catalog).toBeUndefined();
  });

  it('respects the fetch timeout', async () => {
    const links = parseLinkHeader('</slow>; rel="api-catalog"', 'https://example.com/');
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const result = await discoverLinks(links, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.catalog).toBeUndefined();
  });

  it('handles non-JSON service-desc by storing raw text', async () => {
    const links = parseLinkHeader('</api.yaml>; rel="service-desc"', 'https://example.com/');
    const fetchImpl = makeFetch({
      'https://example.com/api.yaml': {
        contentType: 'application/yaml',
        body: 'openapi: 3.0.0',
      },
    });
    const result = await discoverLinks(links, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.serviceDesc).toBe('openapi: 3.0.0');
  });

  it('only fetches the first occurrence of each rel', async () => {
    const links = parseLinkHeader(
      ['</a>; rel="api-catalog"', '</b>; rel="api-catalog"'].join(', '),
      'https://example.com/'
    );
    const fetchImpl = makeFetch({
      'https://example.com/a': { contentType: 'application/json', body: '{"a":1}' },
      'https://example.com/b': { contentType: 'application/json', body: '{"b":2}' },
    });
    const result = await discoverLinks(links, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.catalog).toEqual({ a: 1 });
  });
});
