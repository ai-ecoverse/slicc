import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setBridgeToken,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../../../src/shell/proxied-fetch.js';
import {
  createBridgeSecretBackend,
  createCliSecretBackend,
  createDefaultSecretBackend,
  createExtensionSecretBackend,
} from '../../../src/shell/supplemental-commands/secret-backends.js';

type FetchInit = { method?: string; body?: string; headers?: Record<string, string> };
type Recorded = { url: string; init: FetchInit };

function mockFetch(handler: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(url),
      init: (init ?? {}) as FetchInit,
    };
    calls.push(recorded);
    return handler(recorded);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLocalApiBaseUrl(null);
  setBridgeToken(null);
});

describe('createCliSecretBackend.list', () => {
  it('merges persisted + session records flagged by origin', async () => {
    mockFetch(({ url }) => {
      if (url.endsWith('/api/secrets/session')) {
        return jsonResponse([{ name: 'TMP', domains: ['x.example'] }]);
      }
      return jsonResponse([{ name: 'PERSIST', domains: ['y.example'] }]);
    });
    const records = await createCliSecretBackend().list();
    expect(records).toEqual([
      { name: 'PERSIST', domains: ['y.example'], persisted: true },
      { name: 'TMP', domains: ['x.example'], persisted: false },
    ]);
  });

  it('skips a failing store and still returns the healthy one', async () => {
    mockFetch(({ url }) =>
      url.endsWith('/session')
        ? new Response('boom', { status: 500 })
        : jsonResponse([{ name: 'A', domains: [] }])
    );
    expect(await createCliSecretBackend().list()).toEqual([
      { name: 'A', domains: [], persisted: true },
    ]);
  });
});

describe('createCliSecretBackend.getInfo / getMasked / peek', () => {
  it('getInfo returns the matching record or null when absent', async () => {
    mockFetch(({ url }) =>
      url.endsWith('/session')
        ? jsonResponse([])
        : jsonResponse([{ name: 'TOKEN', domains: ['api.example'] }])
    );
    const be = createCliSecretBackend();
    expect(await be.getInfo('TOKEN')).toEqual({
      name: 'TOKEN',
      domains: ['api.example'],
      persisted: true,
    });
    expect(await be.getInfo('MISSING')).toBeNull();
  });

  it('getMasked returns null when the masked endpoint fails', async () => {
    mockFetch(() => new Response('nope', { status: 500 }));
    expect(await createCliSecretBackend().getMasked('X')).toBeNull();
  });

  it('peek returns null when the peek endpoint fails', async () => {
    mockFetch(() => new Response('nope', { status: 404 }));
    expect(await createCliSecretBackend().peek('X')).toBeNull();
  });

  it('peek encodes the secret name into the query string', async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ name: 'A B', preview: 'masked', domains: [] })
    );
    await createCliSecretBackend().peek('A B');
    expect(calls[0].url).toBe('/api/secrets/peek?name=A%20B');
  });
});

describe('createCliSecretBackend.set* — error surface', () => {
  it('setSession propagates the server error message when present', async () => {
    mockFetch(() => jsonResponse({ error: 'bad name' }, { status: 400 }));
    await expect(createCliSecretBackend().setSession('X', 'v', [])).rejects.toThrow('bad name');
  });

  it('setPersisted falls back to a default message when no error field is present', async () => {
    mockFetch(() => jsonResponse({}, { status: 500 }));
    await expect(createCliSecretBackend().setPersisted('X', 'v', [])).rejects.toThrow(
      'failed to persist secret'
    );
  });

  it('setScope succeeds silently on a 2xx response', async () => {
    const { calls } = mockFetch(() => jsonResponse({ ok: true }));
    await createCliSecretBackend().setScope('X', ['a.example']);
    expect(calls[0].url).toBe('/api/secrets/scope');
    expect(calls[0].init.method).toBe('POST');
  });
});

describe('createCliSecretBackend.delete', () => {
  it('reports removed=false when the server returns 404', async () => {
    mockFetch(() => new Response('', { status: 404 }));
    expect(await createCliSecretBackend().delete('X')).toEqual({ removed: false });
  });

  it('threads fromSession through when the server returns it', async () => {
    mockFetch(() => jsonResponse({ fromSession: true }));
    expect(await createCliSecretBackend().delete('X')).toEqual({
      removed: true,
      fromSession: true,
    });
  });

  it('omits fromSession when the response body is missing the field', async () => {
    mockFetch(() => jsonResponse({}));
    expect(await createCliSecretBackend().delete('X')).toEqual({
      removed: true,
      fromSession: undefined,
    });
  });

  it('throws when the server returns a non-404 error', async () => {
    mockFetch(() => jsonResponse({ error: 'locked' }, { status: 409 }));
    await expect(createCliSecretBackend().delete('X')).rejects.toThrow('locked');
  });
});

describe('createDefaultSecretBackend', () => {
  it('routes to the CLI backend for the node-rest topology', async () => {
    mockFetch(() => jsonResponse([]));
    const be = createDefaultSecretBackend('node-rest');
    await be.list();
    // CLI backend hits /api/secrets — extension would not call fetch at all.
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('routes the connect topology to the CLI backend (replica writes no-op)', async () => {
    mockFetch(() => jsonResponse([]));
    await createDefaultSecretBackend('connect').list();
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

interface SwMessage {
  type: string;
  name?: string;
}

function stubChromeRuntime(handler: (msg: SwMessage) => unknown): { calls: SwMessage[] } {
  const calls: SwMessage[] = [];
  const sendMessage = vi.fn((msg: SwMessage, cb: (response: unknown) => void) => {
    calls.push(msg);
    queueMicrotask(() => cb(handler(msg)));
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
  return { calls };
}

describe('createExtensionSecretBackend', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges persisted + session entries from two SW calls', async () => {
    stubChromeRuntime((msg) => {
      if (msg.type === 'secrets.session.list') return { entries: [{ name: 'S', domains: [] }] };
      return { entries: [{ name: 'P', domains: ['a.example'] }] };
    });
    const records = await createExtensionSecretBackend().list();
    expect(records).toEqual([
      { name: 'P', domains: ['a.example'], persisted: true },
      { name: 'S', domains: [], persisted: false },
    ]);
  });

  it('tolerates a malformed SW response by treating entries as empty', async () => {
    stubChromeRuntime(() => ({}));
    expect(await createExtensionSecretBackend().list()).toEqual([]);
  });

  it('peek rejects when the SW response carries an error field', async () => {
    stubChromeRuntime(() => ({ error: 'no such secret' }));
    await expect(createExtensionSecretBackend().peek('X')).rejects.toThrow('no such secret');
  });

  it('peek returns null when the SW response has no record', async () => {
    stubChromeRuntime(() => ({}));
    expect(await createExtensionSecretBackend().peek('X')).toBeNull();
  });

  it('setSession throws using the SW-supplied error when ok is false', async () => {
    stubChromeRuntime(() => ({ ok: false, error: 'denied' }));
    await expect(createExtensionSecretBackend().setSession('X', 'v', [])).rejects.toThrow('denied');
  });

  it('setPersisted falls back to a default error message when ok is missing', async () => {
    stubChromeRuntime(() => ({}));
    await expect(createExtensionSecretBackend().setPersisted('X', 'v', [])).rejects.toThrow(
      'secrets.set failed'
    );
  });

  it('delete defaults removed=true when the SW omits the field', async () => {
    stubChromeRuntime(() => ({ ok: true }));
    expect(await createExtensionSecretBackend().delete('X')).toEqual({
      removed: true,
      fromSession: undefined,
    });
  });

  it('delete threads removed=false through when the SW reports it', async () => {
    stubChromeRuntime(() => ({ ok: true, removed: false }));
    expect(await createExtensionSecretBackend().delete('X')).toEqual({
      removed: false,
      fromSession: undefined,
    });
  });

  it('rejects when chrome.runtime.lastError is set', async () => {
    const sendMessage = vi.fn((_msg: unknown, cb: (response: unknown) => void) => {
      (
        globalThis as unknown as { chrome: { runtime: { lastError: { message: string } } } }
      ).chrome.runtime.lastError = { message: 'disconnected' };
      queueMicrotask(() => cb(undefined));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    await expect(createExtensionSecretBackend().list()).rejects.toThrow('disconnected');
  });

  it('createDefaultSecretBackend(extension-direct) routes to the extension backend', async () => {
    stubChromeRuntime(() => ({ entries: [] }));
    await createDefaultSecretBackend('extension-direct').list();
    expect(
      (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
        .chrome.runtime.sendMessage
    ).toHaveBeenCalled();
  });
});

describe('createCliSecretBackend — thin-bridge URL + token', () => {
  it('legacy / same-origin: hits the relative /api/secrets path with no X-Bridge-Token', async () => {
    const { calls } = mockFetch(() => jsonResponse([]));
    await createCliSecretBackend().list();
    expect(calls[0].url).toBe('/api/secrets');
    expect(calls[1].url).toBe('/api/secrets/session');
    expect(calls[0].init.headers?.['X-Bridge-Token']).toBeUndefined();
    expect(calls[1].init.headers?.['X-Bridge-Token']).toBeUndefined();
  });

  it('thin-bridge: hits the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const { calls } = mockFetch(() => jsonResponse([]));
    await createCliSecretBackend().list();
    expect(calls[0].url).toBe('http://localhost:5710/api/secrets');
    expect(calls[1].url).toBe('http://localhost:5710/api/secrets/session');
    expect(calls[0].init.headers?.['X-Bridge-Token']).toBe('abc-123');
    expect(calls[1].init.headers?.['X-Bridge-Token']).toBe('abc-123');
  });

  it('thin-bridge: peek query string is preserved on the bridge origin', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const { calls } = mockFetch(() =>
      jsonResponse({ name: 'A B', preview: 'masked', domains: [] })
    );
    await createCliSecretBackend().peek('A B');
    expect(calls[0].url).toBe('http://localhost:5710/api/secrets/peek?name=A%20B');
    expect(calls[0].init.headers?.['X-Bridge-Token']).toBe('abc-123');
  });

  it('base set but no token → absolute URL, still no X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    const { calls } = mockFetch(() => jsonResponse([]));
    await createCliSecretBackend().list();
    expect(calls[0].url).toBe('http://localhost:5710/api/secrets');
    expect(calls[0].init.headers?.['X-Bridge-Token']).toBeUndefined();
  });

  it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
    setBridgeToken('abc-123');
    const { calls } = mockFetch(() => jsonResponse([]));
    await createCliSecretBackend().list();
    expect(calls[0].url).toBe('/api/secrets');
    expect(calls[0].init.headers?.['X-Bridge-Token']).toBeUndefined();
  });
});

interface BridgeMsg {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Bridge backend (extension-delegate topology): SECRETS_HANDLERS control
 * messages route through `callSecretsBridge`. The kernel-worker realm (no
 * `chrome`, a delegate id wired at boot) bridges over the `secrets-bridge`
 * panel-RPC op, so every message `type` resolves through the same handler set.
 * Mirrors `tests/core/secrets-bridge-client.test.ts` worker-realm coverage.
 */
describe('createBridgeSecretBackend — worker realm over panel-RPC', () => {
  let originalChrome: unknown;
  let originalPanelRpc: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalPanelRpc = (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = originalPanelRpc;
    setExtensionDelegateId(null);
  });

  function stubWorkerBridge(handler: (msg: BridgeMsg) => unknown): {
    calls: BridgeMsg[];
    call: ReturnType<typeof vi.fn>;
  } {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    setExtensionDelegateId('delegate-xyz');
    const calls: BridgeMsg[] = [];
    const call = vi.fn(async (_op: string, payload: BridgeMsg) => {
      calls.push(payload);
      return { response: handler(payload) };
    });
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call,
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };
    return { calls, call };
  }

  it('list bridges both store reads over the secrets-bridge panel-RPC op', async () => {
    const { call } = stubWorkerBridge(({ type }) =>
      type === 'secrets.session.list'
        ? { entries: [{ name: 'S', domains: [] }] }
        : { entries: [{ name: 'P', domains: ['a.example'] }] }
    );
    const records = await createBridgeSecretBackend().list();
    expect(records).toEqual([
      { name: 'P', domains: ['a.example'], persisted: true },
      { name: 'S', domains: [], persisted: false },
    ]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.every(([op]) => op === 'secrets-bridge')).toBe(true);
  });

  it('peek rejects when the bridged response carries an error field', async () => {
    stubWorkerBridge(() => ({ error: 'no such secret' }));
    await expect(createBridgeSecretBackend().peek('X')).rejects.toThrow('no such secret');
  });

  it('setSession throws using the bridged error when ok is false', async () => {
    const { calls } = stubWorkerBridge(() => ({ ok: false, error: 'denied' }));
    await expect(createBridgeSecretBackend().setSession('X', 'v', [])).rejects.toThrow('denied');
    expect(calls[0]).toEqual({
      type: 'secrets.session.set',
      payload: { name: 'X', value: 'v', domains: [] },
    });
  });

  it('createDefaultSecretBackend(extension-delegate) routes to the bridge backend', async () => {
    const { call } = stubWorkerBridge(() => ({ entries: [] }));
    await createDefaultSecretBackend('extension-delegate').list();
    expect(call).toHaveBeenCalled();
    const [op, payload] = call.mock.calls[0];
    expect(op).toBe('secrets-bridge');
    expect((payload as BridgeMsg).type).toBe('secrets.list');
  });
});
