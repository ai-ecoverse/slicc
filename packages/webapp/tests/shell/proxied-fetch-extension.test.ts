import { describe, it, expect, vi } from 'vitest';

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

    // Allow the proxiedFetch to install its listeners first
    await new Promise((r) => setTimeout(r, 0));

    msgListeners.forEach((l) =>
      l({
        type: 'response-head',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      })
    );
    msgListeners.forEach((l) => l({ type: 'response-chunk', dataBase64: btoa('hello ') }));
    msgListeners.forEach((l) => l({ type: 'response-chunk', dataBase64: btoa('world') }));
    msgListeners.forEach((l) => l({ type: 'response-end' }));

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
    discListeners.forEach((l) => l());
    await expect(fetchPromise).rejects.toThrow(/port disconnected/i);
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
    msgListeners.forEach((l) => l({ type: 'response-error', error: 'forbidden: GITHUB_TOKEN' }));
    await expect(fetchPromise).rejects.toThrow(/forbidden/);
  });
});
