/**
 * Thin-bridge extension-delegate branches of `createProxiedFetch`.
 *
 * - Page realm (leader tab): `chrome.runtime.connect` exists but
 *   `chrome.runtime.id` is undefined → connect with the EXPLICIT delegate id.
 * - Worker realm: no `chrome` at all → bridge over panel-RPC to the page.
 * - Regression: with no delegate id and no chrome, the CLI branch still wins.
 *
 * Module state is per-realm; reset to null between cases like the sibling
 * `proxied-fetch-local-api-base` suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (m: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

function makePort(msgListeners: ((m: unknown) => void)[]): FakePort {
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onDisconnect: { addListener: vi.fn() },
  };
}

function driveStream(listeners: ((m: unknown) => void)[], body: string): void {
  for (const l of listeners)
    l({
      type: 'response-head',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
    });
  for (const l of listeners) l({ type: 'response-chunk', dataBase64: btoa(body) });
  for (const l of listeners) l({ type: 'response-end' });
}

describe('createProxiedFetch — thin-bridge extension delegate', () => {
  let originalChrome: unknown;
  let originalFetch: typeof globalThis.fetch | undefined;
  let originalPanelRpc: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFetch = globalThis.fetch;
    originalPanelRpc = (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  afterEach(async () => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    if (originalFetch) {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = originalPanelRpc;
    const { setExtensionDelegateId, setLocalApiBaseUrl, setBridgeToken } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setExtensionDelegateId(null);
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    vi.restoreAllMocks();
  });

  it('page realm connects with the explicit id (chrome.runtime.id falsy) and finalizes', async () => {
    const msgListeners: ((m: unknown) => void)[] = [];
    const port = makePort(msgListeners);
    const connect = vi.fn(() => port);
    // No `id` on runtime — the externally-connectable leader page.
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect } };

    const { createProxiedFetch, setExtensionDelegateId, getExtensionDelegateId } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setExtensionDelegateId('abc-ext-id');
    expect(getExtensionDelegateId()).toBe('abc-ext-id');

    const proxiedFetch = createProxiedFetch();
    const fetchPromise = proxiedFetch('https://example.com/pkg', { headers: { accept: '*/*' } });
    await new Promise((r) => setTimeout(r, 0));
    driveStream(msgListeners, 'payload-bytes');

    const resp = await fetchPromise;
    expect(resp.status).toBe(200);
    expect(new TextDecoder().decode(resp.body)).toBe('payload-bytes');
    expect(connect).toHaveBeenCalledWith('abc-ext-id', { name: 'fetch-proxy.fetch' });
  });

  it('worker realm bridges over panel-RPC and finalizes the returned bytes', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const respBytes = new TextEncoder().encode('worker-body');
    const call = vi.fn(async () => ({
      head: { status: 201, statusText: 'Created', headers: { 'content-type': 'text/plain' } },
      body: respBytes.buffer,
    }));
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call,
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };

    const { createProxiedFetch, setExtensionDelegateId } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setExtensionDelegateId('abc-ext-id');

    const resp = await createProxiedFetch()('https://example.com/wasm', {
      method: 'POST',
      headers: { 'x-test': '1' },
      body: 'req-body',
    });
    expect(resp.status).toBe(201);
    expect(new TextDecoder().decode(resp.body)).toBe('worker-body');
    expect(call).toHaveBeenCalledTimes(1);
    const [op, payload, opts] = call.mock.calls[0];
    expect(op).toBe('proxied-fetch');
    expect(payload).toEqual({
      url: 'https://example.com/wasm',
      method: 'POST',
      headers: { 'x-test': '1' },
      body: 'req-body',
    });
    expect(opts).toEqual({ timeoutMs: 120_000 });
  });

  it('falls back to the CLI branch when no delegate id is set and no chrome', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const mockFetch = vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    (globalThis as { fetch: typeof globalThis.fetch }).fetch =
      mockFetch as unknown as typeof globalThis.fetch;

    const { createProxiedFetch, setExtensionDelegateId } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setExtensionDelegateId(null);
    await createProxiedFetch()('https://example.com/v1', { method: 'GET' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/fetch-proxy');
  });
});
