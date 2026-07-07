/**
 * `callMountBridge` correlation / timeout / reconnect (EXT8).
 *
 * Mirrors `tests/core/secrets-bridge-client.test.ts`, but the mount bridge
 * must SURFACE failures (a silently-degraded mount is a bug), so the
 * unavailable / timeout / disconnect paths reject with `FsError` rather than
 * resolving `undefined`. Module state is per-realm; each test gets a fresh
 * graph via `vi.resetModules()` + dynamic import.
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
  const proxied = await import('../../../src/shell/proxied-fetch.js');
  proxied.setExtensionDelegateId(delegateId);
  const { callMountBridge } = await import('../../../src/fs/mount/mount-bridge-client.js');
  return { callMountBridge };
}

const OK_REPLY = { ok: true, status: 200, headers: {}, bodyBase64: '' } as const;

describe('callMountBridge — page realm (direct Port)', () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects with the explicit delegate id and the mount.sign-and-forward port name', async () => {
    const { connect } = makeHarness();
    const { callMountBridge } = await loadClient('delegate-xyz');
    void callMountBridge('mount.da-sign-and-forward', { path: '/source/x' });
    expect(connect).toHaveBeenCalledWith('delegate-xyz', { name: 'mount.sign-and-forward' });
  });

  it('posts { id, type, envelope } and correlates replies by id (out-of-order)', async () => {
    const { port, connect, msgListeners } = makeHarness();
    const { callMountBridge } = await loadClient('delegate-xyz');

    const first = callMountBridge('mount.s3-sign-and-forward', { bucket: 'b1' });
    const second = callMountBridge('mount.da-sign-and-forward', { path: '/p2' });

    expect(connect).toHaveBeenCalledTimes(1);
    const firstMsg = port.postMessage.mock.calls[0][0] as { id: number; type: string };
    const secondMsg = port.postMessage.mock.calls[1][0] as {
      id: number;
      type: string;
      envelope: unknown;
    };
    expect(firstMsg).toEqual({
      id: 1,
      type: 'mount.s3-sign-and-forward',
      envelope: { bucket: 'b1' },
    });
    expect(secondMsg).toEqual({
      id: 2,
      type: 'mount.da-sign-and-forward',
      envelope: { path: '/p2' },
    });

    for (const l of msgListeners) l({ id: secondMsg.id, response: { ...OK_REPLY, status: 204 } });
    for (const l of msgListeners) l({ id: firstMsg.id, response: OK_REPLY });

    await expect(first).resolves.toEqual(OK_REPLY);
    await expect(second).resolves.toEqual({ ...OK_REPLY, status: 204 });
  });

  it('rejects with FsError EIO when the call times out', async () => {
    vi.useFakeTimers();
    makeHarness();
    const { callMountBridge } = await loadClient('delegate-xyz');
    const call = callMountBridge('mount.s3-sign-and-forward', { bucket: 'b' });
    // Attach the rejection assertion BEFORE advancing timers so the timeout
    // rejection is never momentarily unhandled.
    const assertion = expect(call).rejects.toMatchObject({
      code: 'EIO',
      message: expect.stringContaining('timed out'),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it('rejects with FsError EIO when no delegate id is configured (never connects)', async () => {
    const { connect } = makeHarness();
    const { callMountBridge } = await loadClient(null);
    await expect(
      callMountBridge('mount.s3-sign-and-forward', { bucket: 'b' })
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects pending with FsError on disconnect and reconnects on the next call', async () => {
    const { connect, disconnectListeners, msgListeners, port } = makeHarness();
    const { callMountBridge } = await loadClient('delegate-xyz');

    const inflight = callMountBridge('mount.s3-sign-and-forward', { bucket: 'b' });
    expect(connect).toHaveBeenCalledTimes(1);

    for (const l of disconnectListeners) l();
    await expect(inflight).rejects.toThrow('mount.sign-and-forward port disconnected');

    const second = callMountBridge('mount.da-sign-and-forward', { path: '/p' });
    expect(connect).toHaveBeenCalledTimes(2);
    const lastMsg = port.postMessage.mock.calls.at(-1)?.[0] as { id: number };
    for (const l of msgListeners) l({ id: lastMsg.id, response: OK_REPLY });
    await expect(second).resolves.toEqual(OK_REPLY);
  });
});

describe('callMountBridge — worker realm (no chrome)', () => {
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

  it('bridges over the mount-sign-and-forward panel-RPC op and returns result.response', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const call = vi.fn(async () => ({ response: { ...OK_REPLY, status: 201 } }));
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call,
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };

    vi.resetModules();
    const proxied = await import('../../../src/shell/proxied-fetch.js');
    proxied.setExtensionDelegateId('delegate-xyz');
    const { callMountBridge } = await import('../../../src/fs/mount/mount-bridge-client.js');

    const reply = await callMountBridge('mount.da-sign-and-forward', { path: '/source/x' });
    expect(reply).toEqual({ ...OK_REPLY, status: 201 });
    const [op, payload, opts] = call.mock.calls[0] as unknown[];
    expect(op).toBe('mount-sign-and-forward');
    expect(payload).toEqual({ type: 'mount.da-sign-and-forward', envelope: { path: '/source/x' } });
    expect(opts).toEqual({ timeoutMs: 120_000 });
  });

  it('rejects with FsError when no panel-RPC client is published', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = undefined;

    vi.resetModules();
    const proxied = await import('../../../src/shell/proxied-fetch.js');
    proxied.setExtensionDelegateId('delegate-xyz');
    const { callMountBridge } = await import('../../../src/fs/mount/mount-bridge-client.js');

    await expect(
      callMountBridge('mount.s3-sign-and-forward', { bucket: 'b' })
    ).rejects.toMatchObject({ code: 'EIO' });
  });
});
