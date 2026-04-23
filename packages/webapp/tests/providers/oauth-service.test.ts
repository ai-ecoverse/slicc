/**
 * Tests for the generic OAuth service.
 *
 * The CLI launcher (launchOAuthCli) is testable by mocking window globals and
 * simulating postMessage events. The extension launcher requires chrome.runtime
 * and is verified manually.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Stub the window global for Node environment ---

const mockPopup = { close: vi.fn() };
const messageListeners = new Set<Function>();

const mockWindow = {
  open: vi.fn(() => mockPopup),
  addEventListener: vi.fn((type: string, fn: Function) => {
    if (type === 'message') messageListeners.add(fn);
  }),
  removeEventListener: vi.fn((type: string, fn: Function) => {
    if (type === 'message') messageListeners.delete(fn);
  }),
};

vi.stubGlobal('window', mockWindow);

// Stub fetch for the server-side polling fallback (returns 204 = no result yet)
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ status: 204 }))
);

// Default location: standalone CLI (no polling)
vi.stubGlobal('location', { pathname: '/', search: '' });

function fireMessage(data: unknown) {
  for (const handler of messageListeners) {
    handler({ data } as MessageEvent);
  }
}

// Import AFTER stubs are in place (module reads `window` at call time)
import { createOAuthLauncher } from '../../src/providers/oauth-service.js';

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

  it('does not poll in standalone CLI mode', async () => {
    vi.stubGlobal('location', { pathname: '/', search: '' });

    const mockFetch = vi.mocked(fetch);

    const launcher = createOAuthLauncher();
    const promise = launcher('https://idp.example.com/authorize');

    // Advance past where polling would fire
    await vi.advanceTimersByTimeAsync(2000);

    // fetch should NOT have been called (no polling in standalone mode)
    expect(mockFetch).not.toHaveBeenCalled();

    // Resolve via postMessage
    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#token=msg',
    });

    const result = await promise;
    expect(result).toBe('http://localhost:5710/auth/callback#token=msg');
  });

  it('continues polling on server errors in Electron overlay mode', async () => {
    vi.stubGlobal('location', { pathname: '/electron', search: '' });

    const mockFetch = vi.mocked(fetch);
    // First poll: server error
    mockFetch.mockResolvedValueOnce({ status: 500 } as Response);
    // Second poll: success
    mockFetch.mockResolvedValueOnce({
      status: 200,
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

  it('reuses a prewarmed placeholder popup instead of calling window.open again', async () => {
    // Prevents popup-blocker blocks for providers that await async config
    // work before calling the launcher — the caller opens `about:blank`
    // inside the user-gesture click handler and hands that handle here.
    const prewarmed = {
      closed: false,
      close: vi.fn(),
      location: { href: 'about:blank' },
    } as unknown as Window;
    const launcher = createOAuthLauncher(prewarmed);
    const promise = launcher('https://idp.example.com/authorize?client_id=test');

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#access_token=prewarmed',
    });

    const result = await promise;
    expect(mockWindow.open).not.toHaveBeenCalled();
    expect((prewarmed as unknown as { location: { href: string } }).location.href).toBe(
      'https://idp.example.com/authorize?client_id=test'
    );
    expect(result).toBe('http://localhost:5710/auth/callback#access_token=prewarmed');
  });

  it('falls back to window.open when the prewarmed popup has been closed', async () => {
    const prewarmed = {
      closed: true,
      close: vi.fn(),
      location: { href: 'about:blank' },
    } as unknown as Window;
    const launcher = createOAuthLauncher(prewarmed);
    const promise = launcher('https://idp.example.com/authorize');

    fireMessage({
      type: 'oauth-callback',
      redirectUrl: 'http://localhost:5710/auth/callback#access_token=fallback',
    });

    await promise;
    expect(mockWindow.open).toHaveBeenCalled();
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
