import { describe, expect, it, vi } from 'vitest';

describe('createProxiedFetch — extension branch (Port-based)', () => {
  it('opens a Port named fetch-proxy.fetch and reconstructs a streamed response', async () => {
    const msgListeners: ((m: any) => void)[] = [];
    const discListeners: (() => void)[] = [];
    const port: any = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: any) => msgListeners.push(fn) },
      onDisconnect: { addListener: (fn: any) => discListeners.push(fn) },
    };
    (globalThis as any).chrome = { runtime: { connect: vi.fn(() => port), id: 'test-id' } };

    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();

    const fetchPromise = proxiedFetch('https://api.github.com/user', {
      headers: { authorization: 'Bearer x' },
    });

    await new Promise((r) => setTimeout(r, 0));

    msgListeners.forEach((l) => {
      l({
        type: 'response-head',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    });
    msgListeners.forEach((l) => {
      l({ type: 'response-chunk', dataBase64: btoa('hello ') });
    });
    msgListeners.forEach((l) => {
      l({ type: 'response-chunk', dataBase64: btoa('world') });
    });
    msgListeners.forEach((l) => {
      l({ type: 'response-end' });
    });

    const resp = await fetchPromise;
    expect(resp.status).toBe(200);
    const bodyText = new TextDecoder().decode(resp.body);
    expect(bodyText).toBe('hello world');
    expect((globalThis as any).chrome.runtime.connect).toHaveBeenCalledWith({
      name: 'fetch-proxy.fetch',
    });
  });

  it('rejects when port disconnects before response-head', async () => {
    const discListeners: (() => void)[] = [];
    const port: any = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: (fn: any) => discListeners.push(fn) },
    };
    (globalThis as any).chrome = { runtime: { connect: vi.fn(() => port), id: 'test-id' } };

    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();

    const fetchPromise = proxiedFetch('https://api.github.com/user', {});
    await new Promise((r) => setTimeout(r, 0));
    discListeners.forEach((l) => {
      l();
    });
    await expect(fetchPromise).rejects.toThrow(/port disconnected/i);
  });

  it('does not throw finalizing a null-body status (204) response', async () => {
    const msgListeners: ((m: any) => void)[] = [];
    const port: any = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: any) => msgListeners.push(fn) },
      onDisconnect: { addListener: vi.fn() },
    };
    (globalThis as any).chrome = { runtime: { connect: vi.fn(() => port), id: 'test-id' } };

    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();

    const fetchPromise = proxiedFetch('https://api.github.com/user', { method: 'DELETE' });
    await new Promise((r) => setTimeout(r, 0));
    msgListeners.forEach((l) => {
      l({ type: 'response-head', status: 204, statusText: 'No Content', headers: {} });
    });
    msgListeners.forEach((l) => {
      l({ type: 'response-end' });
    });

    const resp = await fetchPromise;
    expect(resp.status).toBe(204);
    expect(resp.body.byteLength).toBe(0);
  });

  it('rejects with response-error message when the SW reports an error', async () => {
    const msgListeners: ((m: any) => void)[] = [];
    const port: any = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: any) => msgListeners.push(fn) },
      onDisconnect: { addListener: vi.fn() },
    };
    (globalThis as any).chrome = { runtime: { connect: vi.fn(() => port), id: 'test-id' } };

    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();

    const fetchPromise = proxiedFetch('https://api.github.com/user', {});
    await new Promise((r) => setTimeout(r, 0));
    msgListeners.forEach((l) => {
      l({ type: 'response-error', error: 'forbidden: GITHUB_TOKEN' });
    });
    await expect(fetchPromise).rejects.toThrow(/forbidden/);
  });

  it('disconnects the Port when the request AbortSignal aborts', async () => {
    const port: {
      postMessage: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onMessage: { addListener: ReturnType<typeof vi.fn> };
      onDisconnect: { addListener: ReturnType<typeof vi.fn> };
    } = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: vi.fn(() => port), id: 'test-id' },
    };

    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();
    const ac = new AbortController();
    const fetchPromise = proxiedFetch('https://api.github.com/user', {
      signal: ac.signal,
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(fetchPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.disconnect).toHaveBeenCalled();
  });
});
