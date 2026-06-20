/**
 * Tests for the generic OAuth service.
 *
 * The CLI launcher (launchOAuthCli) is testable by mocking window globals and
 * simulating postMessage events. The extension launcher requires chrome.runtime
 * and is verified manually.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Stub the window global for Node environment ---

const mockPopup = { close: vi.fn() };
const messageListeners = new Set<Function>();

const MOCK_ORIGIN = 'http://localhost';

const mockWindow = {
  open: vi.fn(() => mockPopup),
  addEventListener: vi.fn((type: string, fn: Function) => {
    if (type === 'message') messageListeners.add(fn);
  }),
  removeEventListener: vi.fn((type: string, fn: Function) => {
    if (type === 'message') messageListeners.delete(fn);
  }),
  location: { origin: MOCK_ORIGIN, pathname: '/', search: '' },
};

vi.stubGlobal('window', mockWindow);

// Stub fetch for the server-side polling fallback (returns 204 = no result yet)
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ status: 204 }))
);

// Default location: standalone CLI. Polling is always on now, so each
// test that cares about poll timing should mockResolvedValue 204 on fetch
// up front (or queue specific responses). Tests that resolve via
// postMessage before the first poll fires (1 s) don't need to.
vi.stubGlobal('location', { pathname: '/', search: '' });

function fireMessage(data: unknown, opts: { origin?: string; source?: object | null } = {}) {
  const origin = opts.origin ?? MOCK_ORIGIN;
  const source = 'source' in opts ? opts.source : mockPopup;
  for (const handler of messageListeners) {
    handler({ data, origin, source } as unknown as MessageEvent);
  }
}

// Import AFTER stubs are in place (module reads `window` at call time)
import {
  createOAuthLauncher,
  getOAuthPageOrigin,
  openIdpLogoutUrl,
} from '../../src/providers/oauth-service.js';

describe('createOAuthLauncher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    messageListeners.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a function (CLI launcher in Node environment)', () => {
    const launcher = createOAuthLauncher();
    expect(typeof launcher).toBe('function');
  });

  it('opens a popup with the authorize URL', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize?client_id=test');

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#access_token=abc123',
    });

    const result = await promise;
    expect(mockWindow.open).toHaveBeenCalledWith(
      'https://idp.example.com/authorize?client_id=test',
      '_blank',
      'width=500,height=700,popup=yes'
    );
    expect(result).toBe('http://localhost:5710/auth/callback#access_token=abc123');
  });

  it('returns null when callback reports an error', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    fireMessage({
      type: 'oauth-callback',
      error: 'access_denied',
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it('ignores unrelated postMessage events', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Fire unrelated messages — should be ignored
    fireMessage({ type: 'unrelated-event' });
    fireMessage({ something: 'else' });
    fireMessage(null);

    // Now fire the real callback
    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=xyz',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=xyz');
  });

  it('returns null on timeout and closes popup', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Advance past the 2-minute timeout
    vi.advanceTimersByTime(120001);

    const result = await promise;
    expect(result).toBeNull();
    expect(mockPopup.close).toHaveBeenCalled();
  });

  it('resolves null when the user closes the OAuth popup (cancelled flow)', async () => {
    // Provide a popup with a mutable `closed` property so we can simulate
    // the user dismissing the window mid-flow.
    let popupClosed = false;
    const cancelPopup = {
      close: vi.fn(),
      get closed() {
        return popupClosed;
      },
    };
    mockWindow.open.mockReturnValueOnce(cancelPopup);

    // Server never has a result (pure user-cancel, no COOP race).
    vi.mocked(fetch).mockResolvedValue({ status: 204 } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Simulate user closing the popup, then advance past the closed-detect
    // interval (500ms) plus the 1500ms grace period that lets the poll timer
    // run one final cycle before giving up.
    popupClosed = true;
    await vi.advanceTimersByTimeAsync(2100);

    const result = await promise;
    expect(result).toBeNull();
  });

  it('resolves with the server result when popup closes mid-COOP relay (race fix)', async () => {
    // Simulate the COOP/Electron race: callback page fires POST to
    // /api/oauth-result then calls window.close() synchronously.  The popup
    // is already closed when the 500ms poll detects it, but the server-side
    // result arrives within the 1500ms grace period.
    let popupClosed = false;
    const cancelPopup = {
      close: vi.fn(),
      get closed() {
        return popupClosed;
      },
    };
    mockWindow.open.mockReturnValueOnce(cancelPopup);

    const mockFetch = vi.mocked(fetch);
    // First server poll (fires at t=1000ms): no result yet — POST still in-flight.
    mockFetch.mockResolvedValueOnce({ status: 204 } as Response);
    // Second server poll (fires at t=2000ms, within the 1500ms grace): result landed.
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          redirectUrl: 'http://localhost:5710/auth/callback#token=coop',
        }),
    } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // t=500ms: closed-poll detects popup closed, starts 1500ms grace.
    popupClosed = true;
    await vi.advanceTimersByTimeAsync(500);
    // t=1000ms: first pollTimer fires → 204, keeps polling.
    await vi.advanceTimersByTimeAsync(500);
    // t=2000ms: second pollTimer fires → result, resolves before grace expires.
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=coop');
  });

  it('cleans up message listener after successful callback', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=abc',
    });

    await promise;

    expect(mockWindow.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('returns null when redirectUrl is missing from callback', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    fireMessage({
      type: 'oauth-callback',
      // no redirectUrl, no error
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it('resolves to null on timeout when window.open returns null (popup blocked)', async () => {
    mockWindow.open.mockReturnValueOnce(null as any);
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    vi.advanceTimersByTime(120001);

    const result = await promise;
    expect(result).toBeNull();
    // Should not throw when trying to close a null popup
  });

  it('resolves via server-side polling in Electron overlay mode', async () => {
    // Simulate Electron overlay URL
    vi.stubGlobal('location', { pathname: '/electron', search: '' });

    const mockFetch = vi.mocked(fetch);
    // First poll: no result yet
    mockFetch.mockResolvedValueOnce({ status: 204 } as Response);
    // Second poll: result available
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          redirectUrl: 'http://localhost:5710/auth/callback#token=polled',
        }),
    } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Advance past first poll (1s) — returns 204
    await vi.advanceTimersByTimeAsync(1000);
    // Advance past second poll (1s) — returns the result
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=polled');

    // Restore default location
    vi.stubGlobal('location', { pathname: '/', search: '' });
  });

  it('polls in standalone CLI mode and postMessage wins the race when it arrives first', async () => {
    vi.stubGlobal('location', { pathname: '/', search: '' });

    const mockFetch = vi.mocked(fetch);
    // Server never has a result during the postMessage window
    mockFetch.mockResolvedValue({ status: 204 } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Let one poll fire and return 204
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledWith('/api/oauth-result', { headers: {} });
    const callsBeforeMessage = mockFetch.mock.calls.length;

    // Now postMessage wins
    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=msg',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=msg');

    // Advance further — poll timer must have been cleared
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockFetch.mock.calls.length).toBe(callsBeforeMessage);
  });

  it('resolves via polling in standalone CLI mode when postMessage never arrives (COOP-severed opener)', async () => {
    vi.stubGlobal('location', { pathname: '/', search: '' });

    const mockFetch = vi.mocked(fetch);
    // First poll: no result yet
    mockFetch.mockResolvedValueOnce({ status: 204 } as Response);
    // Second poll: result available (callback POSTed it after window.opener was severed)
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          redirectUrl: 'http://localhost:5710/auth/callback#token=polled-cli',
        }),
    } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=polled-cli');
  });

  it('resolves null after timeout when the server only ever returns 204', async () => {
    vi.stubGlobal('location', { pathname: '/', search: '' });

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({ status: 204 } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Drive the clock past the 120 s overall timeout while the server
    // keeps returning 204. The promise must resolve null and the popup
    // must be closed.
    await vi.advanceTimersByTimeAsync(120_001);

    const result = await promise;
    expect(result).toBeNull();
    expect(mockPopup.close).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('resolves null and logs when the server returns an error payload', async () => {
    vi.stubGlobal('location', { pathname: '/', search: '' });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ error: 'access_denied' }),
    } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      '[oauth-service] Server relay OAuth error:',
      'access_denied'
    );
    errSpy.mockRestore();
  });

  it('logs and keeps polling when fetch rejects', async () => {
    vi.stubGlobal('location', { pathname: '/', search: '' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockFetch = vi.mocked(fetch);
    // First poll throws, second poll returns the result
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          redirectUrl: 'http://localhost:5710/auth/callback#token=after-error',
        }),
    } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=after-error');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('continues polling on server errors in Electron overlay mode', async () => {
    vi.stubGlobal('location', { pathname: '/electron', search: '' });

    const mockFetch = vi.mocked(fetch);
    // First poll: server error
    mockFetch.mockResolvedValueOnce({ status: 500, ok: false } as Response);
    // Second poll: success
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          redirectUrl: 'http://localhost:5710/auth/callback#token=recovered',
        }),
    } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // First poll — 500 error, caught and retried
    await vi.advanceTimersByTimeAsync(1000);
    // Second poll — success
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=recovered');

    vi.stubGlobal('location', { pathname: '/', search: '' });
  });

  it('does not resolve twice on duplicate callbacks', async () => {
    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=first',
    });

    // Second callback after listener is removed — should be ignored
    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=second',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=first');
  });
});

describe('createOAuthLauncher — OAuth-result poll routing (thin-bridge)', () => {
  // When `setLocalApiBaseUrl` has been called during boot (UI hosted at
  // sliccy.ai, /api on the local node-server) the poll MUST hit the local
  // origin — otherwise the relative `/api/oauth-result` resolves against
  // the wrangler UI host and the SPA index.html is returned as text/html,
  // which fails JSON.parse with "Unexpected token '<'".
  beforeEach(() => {
    vi.useFakeTimers();
    messageListeners.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    vi.useRealTimers();
  });

  it('routes the poll to the configured local API base when bridge mode is active', async () => {
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('bridge-token-abc');

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({ status: 204 } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5710/api/oauth-result', {
      headers: { 'X-Bridge-Token': 'bridge-token-abc' },
    });

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=msg',
    });
    await promise;
  });

  it('omits the bridge token when no local API base is configured (classic CLI)', async () => {
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl(null);
    // Even if a token was set, no base means same-origin and no header.
    setBridgeToken('stray-token');

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({ status: 204 } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledWith('/api/oauth-result', { headers: {} });

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#done',
    });
    await promise;
  });

  it('omits the bridge token when a base is set but no token (defensive)', async () => {
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken(null);

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({ status: 204 } as Response);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5710/api/oauth-result', {
      headers: {},
    });

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#done',
    });
    await promise;
  });
});

describe('getOAuthPageOrigin', () => {
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('reads origin and href from window when available', async () => {
    (globalThis as any).window = {
      location: { origin: 'http://localhost:5711', href: 'http://localhost:5711/?x=1' },
    };
    const info = await getOAuthPageOrigin();
    expect(info.origin).toBe('http://localhost:5711');
    expect(info.href).toBe('http://localhost:5711/?x=1');
  });

  it('routes through panel-RPC when window is undefined (worker context)', async () => {
    delete (globalThis as any).window;
    const callSpy = vi.fn(async (op: string) => {
      expect(op).toBe('page-info');
      return { origin: 'http://localhost:5731', href: 'http://localhost:5731/foo', title: 't' };
    });
    (globalThis as any).__slicc_panelRpc = { call: callSpy, dispose: () => {} };

    const info = await getOAuthPageOrigin();
    expect(callSpy).toHaveBeenCalled();
    expect(info.origin).toBe('http://localhost:5731');
    expect(info.href).toBe('http://localhost:5731/foo');
  });

  it('throws with a clear message when no window and no panel-RPC bridge', async () => {
    delete (globalThis as any).window;
    delete (globalThis as any).__slicc_panelRpc;
    await expect(getOAuthPageOrigin()).rejects.toThrow(/panel-RPC bridge/);
  });
});

describe('openIdpLogoutUrl', () => {
  afterEach(() => {
    // Restore mockWindow so it is available for other describe blocks
    vi.stubGlobal('window', mockWindow);
  });

  it('opens a popup to the given URL with popup=yes in the features string', async () => {
    const closeStub = vi.fn();
    // closed: false so the poll loop does not resolve early; timeout fires first
    vi.stubGlobal('window', { open: vi.fn(() => ({ close: closeStub, closed: false })) });

    await openIdpLogoutUrl('https://idp.example.com/logout', 50);

    expect((window as any).open).toHaveBeenCalledWith(
      'https://idp.example.com/logout',
      '_blank',
      expect.stringContaining('popup=yes')
    );
  });

  it('force-closes the popup and resolves after the timeout when user does not close it', async () => {
    const closeStub = vi.fn();
    vi.stubGlobal('window', { open: vi.fn(() => ({ close: closeStub, closed: false })) });

    await openIdpLogoutUrl('https://idp.example.com/logout', 50);

    expect(closeStub).toHaveBeenCalled();
  });

  it('resolves as soon as the user closes the popup without waiting for the timeout', async () => {
    let closed = false;
    const closeStub = vi.fn(() => {
      closed = true;
    });
    vi.stubGlobal('window', {
      open: vi.fn(() => ({
        close: closeStub,
        get closed() {
          return closed;
        },
      })),
    });

    // Simulate user closing the popup after ~60ms; timeout is 10s so it must
    // be the popup.closed poll (every 500ms in prod, but here we just rely on
    // the popup closing before the deadline).
    setTimeout(() => {
      closed = true;
    }, 60);

    const start = Date.now();
    await openIdpLogoutUrl('https://idp.example.com/logout', 10_000);
    // Should resolve well before the 10s timeout
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('resolves undefined and does not throw when window is undefined (worker runtime)', async () => {
    vi.stubGlobal('window', undefined);

    await expect(openIdpLogoutUrl('https://idp.example.com/logout')).resolves.toBeUndefined();
  });
});

describe('createOAuthLauncher — runtime gating regression', () => {
  // Regression guard for the COOP-polling fix: extension contexts must
  // still route through chrome.identity.launchWebAuthFlow via the
  // service worker, NOT through launchOAuthCli's window.open + polling
  // path. The polling change must not bleed into extension behavior.
  afterEach(() => {
    delete (globalThis as any).chrome;
    vi.resetModules();
  });

  it('extension context (chrome.runtime.id present) routes to launchOAuthExtension, not launchOAuthCli', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    const onMessage = { addListener: vi.fn(), removeListener: vi.fn() };
    (globalThis as any).chrome = {
      runtime: { id: 'test-extension-id', sendMessage, onMessage },
    };

    // Re-import the module so the top-level isExtension flag is recomputed
    // with the chrome stub in place.
    vi.resetModules();
    const mod = await import('../../src/providers/oauth-service.js');
    const launcher = mod.createOAuthLauncher();

    const openCallsBefore = mockWindow.open.mock.calls.length;
    // Fire the launcher; don't await — we just want to see what side
    // effects it produced synchronously.
    void launcher('https://idp.example.com/authorize');
    await Promise.resolve();

    expect(mockWindow.open.mock.calls.length).toBe(openCallsBefore);
    expect(sendMessage).toHaveBeenCalled();
    expect(onMessage.addListener).toHaveBeenCalled();
  });

  it('extension launcher forwards interactive:true into the oauth-request by default', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    const onMessage = { addListener: vi.fn(), removeListener: vi.fn() };
    (globalThis as any).chrome = { runtime: { id: 'test-extension-id', sendMessage, onMessage } };

    vi.resetModules();
    const mod = await import('../../src/providers/oauth-service.js');
    const launcher = mod.createOAuthLauncher();

    void launcher('https://idp.example.com/authorize');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'panel',
        payload: expect.objectContaining({ type: 'oauth-request', interactive: true }),
      })
    );
  });

  it('extension launcher forwards interactive:false when requested (silent renewal)', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    const onMessage = { addListener: vi.fn(), removeListener: vi.fn() };
    (globalThis as any).chrome = { runtime: { id: 'test-extension-id', sendMessage, onMessage } };

    vi.resetModules();
    const mod = await import('../../src/providers/oauth-service.js');
    const launcher = mod.createOAuthLauncher();

    void launcher('https://idp.example.com/authorize', { interactive: false });
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'oauth-request', interactive: false }),
      })
    );
  });
});

describe('createOAuthLauncher — user-activation fast path (Wave 13b)', () => {
  // When a fresh transient user activation exists (e.g. the user just clicked
  // "Login with Adobe" in Settings), `launchOAuthCli` MUST skip the
  // gesture-gated `<slicc-permissions>` prompt and open `window.open`
  // directly. The prompt is only for paths that have lost activation
  // (worker/panel-RPC, agent shell-command).

  // The "runtime gating regression" suite above calls `vi.resetModules()` in
  // its afterEach, which detaches the top-level `createOAuthLauncher` import
  // from the live module graph. Re-import oauth-service + the permissions
  // registry inside each test so both share the same module copy and the
  // `setLeaderPermissionsSurface` writes are visible to `launchOAuthCli`.
  beforeEach(() => {
    vi.useFakeTimers();
    messageListeners.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const { setLeaderPermissionsSurface } = await import(
      '../../src/ui/wc/wc-permissions-registry.js'
    );
    setLeaderPermissionsSurface(null);
    // Restore the suite-wide window stub for the next describe block.
    vi.stubGlobal('window', mockWindow);
  });

  function stubUserActivation(isActive: boolean | undefined): void {
    if (isActive === undefined) {
      vi.stubGlobal('navigator', {});
      return;
    }
    vi.stubGlobal('navigator', { userActivation: { isActive } });
  }

  async function loadFreshOauthService() {
    const oauthMod = await import('../../src/providers/oauth-service.js');
    const registryMod = await import('../../src/ui/wc/wc-permissions-registry.js');
    return { ...oauthMod, ...registryMod };
  }

  it('userActivation.isActive=true: opens window.open directly and does not call surface.prompt', async () => {
    stubUserActivation(true);
    const { createOAuthLauncher, setLeaderPermissionsSurface } = await loadFreshOauthService();
    const prompt = vi.fn();
    setLeaderPermissionsSurface({ prompt } as unknown as Parameters<
      typeof setLeaderPermissionsSurface
    >[0]);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=fast',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=fast');
    expect(mockWindow.open).toHaveBeenCalledWith(
      'https://idp.example.com/authorize',
      '_blank',
      'width=500,height=700,popup=yes'
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('userActivation.isActive=false + surface mounted: routes through surface.prompt with kinds=[popup]', async () => {
    stubUserActivation(false);
    const { createOAuthLauncher, setLeaderPermissionsSurface } = await loadFreshOauthService();
    const fakeWindow = mockPopup as unknown as Window;
    const prompt = vi.fn(async () => ({
      status: 'granted' as const,
      grants: [{ kind: 'popup' as const, window: fakeWindow }],
    }));
    setLeaderPermissionsSurface({ prompt } as unknown as Parameters<
      typeof setLeaderPermissionsSurface
    >[0]);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Let the surface.prompt() microtask resolve so the redirect race wires up.
    await vi.advanceTimersByTimeAsync(0);

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=gated',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=gated');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toMatchObject({
      kinds: ['popup'],
      requestOptions: { popup: { url: 'https://idp.example.com/authorize' } },
    });
    expect(mockWindow.open).not.toHaveBeenCalled();
  });

  it('userActivation.isActive=false + surface cancelled: resolves null cleanly', async () => {
    stubUserActivation(false);
    const { createOAuthLauncher, setLeaderPermissionsSurface } = await loadFreshOauthService();
    const prompt = vi.fn(async () => ({
      status: 'cancelled' as const,
      grants: [],
      reason: 'cancelled' as const,
    }));
    setLeaderPermissionsSurface({ prompt } as unknown as Parameters<
      typeof setLeaderPermissionsSurface
    >[0]);

    const launcher = createOAuthLauncher();
    const result = await launcher('https://idp.example.com/authorize');
    expect(result).toBeNull();
    expect(prompt).toHaveBeenCalled();
    expect(mockWindow.open).not.toHaveBeenCalled();
  });

  it('navigator.userActivation undefined: falls back to surface prompt when mounted', async () => {
    stubUserActivation(undefined);
    const { createOAuthLauncher, setLeaderPermissionsSurface } = await loadFreshOauthService();
    const fakeWindow = mockPopup as unknown as Window;
    const prompt = vi.fn(async () => ({
      status: 'granted' as const,
      grants: [{ kind: 'popup' as const, window: fakeWindow }],
    }));
    setLeaderPermissionsSurface({ prompt } as unknown as Parameters<
      typeof setLeaderPermissionsSurface
    >[0]);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    await vi.advanceTimersByTimeAsync(0);

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=fallback',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=fallback');
    expect(prompt).toHaveBeenCalled();
  });
});
