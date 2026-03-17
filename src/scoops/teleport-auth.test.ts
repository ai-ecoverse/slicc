import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isAuthRedirect, executeTeleportAuth } from './teleport-auth.js';
import type { CDPTransport } from '../cdp/transport.js';

// ---------------------------------------------------------------------------
// isAuthRedirect
// ---------------------------------------------------------------------------

describe('isAuthRedirect', () => {
  it('detects hostname change as auth redirect', () => {
    expect(isAuthRedirect('https://login.example.com/auth', 'https://app.example.com/dashboard')).toBe(true);
  });

  it('detects redirect from auth provider to app', () => {
    expect(isAuthRedirect('https://accounts.google.com/signin', 'https://myapp.com/callback')).toBe(true);
  });

  it('returns false when hostname stays the same', () => {
    expect(isAuthRedirect('https://login.example.com/auth', 'https://login.example.com/success')).toBe(false);
  });

  it('returns false when only path changes', () => {
    expect(isAuthRedirect('https://app.com/login', 'https://app.com/dashboard')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isAuthRedirect('not-a-url', 'also-not-a-url')).toBe(false);
  });

  it('handles one invalid URL gracefully', () => {
    expect(isAuthRedirect('https://valid.com', 'not-a-url')).toBe(false);
  });

  it('detects subdomain changes', () => {
    expect(isAuthRedirect('https://auth.example.com', 'https://www.example.com')).toBe(true);
  });

  it('returns false for same URL', () => {
    expect(isAuthRedirect('https://login.example.com/page', 'https://login.example.com/page')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeTeleportAuth
// ---------------------------------------------------------------------------

describe('executeTeleportAuth', () => {
  function createFakeTransport() {
    const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
    const transport: CDPTransport = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn().mockResolvedValue({}),
      on: vi.fn((event: string, listener: (params: Record<string, unknown>) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      }),
      off: vi.fn((event: string, listener: (params: Record<string, unknown>) => void) => {
        listeners.get(event)?.delete(listener);
      }),
      once: vi.fn(),
      state: 'connected' as const,
    };
    return {
      transport,
      listeners,
      emit(event: string, params: Record<string, unknown>) {
        for (const listener of listeners.get(event) ?? []) {
          listener(params);
        }
      },
    };
  }

  /** Flush microtask queue so resolved promises complete. */
  async function flushMicrotasks() {
    // Multiple flushes to handle chained awaits in executeTeleportAuth
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a tab, waits for auth redirect, captures cookies, and closes tab', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-auth' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-1' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({
          cookies: [{ name: 'session', value: 'abc', domain: '.app.com', path: '/', expires: -1, size: 20, httpOnly: true, secure: true, session: true }],
        });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const onNotification = vi.fn();
    const promise = executeTeleportAuth({
      transport,
      url: 'https://login.example.com/auth',
      timeoutMs: 5000,
      onNotification,
    });

    // Let the initial awaits (createTarget, attachToTarget, Page.enable) complete
    await flushMicrotasks();

    // Now the listener should be registered — simulate auth redirect
    emit('Page.frameNavigated', {
      sessionId: 'sess-1',
      frame: { url: 'https://app.example.com/dashboard', id: 'main' },
    });

    const result = await promise;

    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0].name).toBe('session');
    expect(result.timedOut).toBe(false);
    expect(onNotification).toHaveBeenCalledWith(expect.stringContaining('Authentication requested'));
    expect(onNotification).toHaveBeenCalledWith(expect.stringContaining('Authentication complete'));
    expect(transport.send).toHaveBeenCalledWith('Target.createTarget', { url: 'https://login.example.com/auth', background: false });
    expect(transport.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'tab-auth' });
  });

  it('times out and still captures cookies', async () => {
    const { transport } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-timeout' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-2' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({
          cookies: [{ name: 'partial', value: 'xyz', domain: '.site.com', path: '/', expires: -1, size: 10, httpOnly: false, secure: false, session: true }],
        });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const onNotification = vi.fn();
    const promise = executeTeleportAuth({
      transport,
      url: 'https://login.site.com/signin',
      timeoutMs: 3000,
      onNotification,
    });

    // Flush microtasks so we're waiting on the timeout
    await flushMicrotasks();

    // Advance past the timeout
    vi.advanceTimersByTime(3000);

    // Flush microtasks again for post-timeout awaits
    await flushMicrotasks();

    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0].name).toBe('partial');
    expect(onNotification).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(transport.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'tab-timeout' });
  });

  it('ignores navigation events from other sessions', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-1' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'my-session' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://auth.example.com',
      timeoutMs: 1000,
    });

    await flushMicrotasks();

    // Emit from a different session — should be ignored
    emit('Page.frameNavigated', {
      sessionId: 'other-session',
      frame: { url: 'https://different-host.com', id: 'main' },
    });

    // Let it time out
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  it('ignores sub-frame navigations', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-1' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-3' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://auth.example.com',
      timeoutMs: 1000,
    });

    await flushMicrotasks();

    // Emit a sub-frame navigation (has parentId) — should be ignored
    emit('Page.frameNavigated', {
      sessionId: 'sess-3',
      frame: { url: 'https://different-host.com', id: 'sub', parentId: 'main' },
    });

    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  it('cleans up event listener on auth redirect', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-1' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-4' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://login.example.com',
      timeoutMs: 10000,
    });

    await flushMicrotasks();

    // Trigger auth redirect
    emit('Page.frameNavigated', {
      sessionId: 'sess-4',
      frame: { url: 'https://app.example.com/home', id: 'main' },
    });

    await promise;

    // Verify cleanup: off should have been called
    expect(transport.off).toHaveBeenCalledWith('Page.frameNavigated', expect.any(Function));
  });

  it('handles tab close failure gracefully', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-1' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-5' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.reject(new Error('Tab already closed'));
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://login.example.com',
      timeoutMs: 5000,
    });

    await flushMicrotasks();

    emit('Page.frameNavigated', {
      sessionId: 'sess-5',
      frame: { url: 'https://app.example.com', id: 'main' },
    });

    // Should not throw even though closeTarget fails
    const result = await promise;
    expect(result.cookies).toEqual([]);
    expect(result.timedOut).toBe(false);
  });
});
