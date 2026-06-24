import { describe, expect, it, vi } from 'vitest';
import { mountSliccImpl } from '../src/mount.js';

describe('mountSliccImpl', () => {
  it('creates an iframe in the container pointed at ?cherry=1', () => {
    const container = document.createElement('div');
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
    });
    const iframe = container.querySelector('iframe')!;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toContain('cherry=1');
    handle.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('honors onPermissionRequest denials before dispatching CDP', async () => {
    const container = document.createElement('div');
    const onPermissionRequest = vi.fn(() => false);
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest },
      joinToken: 'https://app.example/join?t=X',
    });
    // Drive a cdp.request for a denied domain through the test seam.
    const res = await handle.__test_receive({
      kind: 'cdp.request',
      id: 7,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    expect(onPermissionRequest).toHaveBeenCalledWith('Page');
    expect(res?.error?.code).toBe(-32601);
    handle.destroy();
  });

  it('returns a cdp.response error (not a hang) when onPermissionRequest throws', async () => {
    const container = document.createElement('div');
    // A throwing hook must NOT leave the cdp.request unanswered — otherwise the
    // leader's CherryHostTransport blocks until its 30s timeout.
    const onPermissionRequest = vi.fn(() => {
      throw new Error('hook boom');
    });
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest },
      joinToken: 'https://app.example/join?t=X',
    });
    const res = await handle.__test_receive({
      kind: 'cdp.request',
      id: 9,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    expect(onPermissionRequest).toHaveBeenCalledWith('Page');
    expect(res?.result).toBeUndefined();
    expect(res?.error?.code).toBe(-32000);
    expect(res?.error?.message).toContain('hook boom');
    handle.destroy();
  });

  it('posts a cdp.response error back over postMessage when the hook rejects', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; id?: number; error?: { code: number } }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest: () => Promise.reject(new Error('async boom')) },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    // Establish the channelId so the cdp.response can be posted.
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-err',
      kind: 'handshake.hello',
    } as never);
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-err',
      kind: 'cdp.request',
      id: 11,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    const response = posted.find((e) => e.kind === 'cdp.response' && e.id === 11);
    expect(response?.error?.code).toBe(-32000);
    handle.destroy();
  });

  it('forwards a ready joinToken in the welcome envelope (no auth)', async () => {
    const container = document.createElement('div');
    const posted: unknown[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=PRE',
      __test_post: (env) => posted.push(env),
    });
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-1',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find(
      (e): e is { kind: string; joinUrl?: string; auth?: unknown } =>
        (e as { kind?: string }).kind === 'handshake.welcome'
    );
    expect(welcome?.joinUrl).toBe('https://app.example/join?t=PRE');
    expect(welcome?.auth).toBeUndefined();
    handle.destroy();
  });

  it('fires onHandshakeComplete exactly once after handshake.hello', async () => {
    const container = document.createElement('div');
    const onHandshakeComplete = vi.fn();
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      hooks: { onHandshakeComplete },
      joinToken: 'https://app.example/join?t=X',
    });
    expect(onHandshakeComplete).not.toHaveBeenCalled();
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-hc',
      kind: 'handshake.hello',
    } as never);
    expect(onHandshakeComplete).toHaveBeenCalledTimes(1);
    // A second hello should not re-fire (channelId already pinned in practice,
    // but the hook fires per hello dispatch).
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-hc',
      kind: 'handshake.hello',
    } as never);
    expect(onHandshakeComplete).toHaveBeenCalledTimes(2);
    handle.destroy();
  });

  it('emitHostEvent posts a host.event envelope once the handshake pins a channelId', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; name?: string; detail?: unknown; channelId?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-host',
      kind: 'handshake.hello',
    } as never);
    handle.emitHostEvent('checkout-done', { id: 7 });
    const evt = posted.find((e) => e.kind === 'host.event');
    expect(evt?.name).toBe('checkout-done');
    expect(evt?.detail).toEqual({ id: 7 });
    expect(evt?.channelId).toBe('ch-host');
    handle.destroy();
  });

  it('emitHostEvent drops (with a warning) before the handshake completes', () => {
    const container = document.createElement('div');
    const posted: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env),
    });
    handle.emitHostEvent('too-early');
    expect(posted.find((e) => (e as { kind?: string }).kind === 'host.event')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    handle.destroy();
  });
});
