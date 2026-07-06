// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWelcomeHandoffCard,
  isLoginDipAction,
  showSignInRedirect,
} from '../../../src/ui/wc/wc-signin-redirect.js';

describe('isLoginDipAction', () => {
  it('recognizes the welcome dip provider-login actions', () => {
    expect(isLoginDipAction('oauth-attempt')).toBe(true);
    expect(isLoginDipAction('connect-attempt')).toBe(true);
    expect(isLoginDipAction('device-code-decision')).toBe(true);
  });

  it('does not treat generic dip actions as login', () => {
    expect(isLoginDipAction('connect-ready')).toBe(false);
    expect(isLoginDipAction('use-value')).toBe(false);
    expect(isLoginDipAction('accept')).toBe(false);
    expect(isLoginDipAction('')).toBe(false);
  });
});

describe('showSignInRedirect', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById('slicc-signin-redirect-style')?.remove();
  });

  it('focuses the leader tab immediately and renders a dismissible card', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onOpenTab = vi.fn();

    const card = showSignInRedirect(host, { onOpenTab });

    // Focusing the tab happens up front (login UI lives there).
    expect(onOpenTab).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.wc-signin-redirect')).toBe(card);
    expect(card.textContent).toContain('Sign in from the SLICC tab');
    // Appended at the BOTTOM (not prepended) so it's near the latest message /
    // the button the user just clicked, not off-screen above a scrolled thread.
    expect(host.lastElementChild).toBe(card);
  });

  it('is idempotent — repeated calls reuse the one card (and re-focus the tab)', () => {
    const host = document.createElement('div');
    const onOpenTab = vi.fn();
    const first = showSignInRedirect(host, { onOpenTab });
    const second = showSignInRedirect(host, { onOpenTab });
    expect(second).toBe(first);
    expect(host.querySelectorAll('.wc-signin-redirect')).toHaveLength(1);
    // Each call re-focuses the leader tab.
    expect(onOpenTab).toHaveBeenCalledTimes(2);
  });

  it('the "Open SLICC tab" button re-focuses the leader tab; × dismisses the card', () => {
    const host = document.createElement('div');
    const onOpenTab = vi.fn();
    const card = showSignInRedirect(host, { onOpenTab }); // 1 call
    (card.querySelector('.wc-signin-redirect__open') as HTMLButtonElement).click(); // 2
    expect(onOpenTab).toHaveBeenCalledTimes(2);
    (card.querySelector('.wc-signin-redirect__x') as HTMLButtonElement).click();
    expect(host.querySelector('.wc-signin-redirect')).toBeNull();
  });
});

describe('buildWelcomeHandoffCard', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById('slicc-signin-redirect-style')?.remove();
  });

  it('returns a detached card and does NOT focus the tab on build', () => {
    const onOpenTab = vi.fn();
    const card = buildWelcomeHandoffCard(document, { onOpenTab });
    expect(card.className).toBe('wc-signin-redirect');
    expect(card.textContent).toContain('Set up SLICC in the main tab');
    // The user hasn't acted yet — building the card must not open the tab.
    expect(onOpenTab).not.toHaveBeenCalled();
    // Detached: the caller inserts it in place of the welcome dip.
    expect(card.isConnected).toBe(false);
  });

  it('focuses the leader tab only when the button is clicked', () => {
    const onOpenTab = vi.fn();
    const card = buildWelcomeHandoffCard(document, { onOpenTab });
    (card.querySelector('.wc-signin-redirect__open') as HTMLButtonElement).click();
    expect(onOpenTab).toHaveBeenCalledTimes(1);
  });

  it('is NOT dismissible (no × button — dismissing would leave nothing)', () => {
    const card = buildWelcomeHandoffCard(document, { onOpenTab: vi.fn() });
    expect(card.querySelector('.wc-signin-redirect__x')).toBeNull();
  });
});
