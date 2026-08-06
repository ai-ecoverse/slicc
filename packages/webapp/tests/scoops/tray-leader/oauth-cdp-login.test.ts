import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import {
  callbackMatcherFor,
  liftNonceFromState,
  runDelegatedCdpLogin,
} from '../../../src/scoops/tray-leader/oauth-cdp-login.js';

const REDIRECT = 'https://www.sliccy.ai/auth/callback';
const AUTHORIZE = `https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz`;

function createBrowser(opts: { href?: string } = {}) {
  const listeners = new Map<string, Array<(p: Record<string, unknown>) => void>>();
  const transport = {
    on: vi.fn((event: string, cb: (p: Record<string, unknown>) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    }),
    off: vi.fn((event: string, cb: (p: Record<string, unknown>) => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((x) => x !== cb)
      );
    }),
  };
  const browser = {
    createRemotePage: vi.fn(async () => 'tab-1'),
    attachToPage: vi.fn(async () => {}),
    sendCDP: vi.fn(async () => ({})),
    evaluate: vi.fn(async () => opts.href ?? 'https://github.com/login'),
    closePage: vi.fn(async () => {}),
    getTransport: vi.fn(() => transport),
  };
  const emit = (event: string, params: Record<string, unknown>) => {
    for (const cb of listeners.get(event) ?? []) cb(params);
  };
  return { browser: browser as unknown as BrowserAPI, fake: browser, emit };
}

afterEach(() => vi.useRealTimers());

describe('callbackMatcherFor', () => {
  it('derives the terminal callback from the authorize URL, no provider knowledge', () => {
    const match = callbackMatcherFor(AUTHORIZE);
    expect(match).toBeTruthy();
    expect(match?.(`${REDIRECT}?code=abc123&nonce=n1`)).toBe(true);
    expect(match?.(`${REDIRECT}?error=access_denied`)).toBe(true);
  });

  it('does not settle on the callback path before a grant arrives', () => {
    // Mid-flow navigations through the same path must not end the wait.
    const match = callbackMatcherFor(AUTHORIZE);
    expect(match?.(REDIRECT)).toBe(false);
    expect(match?.(`${REDIRECT}?foo=bar`)).toBe(false);
  });

  it('ignores look-alike origins and unrelated pages', () => {
    const match = callbackMatcherFor(AUTHORIZE);
    expect(match?.('https://evil.example/auth/callback?code=abc')).toBe(false);
    expect(match?.('https://github.com/login')).toBe(false);
  });

  it('returns null when there is no redirect_uri to watch', () => {
    expect(callbackMatcherFor('https://github.com/login/oauth/authorize?client_id=abc')).toBeNull();
    expect(callbackMatcherFor('not a url')).toBeNull();
  });
});

describe('liftNonceFromState', () => {
  const stateFor = (nonce: string) =>
    btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce }));

  it('lifts the nonce out of state, as the relay would have', () => {
    // Regression (found live): driving the tab ourselves settles on the
    // relay's ENTRY url, so the provider saw no `nonce` and rejected every
    // delegated login as "OAuth nonce mismatch — possible CSRF".
    const lifted = new URL(
      liftNonceFromState(`${REDIRECT}?code=abc123&state=${encodeURIComponent(stateFor('n-1'))}`)
    );
    expect(lifted.searchParams.get('nonce')).toBe('n-1');
    expect(lifted.searchParams.get('code')).toBe('abc123');
    expect(lifted.searchParams.has('state')).toBe(false);
  });

  it('leaves a url the relay already handled untouched', () => {
    const already = `${REDIRECT}?code=abc123&nonce=n-1`;
    expect(liftNonceFromState(already)).toBe(already);
  });

  it('preserves a mismatched nonce so the CSRF check can still fail', () => {
    // The lift must not invent agreement: a forged state carries its own
    // nonce, which will not match what the provider generated.
    const forged = liftNonceFromState(
      `${REDIRECT}?code=evil&state=${encodeURIComponent(stateFor('attacker'))}`
    );
    expect(new URL(forged).searchParams.get('nonce')).toBe('attacker');
  });

  it('passes through urls with no usable state rather than throwing', () => {
    expect(liftNonceFromState(`${REDIRECT}?code=abc`)).toBe(`${REDIRECT}?code=abc`);
    expect(liftNonceFromState(`${REDIRECT}?code=abc&state=not-base64`)).toBe(
      `${REDIRECT}?code=abc&state=not-base64`
    );
    expect(liftNonceFromState(`${REDIRECT}?state=${encodeURIComponent(btoa('{}'))}`)).toContain(
      'state='
    );
    expect(liftNonceFromState('not a url')).toBe('not a url');
  });
});

describe('runDelegatedCdpLogin', () => {
  it('opens the authorize URL on the follower and resolves on the callback navigation', async () => {
    const { browser, fake, emit } = createBrowser();
    const pending = runDelegatedCdpLogin({
      browser,
      runtimeId: 'runtime-1',
      authorizeUrl: AUTHORIZE,
    });
    await vi.waitFor(() => expect(fake.getTransport).toHaveBeenCalled());

    expect(fake.createRemotePage).toHaveBeenCalledWith('runtime-1', AUTHORIZE);
    // A main-frame commit at the callback settles it — this fires before the
    // callback page's own script can redirect or close the tab.
    emit('Page.frameNavigated', { frame: { url: `${REDIRECT}?code=abc123&nonce=n1` } });

    await expect(pending).resolves.toBe(`${REDIRECT}?code=abc123&nonce=n1`);
    expect(fake.closePage).toHaveBeenCalledWith('runtime-1:tab-1');
  });

  it('ignores sub-frame navigations to the callback', async () => {
    vi.useFakeTimers();
    const { browser, fake, emit } = createBrowser();
    const pending = runDelegatedCdpLogin({
      browser,
      runtimeId: 'runtime-1',
      authorizeUrl: AUTHORIZE,
      timeoutMs: 5_000,
    });
    await vi.waitUntil(() => fake.getTransport.mock.calls.length > 0, { timeout: 2000 });
    emit('Page.frameNavigated', {
      frame: { url: `${REDIRECT}?code=nope`, parentId: 'parent-frame' },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toBeNull();
  });

  it('falls back to polling when the transport never emits navigations', async () => {
    const { browser } = createBrowser({ href: `${REDIRECT}?code=polled` });
    await expect(
      runDelegatedCdpLogin({ browser, runtimeId: 'runtime-1', authorizeUrl: AUTHORIZE })
    ).resolves.toBe(`${REDIRECT}?code=polled`);
  });

  it('gives up and closes the tab when the human never finishes', async () => {
    vi.useFakeTimers();
    const { browser, fake } = createBrowser();
    const pending = runDelegatedCdpLogin({
      browser,
      runtimeId: 'runtime-1',
      authorizeUrl: AUTHORIZE,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBeNull();
    expect(fake.closePage).toHaveBeenCalled();
  });

  it('resolves null and closes the tab when aborted', async () => {
    const { browser, fake } = createBrowser();
    const controller = new AbortController();
    const pending = runDelegatedCdpLogin({
      browser,
      runtimeId: 'runtime-1',
      authorizeUrl: AUTHORIZE,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(fake.closePage).toHaveBeenCalled();
  });

  it('refuses an authorize URL with nothing to watch for', async () => {
    const { browser } = createBrowser();
    await expect(
      runDelegatedCdpLogin({
        browser,
        runtimeId: 'runtime-1',
        authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=abc',
      })
    ).rejects.toThrow(/redirect_uri/);
  });
});
