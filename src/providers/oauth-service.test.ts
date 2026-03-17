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

function fireMessage(data: unknown) {
  for (const handler of messageListeners) {
    handler({ data } as MessageEvent);
  }
}

// Import AFTER stubs are in place (module reads `window` at call time)
import { createOAuthLauncher } from './oauth-service.js';

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
      'width=500,height=700,popup=yes',
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
