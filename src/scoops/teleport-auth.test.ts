import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isAuthRedirect, executeTeleportAuth } from './teleport-auth.js';
import type { CDPTransport } from '../cdp/transport.js';

// ---------------------------------------------------------------------------
// isAuthRedirect
// ---------------------------------------------------------------------------

describe('isAuthRedirect', () => {
  it('returns true when navigated URL matches initial hostname (callback redirect)', () => {
    expect(isAuthRedirect('https://app.example.com', 'https://app.example.com/callback')).toBe(true);
  });

  it('returns true for same hostname with different path', () => {
    expect(isAuthRedirect('https://app.com/login', 'https://app.com/dashboard')).toBe(true);
  });

  it('returns true for exact same URL', () => {
    expect(isAuthRedirect('https://app.example.com/page', 'https://app.example.com/page')).toBe(true);
  });

  it('returns false when hostname differs (SSO redirect away)', () => {
    expect(isAuthRedirect('https://app.example.com', 'https://login.okta.com/auth')).toBe(false);
  });

  it('returns false for redirect to auth provider', () => {
    expect(isAuthRedirect('https://app.example.com', 'https://accounts.google.com/signin')).toBe(false);
  });

  it('returns false for subdomain changes', () => {
    expect(isAuthRedirect('https://app.example.com', 'https://auth.example.com')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isAuthRedirect('not-a-url', 'also-not-a-url')).toBe(false);
  });

  it('handles one invalid URL gracefully', () => {
    expect(isAuthRedirect('https://valid.com', 'not-a-url')).toBe(false);
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

  it('opens a tab, waits for SSO redirect and callback, captures cookies, and closes tab', async () => {
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
      url: 'https://app.example.com',
      timeoutMs: 5000,
      onNotification,
    });

    // Let the initial awaits (createTarget, attachToTarget, Page.enable) complete
    await flushMicrotasks();

    // Phase 1: SSO redirect away from initial hostname — should NOT complete auth
    emit('Page.frameNavigated', {
      sessionId: 'sess-1',
      frame: { url: 'https://login.okta.com/authorize', id: 'main' },
    });

    await flushMicrotasks();

    // Phase 2: Callback redirect back to initial hostname — should complete auth
    emit('Page.frameNavigated', {
      sessionId: 'sess-1',
      frame: { url: 'https://app.example.com/callback', id: 'main' },
    });

    const result = await promise;

    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0].name).toBe('session');
    expect(result.timedOut).toBe(false);
    expect(onNotification).toHaveBeenCalledWith(expect.stringContaining('Authentication requested'));
    expect(onNotification).toHaveBeenCalledWith(expect.stringContaining('Authentication complete'));
    expect(transport.send).toHaveBeenCalledWith('Target.createTarget', { url: 'https://app.example.com', background: false });
    expect(transport.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'tab-auth' });
  });

  it('ignores same-host path changes before leaving initial hostname', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-1' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-path' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://app.example.com',
      timeoutMs: 1000,
    });

    await flushMicrotasks();

    // Same-host path change (e.g. app redirects /login → /login/form) — should NOT complete
    emit('Page.frameNavigated', {
      sessionId: 'sess-path',
      frame: { url: 'https://app.example.com/login/form', id: 'main' },
    });

    // Should time out because we never left the initial hostname
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  it('handles multi-hop SSO chains before callback', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-multi' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-multi' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({
          cookies: [{ name: 'token', value: 'xyz', domain: '.app.navan.com', path: '/', expires: -1, size: 15, httpOnly: true, secure: true, session: true }],
        });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://app.navan.com',
      timeoutMs: 10000,
    });

    await flushMicrotasks();

    // Hop 1: app → login provider
    emit('Page.frameNavigated', {
      sessionId: 'sess-multi',
      frame: { url: 'https://login.navan.com/sso', id: 'main' },
    });
    await flushMicrotasks();

    // Hop 2: login provider → Okta
    emit('Page.frameNavigated', {
      sessionId: 'sess-multi',
      frame: { url: 'https://idp.okta.com/login', id: 'main' },
    });
    await flushMicrotasks();

    // Hop 3: Okta → SAML callback on login provider
    emit('Page.frameNavigated', {
      sessionId: 'sess-multi',
      frame: { url: 'https://login.navan.com/saml/callback', id: 'main' },
    });
    await flushMicrotasks();

    // Hop 4: login provider → back to app (auth complete!)
    emit('Page.frameNavigated', {
      sessionId: 'sess-multi',
      frame: { url: 'https://app.navan.com/dashboard', id: 'main' },
    });

    const result = await promise;

    expect(result.timedOut).toBe(false);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0].name).toBe('token');
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

  it('cleans up event listener on auth completion', async () => {
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
      url: 'https://app.example.com',
      timeoutMs: 10000,
    });

    await flushMicrotasks();

    // Phase 1: leave initial hostname
    emit('Page.frameNavigated', {
      sessionId: 'sess-4',
      frame: { url: 'https://login.example.com/auth', id: 'main' },
    });
    await flushMicrotasks();

    // Phase 2: return to initial hostname
    emit('Page.frameNavigated', {
      sessionId: 'sess-4',
      frame: { url: 'https://app.example.com/home', id: 'main' },
    });

    await promise;

    // Verify cleanup: off should have been called
    expect(transport.off).toHaveBeenCalledWith('Page.frameNavigated', expect.any(Function));
  });

  // -----------------------------------------------------------------------
  // --catch mode tests
  // -----------------------------------------------------------------------

  it('--catch: completes when URL matches the catch regex', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-catch' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-catch' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({
          cookies: [{ name: 'auth', value: '123', domain: '.example.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true }],
        });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://httpbin.org/redirect-to?url=https://httpbin.org/cookies',
      timeoutMs: 5000,
      catchPattern: 'httpbin\\.org/cookies$',
    });

    await flushMicrotasks();

    // Navigation to a non-matching URL — should NOT complete
    emit('Page.frameNavigated', {
      sessionId: 'sess-catch',
      frame: { url: 'https://httpbin.org/redirect-to?url=foo', id: 'main' },
    });
    await flushMicrotasks();

    // Navigation to a matching URL — should complete
    emit('Page.frameNavigated', {
      sessionId: 'sess-catch',
      frame: { url: 'https://httpbin.org/cookies', id: 'main' },
    });

    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0].name).toBe('auth');
  });

  it('--catch: times out when URL never matches the catch regex', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-1' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-no-match' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://example.com/login',
      timeoutMs: 1000,
      catchPattern: 'example\\.com/dashboard',
    });

    await flushMicrotasks();

    // Navigate to a non-matching URL
    emit('Page.frameNavigated', {
      sessionId: 'sess-no-match',
      frame: { url: 'https://example.com/login/step2', id: 'main' },
    });
    await flushMicrotasks();

    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  // -----------------------------------------------------------------------
  // --catch-not mode tests
  // -----------------------------------------------------------------------

  it('--catch-not: completes when URL stops matching the catch-not regex', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-cn' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-cn' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({
          cookies: [{ name: 'session', value: 'abc', domain: '.app.com', path: '/', expires: -1, size: 20, httpOnly: true, secure: true, session: true }],
        });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://app.navan.com/login',
      timeoutMs: 5000,
      catchNotPattern: 'login|okta|saml',
    });

    await flushMicrotasks();

    // First navigation (skipped by catch-not to avoid false positive on initial load)
    emit('Page.frameNavigated', {
      sessionId: 'sess-cn',
      frame: { url: 'https://login.okta.com/authorize', id: 'main' },
    });
    await flushMicrotasks();

    // Second navigation still matches the pattern — should NOT complete
    emit('Page.frameNavigated', {
      sessionId: 'sess-cn',
      frame: { url: 'https://login.okta.com/callback', id: 'main' },
    });
    await flushMicrotasks();

    // Third navigation no longer matches the pattern — should complete
    emit('Page.frameNavigated', {
      sessionId: 'sess-cn',
      frame: { url: 'https://app.navan.com/dashboard', id: 'main' },
    });

    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.cookies).toHaveLength(1);
  });

  it('--catch-not: skips the first navigation event', async () => {
    const { transport, emit } = createFakeTransport();

    (transport.send as ReturnType<typeof vi.fn>)
      .mockImplementation((method: string) => {
        if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'tab-cn2' });
        if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'sess-cn2' });
        if (method === 'Page.enable') return Promise.resolve({});
        if (method === 'Network.getCookies') return Promise.resolve({ cookies: [] });
        if (method === 'Target.closeTarget') return Promise.resolve({});
        return Promise.resolve({});
      });

    const promise = executeTeleportAuth({
      transport,
      url: 'https://example.com',
      timeoutMs: 1000,
      catchNotPattern: 'login',
    });

    await flushMicrotasks();

    // First navigation: URL does NOT match the pattern, but should be skipped
    emit('Page.frameNavigated', {
      sessionId: 'sess-cn2',
      frame: { url: 'https://example.com/dashboard', id: 'main' },
    });
    await flushMicrotasks();

    // Should NOT have completed yet (first nav was skipped) — let it time out
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    const result = await promise;
    expect(result.timedOut).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Backward compat: no pattern falls back to hostname heuristic
  // -----------------------------------------------------------------------

  // (Existing tests already cover the default hostname-return heuristic)

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
      url: 'https://app.example.com',
      timeoutMs: 5000,
    });

    await flushMicrotasks();

    // Phase 1: leave
    emit('Page.frameNavigated', {
      sessionId: 'sess-5',
      frame: { url: 'https://login.example.com/auth', id: 'main' },
    });
    await flushMicrotasks();

    // Phase 2: return
    emit('Page.frameNavigated', {
      sessionId: 'sess-5',
      frame: { url: 'https://app.example.com/callback', id: 'main' },
    });

    // Should not throw even though closeTarget fails
    const result = await promise;
    expect(result.cookies).toEqual([]);
    expect(result.timedOut).toBe(false);
  });
});
