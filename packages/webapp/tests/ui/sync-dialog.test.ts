// @vitest-environment jsdom
/**
 * DOM tests for `showSyncEnabledDialog` — the session-sharing dialog reached
 * from the avatar menu ("Enable multi-browser sync") and from the floatbar's
 * followers segment. Stubs the clipboard module so the copy buttons can be
 * exercised without the browser's real clipboard API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ui/clipboard.js', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

import type { ConnectedFollowerInfo } from '../../src/shell/supplemental-commands/host-command.js';
import { copyTextToClipboard } from '../../src/ui/clipboard.js';
import { FOLLOWERS_CHANGED_EVENT } from '../../src/ui/follower-presentation.js';
import { showSyncEnabledDialog } from '../../src/ui/sync-dialog.js';

const mockedCopy = vi.mocked(copyTextToClipboard);
const JOIN_URL = 'https://tray.example.com/join/s3cr3t-token';

function overlayEl(): HTMLElement {
  return document.querySelector('.dialog-overlay[data-sync-dialog]') as HTMLElement;
}

function buttonByText(pattern: RegExp): HTMLButtonElement {
  return Array.from(overlayEl().querySelectorAll('button')).find((b) =>
    pattern.test(b.textContent ?? '')
  ) as HTMLButtonElement;
}

function tabIds(): string[] {
  return Array.from(overlayEl().querySelectorAll('[role="tab"]')).map(
    (el) => (el as HTMLElement).dataset.tab ?? ''
  );
}

function activeTab(): string {
  const el = overlayEl().querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
  return el?.dataset.tab ?? '';
}

function clickTab(id: string): void {
  (overlayEl().querySelector(`[role="tab"][data-tab="${id}"]`) as HTMLButtonElement).click();
}

const cliFollower: ConnectedFollowerInfo = {
  runtimeId: 'follower-abc123def456',
  runtime: 'slicc-cli',
  connectedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  health: 'live',
  peerState: 'connected',
  exec: true,
  motd: 'slicc-cli exec target · lars@build-box',
};

const iosFollower: ConnectedFollowerInfo = {
  runtimeId: 'follower-ios999',
  runtime: 'slicc-ios',
  floatType: 'ios',
  health: 'live',
  peerState: 'connected',
};

beforeEach(() => {
  // Close (don't just detach) any dialog a previous test left up: the module
  // tracks the live instance so it can tear down its listeners on re-open, and
  // `replaceChildren` alone would leave that state pointing at a dead dialog.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  document.body.replaceChildren();
  mockedCopy.mockReset();
  mockedCopy.mockResolvedValue(true);
});

describe('showSyncEnabledDialog', () => {
  it('mounts an overlay titled "Session sharing"', () => {
    showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true });
    expect(overlayEl()).not.toBeNull();
    expect(overlayEl().querySelector('.dialog__title')!.textContent).toBe('Session sharing');
    expect(overlayEl().textContent).toContain('Join link copied to clipboard');
  });

  it('removes any pre-existing instance before mounting (idempotent)', () => {
    showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true });
    showSyncEnabledDialog({ joinUrl: 'https://tray.example.com/join/second', copied: true });
    expect(document.querySelectorAll('.dialog-overlay[data-sync-dialog]')).toHaveLength(1);
  });

  describe('tabs', () => {
    it('shows the three how-to tabs and starts on Browser when nothing is connected', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      expect(tabIds()).toEqual(['browser', 'iphone', 'terminal']);
      expect(activeTab()).toBe('browser');
    });

    it('adds Status as the first tab and opens on it when a follower is connected', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, followers: [cliFollower] });
      expect(tabIds()).toEqual(['status', 'browser', 'iphone', 'terminal']);
      expect(activeTab()).toBe('status');
      expect(overlayEl().querySelector('[role="tab"][data-tab="status"]')!.textContent).toContain(
        '1'
      );
    });

    it('honours an explicit initialTab', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'terminal' });
      expect(activeTab()).toBe('terminal');
    });

    it('falls back to Browser when initialTab is status but nothing is connected', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'status' });
      expect(activeTab()).toBe('browser');
    });
  });

  describe('the join link', () => {
    it('masks the token until Show is clicked', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      const url = overlayEl().querySelector('[data-join-url]') as HTMLElement;
      expect(url.textContent).not.toContain('s3cr3t-token');
      expect(url.textContent).toContain('••••••••');

      buttonByText(/^Show$/).click();
      expect((overlayEl().querySelector('[data-join-url]') as HTMLElement).textContent).toContain(
        's3cr3t-token'
      );
    });

    it('copies the unmasked link', async () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      buttonByText(/Copy join link/).click();
      await Promise.resolve();
      expect(mockedCopy).toHaveBeenCalledWith(JOIN_URL);
      expect(overlayEl().textContent).toContain('Join link copied.');
    });

    it('surfaces a manual-copy hint when the clipboard write fails', async () => {
      mockedCopy.mockResolvedValueOnce(false);
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      buttonByText(/Copy join link/).click();
      await Promise.resolve();
      await Promise.resolve();
      expect(overlayEl().textContent).toMatch(/copy it manually/);
    });
  });

  describe('the Terminal tab', () => {
    it('leads with installing the CLI, so `slicc` exists before it is invoked', async () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'terminal' });
      const install = overlayEl().querySelector('[data-command="copy-install"]') as HTMLElement;
      expect(install.textContent).toBe('curl -fsSL https://tray.example.com/install-cli | sh');
      expect(overlayEl().textContent).toMatch(/Windows: irm .*\/install-cli\.ps1 \| iex/);

      buttonByText(/Copy install command/).click();
      await Promise.resolve();
      expect(mockedCopy).toHaveBeenCalledWith(
        'curl -fsSL https://tray.example.com/install-cli | sh'
      );
    });

    it('offers a runner-bearing follow command and copies it unmasked', async () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'terminal' });
      const command = overlayEl().querySelector('[data-command="copy-command"]') as HTMLElement;
      expect(command.textContent).toMatch(
        /^slicc https:\/\/tray\.example\.com\/join\/•+ follow bash -c$/
      );

      buttonByText(/^Copy command$/).click();
      await Promise.resolve();
      expect(mockedCopy).toHaveBeenCalledWith(`slicc ${JOIN_URL} follow bash -c`);
    });

    it('warns that the leader gets to run commands there', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'terminal' });
      expect(overlayEl().textContent).toMatch(/run commands on that machine/);
    });
  });

  describe('the iPhone tab', () => {
    it('names both routes: paste into Settings, or pick it up from iCloud', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'iphone' });
      expect(overlayEl().textContent).toMatch(/Settings → Join link/);
      expect(overlayEl().textContent).toMatch(/iCloud Sessions/);
    });
  });

  describe('the Status tab', () => {
    it('renders one row per follower with its capability chips', () => {
      showSyncEnabledDialog({
        joinUrl: JOIN_URL,
        copied: false,
        followers: [cliFollower, iosFollower],
      });
      const rows = overlayEl().querySelectorAll('[data-follower]');
      expect(rows).toHaveLength(2);
      expect(overlayEl().textContent).toContain('CLI · abc123def456');
      expect(overlayEl().textContent).toContain('iOS · ios999');
      expect(overlayEl().textContent).toContain('can run commands');
      expect(overlayEl().textContent).toContain('lars@build-box');
    });

    it('appears live when the first follower connects, without switching tabs', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      expect(tabIds()).not.toContain('status');

      window.dispatchEvent(
        new CustomEvent(FOLLOWERS_CHANGED_EVENT, { detail: { followers: [cliFollower] } })
      );
      expect(tabIds()).toEqual(['status', 'browser', 'iphone', 'terminal']);
      expect(activeTab()).toBe('browser');

      clickTab('status');
      expect(overlayEl().querySelectorAll('[data-follower]')).toHaveLength(1);
    });

    it('drops back out of the Status tab when the last follower leaves', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, followers: [cliFollower] });
      expect(activeTab()).toBe('status');
      window.dispatchEvent(new CustomEvent(FOLLOWERS_CHANGED_EVENT, { detail: { followers: [] } }));
      expect(tabIds()).toEqual(['browser', 'iphone', 'terminal']);
      expect(activeTab()).toBe('browser');
    });

    it('re-opening tears the previous instance down — no orphaned roster listener', () => {
      // The leak is invisible in the DOM (an orphaned instance re-renders into
      // its own detached tree), so count the registrations instead: every
      // roster listener a dialog adds must come back off.
      const added = vi.spyOn(window, 'addEventListener');
      const removed = vi.spyOn(window, 'removeEventListener');
      // The DOM lib types `type` against the ambient global's event map, which
      // knows nothing of our custom event name — compare as plain strings.
      const countFor = (spy: typeof added) =>
        spy.mock.calls.filter(([type]) => String(type) === FOLLOWERS_CHANGED_EVENT).length;

      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      const addedAfterFirst = countFor(added);
      const removedAfterFirst = countFor(removed);

      // Re-open, the way the avatar menu and the floatbar segment can in turn.
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, initialTab: 'terminal' });
      expect(document.querySelectorAll('.dialog-overlay[data-sync-dialog]')).toHaveLength(1);
      expect(countFor(added) - addedAfterFirst).toBe(1);
      // The first instance's listener came off when the second replaced it.
      expect(countFor(removed) - removedAfterFirst).toBe(1);

      buttonByText(/^Done$/).click();
      expect(countFor(removed) - removedAfterFirst).toBe(2);

      window.dispatchEvent(
        new CustomEvent(FOLLOWERS_CHANGED_EVENT, { detail: { followers: [cliFollower] } })
      );
      expect(document.querySelector('[data-follower]')).toBeNull();
      added.mockRestore();
      removed.mockRestore();
    });

    it('a re-opened dialog still closes on Escape (its listener is the live one)', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(overlayEl()).toBeNull();
    });

    it('stops listening for roster changes once closed', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false });
      buttonByText(/^Done$/).click();
      window.dispatchEvent(
        new CustomEvent(FOLLOWERS_CHANGED_EVENT, { detail: { followers: [cliFollower] } })
      );
      expect(overlayEl()).toBeNull();
    });
  });

  describe('revoking the link', () => {
    it('is offered only when onReset is supplied', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true });
      expect(buttonByText(/Revoke/)).toBeUndefined();
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true, onReset: async () => {} });
      expect(buttonByText(/Revoke/)).toBeDefined();
    });

    it('arms first, naming how many devices it will disconnect', async () => {
      const onReset = vi.fn(async () => {});
      showSyncEnabledDialog({
        joinUrl: JOIN_URL,
        copied: true,
        onReset,
        followers: [cliFollower, iosFollower],
      });
      const revoke = buttonByText(/Revoke link/);
      revoke.click();
      await Promise.resolve();
      expect(onReset).not.toHaveBeenCalled();
      expect(revoke.textContent).toMatch(/2 connected devices will be disconnected/);

      revoke.click();
      await Promise.resolve();
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it('goes red only once armed — the idle button is not the destructive one', async () => {
      showSyncEnabledDialog({
        joinUrl: JOIN_URL,
        copied: true,
        onReset: async () => {},
        followers: [cliFollower],
      });
      const revoke = buttonByText(/Revoke link/);
      expect(revoke.dataset.armed).toBe('0');
      expect(revoke.style.background).toBe('');

      revoke.click();
      await Promise.resolve();
      expect(revoke.dataset.armed).toBe('1');
      expect(revoke.style.background).toBe('var(--s2-negative)');
    });

    it('disarms — and drops the red — when the reset fails', async () => {
      showSyncEnabledDialog({
        joinUrl: JOIN_URL,
        copied: true,
        onReset: async () => {
          throw new Error('boom');
        },
      });
      const revoke = buttonByText(/Revoke link/);
      revoke.click();
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(revoke.dataset.armed).toBe('0');
      expect(revoke.style.background).toBe('');
    });

    it('reports success and stops offering the stale link', async () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true, onReset: async () => {} });
      const revoke = buttonByText(/Revoke link/);
      revoke.click();
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(overlayEl().textContent).toMatch(/Join link revoked/);
      expect(revoke.disabled).toBe(true);
    });

    it('re-enables and explains itself when the reset fails', async () => {
      const onReset = vi.fn(async () => {
        throw new Error('boom');
      });
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true, onReset });
      const revoke = buttonByText(/Revoke link/);
      revoke.click();
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(overlayEl().textContent).toMatch(/Revoke failed: boom/);
      expect(revoke.disabled).toBe(false);
      expect(buttonByText(/^Done$/).disabled).toBe(false);
    });

    it('surfaces a non-Error rejection as a string', async () => {
      const onReset = vi.fn(async () => {
        throw 'string-reason';
      });
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true, onReset });
      const revoke = buttonByText(/Revoke link/);
      revoke.click();
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(overlayEl().textContent).toMatch(/Revoke failed: string-reason/);
    });
  });

  describe('contrast', () => {
    it('states an explicit color on its text — `.dialog` only colors its own title/desc classes', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, followers: [cliFollower] });
      const uncolored = Array.from(overlayEl().querySelectorAll('div')).filter((node) => {
        const el = node as HTMLElement;
        // Layout-only wrappers carry no text of their own.
        const ownText = Array.from(el.childNodes).some(
          (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== ''
        );
        return ownText && el.style.color === '' && !el.className.startsWith('dialog__');
      });
      expect(uncolored.map((el) => el.textContent)).toEqual([]);
    });

    it('uses the themed semantic colors for follower state, not hardcoded hexes', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: false, followers: [cliFollower] });
      const dot = overlayEl().querySelector('[data-follower] span') as HTMLElement;
      expect(overlayEl().innerHTML).not.toMatch(/#22c55e|#f59e0b/);
      expect(dot).toBeTruthy();
    });
  });

  describe('dismissal', () => {
    it('closes on Done', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true });
      buttonByText(/^Done$/).click();
      expect(overlayEl()).toBeNull();
    });

    it('closes on backdrop click but not on an inner click', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true });
      (overlayEl().querySelector('.dialog') as HTMLElement).click();
      expect(overlayEl()).not.toBeNull();
      overlayEl().click();
      expect(overlayEl()).toBeNull();
    });

    it('closes on Escape', () => {
      showSyncEnabledDialog({ joinUrl: JOIN_URL, copied: true });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(overlayEl()).toBeNull();
    });
  });
});
