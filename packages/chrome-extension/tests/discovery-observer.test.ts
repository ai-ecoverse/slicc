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
  let emit: (d: ObservedDiscovery) => number;

  beforeEach(() => {
    emitted = [];
    // Default: emit "reaches" a leader Port (push returns the new length >= 1).
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

  it('B24-5: emits for a plain origin but skips header scan and probe on a protected one', async () => {
    const fetchImpl = makeFetch({});
    const isProtected = (url: string) => new URL(url).hostname.endsWith('sliccy.ai');
    const obs = createDiscoveryObserver({ fetchImpl, emit, isProtected });
    const header = (origin: string) =>
      linkHeader(`<${origin}/.well-known/ai-catalog.json>; rel="ai-catalog"`);
    // Control: the plain page's Link header is surfaced.
    obs.onHeaders({ url: 'https://example.com/p', responseHeaders: header('https://example.com') });
    expect(emitted).toHaveLength(1);
    // Protected: nothing surfaced and nothing fetched.
    obs.onHeaders({
      url: 'https://vault.sliccy.ai/p',
      responseHeaders: header('https://vault.sliccy.ai'),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toHaveLength(1);
    const fetched = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes('sliccy.ai'))).toBe(false);
    expect(fetched.some((u) => u.startsWith('https://example.com/'))).toBe(true);
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

  it('re-delivers a discovery on a later navigation when the first emit reached no leader ports', () => {
    // FIX 1 (PR #1457): on MV3 cold boot the main-frame response can be observed
    // before any leader bridge Port is welcomed, so the emit reaches 0 recipients.
    // The fingerprint must NOT be recorded then, or the origin is permanently
    // suppressed and the cone never learns about it.
    const fetchImpl = makeFetch({});
    let recipients = 0;
    const localEmitted: ObservedDiscovery[] = [];
    const obs = createDiscoveryObserver({
      fetchImpl,
      emit: (d) => {
        localEmitted.push(d);
        return recipients;
      },
    });
    const header = linkHeader(
      '<https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"'
    );
    // Cold boot: no welcomed leader Port yet → emit reaches 0 recipients.
    obs.onHeaders({ url: 'https://example.com/a', responseHeaders: header });
    expect(localEmitted).toHaveLength(1);
    // A later navigation once a leader Port exists re-delivers (not suppressed).
    recipients = 1;
    obs.onHeaders({ url: 'https://example.com/b', responseHeaders: header });
    expect(localEmitted).toHaveLength(2);
    // Now that it was delivered, the fingerprint is recorded → no third emit.
    obs.onHeaders({ url: 'https://example.com/c', responseHeaders: header });
    expect(localEmitted).toHaveLength(2);
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

  it('does nothing when isEnabled returns false (no header emit, no probe)', async () => {
    const fetchImpl = makeFetch({
      'https://example.com/.well-known/ai-catalog.json': resp(200, 'application/json'),
    });
    const obs = createDiscoveryObserver({ fetchImpl, emit, isEnabled: () => false });
    obs.onHeaders({
      url: 'https://example.com/page',
      responseHeaders: linkHeader(
        '<https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"'
      ),
    });
    await vi.waitFor(() => expect(true).toBe(true));
    expect(emitted).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors a live isEnabled toggle per event', () => {
    let enabled = false;
    const fetchImpl = makeFetch({});
    const obs = createDiscoveryObserver({ fetchImpl, emit, isEnabled: () => enabled });
    const header = linkHeader(
      '<https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"'
    );
    obs.onHeaders({ url: 'https://example.com/a', responseHeaders: header });
    expect(emitted).toEqual([]);
    enabled = true;
    obs.onHeaders({ url: 'https://example.com/b', responseHeaders: header });
    expect(emitted).toHaveLength(1);
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
