import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscoveryObserver, type ObservedDiscovery } from '../src/discovery-observer.js';

interface ProbeResp {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}

function resp(status: number, contentType: string | null): ProbeResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
  };
}

/** A fetch mock returning 404 by default; configured hits per exact URL. */
function makeFetch(hits: Record<string, ProbeResp>) {
  return vi.fn(async (url: string) => hits[url] ?? resp(404, null));
}

function linkHeader(value: string) {
  return [{ name: 'Link', value }];
}

describe('createDiscoveryObserver', () => {
  let emitted: ObservedDiscovery[];
  let emit: (d: ObservedDiscovery) => void;

  beforeEach(() => {
    emitted = [];
    emit = (d) => emitted.push(d);
  });

  it('emits an ai-catalog discovery from a rel="ai-catalog" Link header', () => {
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({
      url: 'https://example.com/page',
      responseHeaders: linkHeader(
        '<https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"'
      ),
    });
    expect(emitted).toEqual([
      {
        discoveryOrigin: 'https://example.com',
        discoveryKind: 'ai-catalog',
        discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
        url: 'https://example.com/page',
      },
    ]);
  });

  it('emits both artifacts found by the well-known probe when no Link header is present', async () => {
    const fetchImpl = makeFetch({
      'https://example.com/.well-known/ai-catalog.json': resp(200, 'application/json'),
      'https://example.com/llms.txt': resp(200, 'text/plain'),
    });
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({ url: 'https://example.com/page', responseHeaders: [] });
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    const kinds = emitted.map((e) => e.discoveryKind).sort();
    expect(kinds).toEqual(['ai-catalog', 'llms-txt']);
  });

  it('dedupes the same artifact across two page loads on the same origin', async () => {
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    const header = linkHeader(
      '<https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"'
    );
    obs.onHeaders({ url: 'https://example.com/a', responseHeaders: header });
    obs.onHeaders({ url: 'https://example.com/b', responseHeaders: header });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(emitted).toHaveLength(1);
  });

  it('throttles the well-known probe to one run per origin', async () => {
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({ url: 'https://example.com/a', responseHeaders: [] });
    obs.onHeaders({ url: 'https://example.com/b', responseHeaders: [] });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    // Two well-known targets probed on the first call only (not four).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('probes each distinct origin separately', async () => {
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({ url: 'https://a.example/x', responseHeaders: [] });
    obs.onHeaders({ url: 'https://b.example/y', responseHeaders: [] });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  });

  it('ignores non-http(s) origins (no emit, no fetch)', () => {
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({ url: 'chrome-extension://abcdef/page.html', responseHeaders: [] });
    expect(emitted).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not throw on a malformed URL', () => {
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    expect(() => obs.onHeaders({ url: 'not a url', responseHeaders: [] })).not.toThrow();
    expect(emitted).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows probe fetch failures (no emit, no throw)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({ url: 'https://example.com/page', responseHeaders: [] });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(emitted).toEqual([]);
  });

  it('rejects an HTML-typed well-known response (misconfiguration)', async () => {
    const fetchImpl = makeFetch({
      'https://example.com/.well-known/ai-catalog.json': resp(200, 'text/html'),
      'https://example.com/llms.txt': resp(200, 'text/html'),
    });
    const obs = createDiscoveryObserver({ fetchImpl, emit });
    obs.onHeaders({ url: 'https://example.com/page', responseHeaders: [] });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(emitted).toEqual([]);
  });
});
