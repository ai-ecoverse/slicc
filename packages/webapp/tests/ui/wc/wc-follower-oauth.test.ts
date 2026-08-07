// @vitest-environment jsdom
/**
 * Follower-side delegated OAuth (#1915): approval prompt, popup opened inside
 * the resulting click, and a callback race that survives COOP severing
 * `window.opener` (BroadcastChannel) as well as the classic postMessage.
 */

import type { SliccPermissions } from '@slicc/webcomponents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectedNonceFromAuthorizeUrl,
  openDelegatedOAuthPopup,
} from '../../../src/ui/wc/wc-follower-oauth.js';

const RELAY_CHANNEL = 'slicc-oauth-relay';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=abc';
const CALLBACK_URL = 'https://www.sliccy.ai/auth/callback?code=abc123&nonce=n1';

function makeSurface(
  result: { status: string; grants?: Array<{ kind: string; window: Window | null }> },
  popupWindow: Window | null = { closed: false, close: vi.fn() } as unknown as Window
): SliccPermissions {
  return {
    prompt: vi.fn(async () => ({
      status: result.status,
      grants: result.grants ?? [{ kind: 'popup', window: popupWindow }],
    })),
  } as unknown as SliccPermissions;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('openDelegatedOAuthPopup', () => {
  it('prompts for approval and resolves with the callback broadcast by the relay', async () => {
    const surface = makeSurface({ status: 'granted' });
    const pending = openDelegatedOAuthPopup(AUTHORIZE_URL, new AbortController().signal, {
      getPermissionsSurface: () => surface,
      window,
    });

    // The popup URL rides the permission request, so the component can open it
    // inside the user's Continue click.
    await vi.waitFor(() => {
      expect(surface.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          kinds: ['popup'],
          requestOptions: { popup: { url: AUTHORIZE_URL } },
        })
      );
    });

    const channel = new BroadcastChannel(RELAY_CHANNEL);
    channel.postMessage({ type: 'oauth-callback', redirectUrl: CALLBACK_URL });
    channel.close();

    await expect(pending).resolves.toBe(CALLBACK_URL);
  });

  it('accepts the same-origin opener postMessage as the second signal', async () => {
    const surface = makeSurface({ status: 'granted' });
    const pending = openDelegatedOAuthPopup(AUTHORIZE_URL, new AbortController().signal, {
      getPermissionsSurface: () => surface,
      window,
    });
    await vi.waitFor(() => expect(surface.prompt).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'oauth-callback', redirectUrl: CALLBACK_URL },
      })
    );

    await expect(pending).resolves.toBe(CALLBACK_URL);
  });

  it('ignores a callback claiming to come from another origin', async () => {
    vi.useFakeTimers();
    const surface = makeSurface({ status: 'granted' });
    const controller = new AbortController();
    const pending = openDelegatedOAuthPopup(AUTHORIZE_URL, controller.signal, {
      getPermissionsSurface: () => surface,
      window,
    });
    await vi.waitFor(() => expect(surface.prompt).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'oauth-callback', redirectUrl: 'https://evil.example/stolen' },
      })
    );
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null when the human declines the prompt', async () => {
    const surface = makeSurface({ status: 'denied' });
    await expect(
      openDelegatedOAuthPopup(AUTHORIZE_URL, new AbortController().signal, {
        getPermissionsSurface: () => surface,
        window,
      })
    ).resolves.toBeNull();
  });

  it('throws when no permissions surface can host the prompt', async () => {
    await expect(
      openDelegatedOAuthPopup(AUTHORIZE_URL, new AbortController().signal, {
        getPermissionsSurface: () => null,
        window,
      })
    ).rejects.toThrow('no permissions surface');
  });

  it('resolves null when the leader aborts (disconnect)', async () => {
    const surface = makeSurface({ status: 'granted' });
    const controller = new AbortController();
    const pending = openDelegatedOAuthPopup(AUTHORIZE_URL, controller.signal, {
      getPermissionsSurface: () => surface,
      window,
    });
    await vi.waitFor(() => expect(surface.prompt).toHaveBeenCalled());
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it('ignores a broadcast callback belonging to another same-origin flow', async () => {
    // The relay's channel reaches every SLICC tab on this origin. Without the
    // nonce filter, a second tab's login would settle this one (and vice
    // versa) — the wrong URL against the wrong flow.
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'mine' }));
    const url = `https://github.com/login/oauth/authorize?client_id=abc&state=${state}`;
    const surface = makeSurface({ status: 'granted' });
    const pending = openDelegatedOAuthPopup(url, new AbortController().signal, {
      getPermissionsSurface: () => surface,
      window,
    });
    await vi.waitFor(() => expect(surface.prompt).toHaveBeenCalled());

    const channel = new BroadcastChannel(RELAY_CHANNEL);
    channel.postMessage({
      type: 'oauth-callback',
      redirectUrl: 'https://www.sliccy.ai/auth/callback?code=theirs&nonce=theirs',
      nonce: 'theirs',
    });
    // Ours lands next and must be the one that settles it.
    channel.postMessage({ type: 'oauth-callback', redirectUrl: CALLBACK_URL, nonce: 'mine' });
    channel.close();

    await expect(pending).resolves.toBe(CALLBACK_URL);
  });

  it('accepts an un-correlated callback so an older relay still works', async () => {
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'mine' }));
    const url = `https://github.com/login/oauth/authorize?client_id=abc&state=${state}`;
    const surface = makeSurface({ status: 'granted' });
    const pending = openDelegatedOAuthPopup(url, new AbortController().signal, {
      getPermissionsSurface: () => surface,
      window,
    });
    await vi.waitFor(() => expect(surface.prompt).toHaveBeenCalled());

    const channel = new BroadcastChannel(RELAY_CHANNEL);
    // No nonce on the message: a relay that predates the correlation id.
    channel.postMessage({ type: 'oauth-callback', redirectUrl: CALLBACK_URL });
    channel.close();

    await expect(pending).resolves.toBe(CALLBACK_URL);
  });

  it('gives up after the shared 120s budget', async () => {
    vi.useFakeTimers();
    const surface = makeSurface({ status: 'granted' });
    const pending = openDelegatedOAuthPopup(AUTHORIZE_URL, new AbortController().signal, {
      getPermissionsSurface: () => surface,
      window,
    });
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(pending).resolves.toBeNull();
  });
});

describe('expectedNonceFromAuthorizeUrl', () => {
  it('reads the nonce the leader embedded in the OAuth state', () => {
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'n1' }));
    expect(
      expectedNonceFromAuthorizeUrl(`https://github.com/login/oauth/authorize?state=${state}`)
    ).toBe('n1');
  });

  it('returns null when there is nothing to correlate on', () => {
    // No state, opaque state, and a malformed URL all fall back to accepting
    // any callback rather than rejecting every one.
    expect(expectedNonceFromAuthorizeUrl('https://github.com/login/oauth/authorize')).toBeNull();
    expect(
      expectedNonceFromAuthorizeUrl('https://provider.example/authorize?state=opaque-token')
    ).toBeNull();
    expect(expectedNonceFromAuthorizeUrl('not a url')).toBeNull();
  });
});
