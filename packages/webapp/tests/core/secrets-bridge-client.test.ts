/**
 * `callSecretsBridge` correlation / timeout / reconnect (EXT7 §3.C).
 *
 * Module state (cached Port, pending map, id counter) is per-realm; each test
 * gets a fresh graph via `vi.resetModules()` + dynamic import so the singleton
 * Port and id counter start clean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (m: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

function makeHarness() {
  const msgListeners: ((m: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const port: FakePort = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
  };
  const connect = vi.fn(() => port);
  (globalThis as { chrome?: unknown }).chrome = { runtime: { connect } };
  return { port, connect, msgListeners, disconnectListeners };
}

async function loadClient(delegateId: string | null) {
  vi.resetModules();
  const proxied = await import('../../src/shell/proxied-fetch.js');
  proxied.setExtensionDelegateId(delegateId);
  const { callSecretsBridge } = await import('../../src/core/secrets-bridge-client.js');
  return { callSecretsBridge };
}

describe('callSecretsBridge', () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects with the explicit delegate id and the secrets.crud port name', async () => {
    const { connect } = makeHarness();
    const { callSecretsBridge } = await loadClient('delegate-xyz');
    void callSecretsBridge('secrets.list-masked-entries');
    expect(connect).toHaveBeenCalledWith('delegate-xyz', { name: 'secrets.crud' });
  });

  it('correlates concurrent replies by id (out-of-order responses)', async () => {
    const { port, connect, msgListeners } = makeHarness();
    const { callSecretsBridge } = await loadClient('delegate-xyz');

    const first = callSecretsBridge('secrets.list-masked-entries');
    const second = callSecretsBridge('secrets.mask-oauth-token', { providerId: 'adobe' });

    // One cached Port reused for both calls.
    expect(connect).toHaveBeenCalledTimes(1);
    const firstMsg = port.postMessage.mock.calls[0][0] as { id: number; type: string };
    const secondMsg = port.postMessage.mock.calls[1][0] as {
      id: number;
      type: string;
      providerId: string;
    };
    expect(firstMsg).toEqual({ id: 1, type: 'secrets.list-masked-entries' });
    expect(secondMsg).toEqual({ id: 2, type: 'secrets.mask-oauth-token', providerId: 'adobe' });

    // Reply to the second call first, then the first.
    for (const l of msgListeners) l({ id: secondMsg.id, response: { maskedValue: 'mask' } });
    for (const l of msgListeners) l({ id: firstMsg.id, response: { entries: [] } });

    await expect(first).resolves.toEqual({ entries: [] });
    await expect(second).resolves.toEqual({ maskedValue: 'mask' });
  });

  it('resolves to undefined when the call times out', async () => {
    vi.useFakeTimers();
    makeHarness();
    const { callSecretsBridge } = await loadClient('delegate-xyz');
    const call = callSecretsBridge('secrets.scrub-tool-result', { text: 'x' });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(call).resolves.toBeUndefined();
  });

  it('resolves to undefined when no delegate id is configured (never connects)', async () => {
    const { connect } = makeHarness();
    const { callSecretsBridge } = await loadClient(null);
    await expect(callSecretsBridge('secrets.list-masked-entries')).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it('clears the cached port on disconnect and reconnects on the next call', async () => {
    const { connect, disconnectListeners, msgListeners, port } = makeHarness();
    const { callSecretsBridge } = await loadClient('delegate-xyz');

    const inflight = callSecretsBridge('secrets.list-masked-entries');
    expect(connect).toHaveBeenCalledTimes(1);

    // Port drops mid-flight (e.g. MV3 SW eviction): pending rejects.
    for (const l of disconnectListeners) l();
    await expect(inflight).rejects.toThrow('secrets.crud port disconnected');

    // Next call transparently reconnects (new connect), correlation id resets
    // are not required — the id counter keeps climbing.
    const second = callSecretsBridge('secrets.mask-oauth-token');
    expect(connect).toHaveBeenCalledTimes(2);
    const lastMsg = port.postMessage.mock.calls.at(-1)?.[0] as { id: number };
    for (const l of msgListeners) l({ id: lastMsg.id, response: { ok: true } });
    await expect(second).resolves.toEqual({ ok: true });
  });
});

/**
 * Worker-realm branch (EXT7 Wave 3): the kernel worker has NO `chrome` at all,
 * so `callSecretsBridge` must bridge over panel-RPC to the page (mirroring
 * `createProxiedFetch`'s worker leg) instead of failing closed — which would
 * degrade the tool-result scrubber to identity, a security regression. Mirrors
 * `tests/shell/proxied-fetch-delegate.test.ts` 'worker realm bridges over
 * panel-RPC'.
 */
describe('callSecretsBridge — worker realm (no chrome)', () => {
  let originalChrome: unknown;
  let originalPanelRpc: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalPanelRpc = (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = originalPanelRpc;
    vi.restoreAllMocks();
  });

  it('bridges over the secrets-bridge panel-RPC op and returns result.response', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const call = vi.fn(async (..._args: unknown[]) => ({
      response: { entries: [{ name: 'TOKEN' }] },
    }));
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call,
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };

    vi.resetModules();
    const proxied = await import('../../src/shell/proxied-fetch.js');
    proxied.setExtensionDelegateId('delegate-xyz');
    const { callSecretsBridge } = await import('../../src/core/secrets-bridge-client.js');

    const result = await callSecretsBridge('secrets.list-masked-entries', { providerId: 'adobe' });
    expect(result).toEqual({ entries: [{ name: 'TOKEN' }] });
    expect(call).toHaveBeenCalledTimes(1);
    const [op, payload, opts] = call.mock.calls[0];
    expect(op).toBe('secrets-bridge');
    expect(payload).toEqual({
      type: 'secrets.list-masked-entries',
      payload: { providerId: 'adobe' },
    });
    expect(opts).toEqual({ timeoutMs: 10_000 });
  });

  it('resolves undefined when no panel-RPC client is published', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = undefined;

    vi.resetModules();
    const proxied = await import('../../src/shell/proxied-fetch.js');
    proxied.setExtensionDelegateId('delegate-xyz');
    const { callSecretsBridge } = await import('../../src/core/secrets-bridge-client.js');

    await expect(
      callSecretsBridge('secrets.scrub-tool-result', { text: 'x' })
    ).resolves.toBeUndefined();
  });
});
