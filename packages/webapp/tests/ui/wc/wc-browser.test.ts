// @vitest-environment jsdom
/**
 * Browser · CDP workbench tests: the dock globe opens the tab overlay with
 * every target (local + tray followers), thumbnails stream in lazily, cards
 * activate/close tabs through the BrowserAPI.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import '@slicc/webcomponents';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import { teleportTabOneWay } from '../../../src/scoops/tray-leader/tab-teleport.js';
import { wireWcBrowser } from '../../../src/ui/wc/wc-browser.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

vi.mock('../../../src/scoops/tray-leader/tab-teleport.js', () => ({
  teleportTabOneWay: vi.fn(async () => ({
    targetId: 'pulled-tab',
    url: 'https://dash.example',
    cookieCount: 1,
    storageEntryCount: 0,
    degraded: 'none' as const,
  })),
}));

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeFakeBrowser() {
  return {
    listAllTargets: vi.fn(async () => [
      { targetId: 'local-1', title: 'Docs', url: 'https://docs.example' },
      // A tray follower's tab: composite id — its CDP traffic (including the
      // screenshot) rides the federated WebRTC channel.
      { targetId: 'follower-9:tab-2', title: 'Dashboard', url: 'https://dash.example' },
    ]),
    attachToPage: vi.fn(async () => 'session-1'),
    getAttachedTargetId: vi.fn(() => 'agent-page'),
    screenshot: vi.fn(async () => 'BASE64'),
    bringToFront: vi.fn(async () => undefined),
    closePage: vi.fn(async () => undefined),
  };
}

function makeRefs(): WcShellRefs {
  const dock = document.createElement('slicc-dock');
  document.body.append(dock);
  return { dock, overlaySurfaces: new Set<string>() } as unknown as WcShellRefs;
}

type OverlayEl = HTMLElement & { tabs: Array<{ id: string; screenshot?: string }> };

describe('wireWcBrowser', () => {
  // Regression (#1706): the shell's dock handler skips the workbench pane only
  // for surfaces an overlay has claimed. Claiming here — rather than the shell
  // hardcoding 'browser' — is what keeps the pane fallback alive on floats that
  // never reach this wiring (followers, cherry, extension).
  it('claims the browser surface so the shell stops opening a pane behind it', () => {
    const refs = makeRefs();
    expect(refs.overlaySurfaces.has('browser')).toBe(false);

    wireWcBrowser({ refs, browser: makeFakeBrowser() as unknown as BrowserAPI, log });

    expect(refs.overlaySurfaces.has('browser')).toBe(true);
  });

  it('opens the overlay on the browser dock item with every target + lazy thumbnails', async () => {
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    const { overlay } = wireWcBrowser({ refs, browser: browser as unknown as BrowserAPI, log });

    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'browser' } })
    );
    await vi.waitFor(() => {
      expect((overlay as OverlayEl).tabs).toHaveLength(2);
    });
    expect(overlay.hasAttribute('open')).toBe(true);
    // One-shot launcher: the dock never latches browser as the active item.
    expect(refs.dock.getAttribute('active')).toBeNull();
    // Thumbnails attach per target — including the follower composite id,
    // whose capture beams over the WebRTC-backed remote transport.
    await vi.waitFor(() => {
      expect(browser.attachToPage).toHaveBeenCalledWith('follower-9:tab-2');
      expect((overlay as OverlayEl).tabs.every((t) => t.screenshot?.startsWith('data:'))).toBe(
        true
      );
    });

    // Other dock items never trigger it.
    browser.listAllTargets.mockClear();
    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'files' } })
    );
    expect(browser.listAllTargets).not.toHaveBeenCalled();
  });

  it('activating a local card attaches + foregrounds the tab and closes the overlay', async () => {
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();

    overlay.dispatchEvent(new CustomEvent('tab-activate', { detail: { id: 'local-1' } }));
    await vi.waitFor(() => {
      expect(browser.bringToFront).toHaveBeenCalled();
    });
    expect(browser.attachToPage).toHaveBeenCalledWith('local-1');
    expect(overlay.hasAttribute('open')).toBe(false);
    expect(vi.mocked(teleportTabOneWay)).not.toHaveBeenCalled();
  });

  it("activating a follower's card pulls a state-carrying copy to the leader", async () => {
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();

    overlay.dispatchEvent(new CustomEvent('tab-activate', { detail: { id: 'follower-9:tab-2' } }));
    await vi.waitFor(() => {
      expect(vi.mocked(teleportTabOneWay)).toHaveBeenCalledWith(browser, {
        sourceTargetId: 'follower-9:tab-2',
        destination: { kind: 'leader' },
      });
    });
    expect(overlay.hasAttribute('open')).toBe(false);
    // Focusing the follower's tab over there would not help THIS user.
    expect(browser.bringToFront).not.toHaveBeenCalled();
  });

  it('keeps the overlay open when the pull fails', async () => {
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    vi.mocked(teleportTabOneWay).mockRejectedValueOnce(new Error('no eligible source'));
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();

    overlay.dispatchEvent(new CustomEvent('tab-activate', { detail: { id: 'follower-9:tab-2' } }));
    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        'WC browser overlay: tab activate failed',
        expect.any(Error)
      );
    });
    expect(overlay.hasAttribute('open')).toBe(true);
  });

  it('closing a card closes the tab and refreshes the grid', async () => {
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();
    browser.listAllTargets.mockClear();

    overlay.dispatchEvent(new CustomEvent('tab-close', { detail: { id: 'local-1' } }));
    await vi.waitFor(() => {
      expect(browser.closePage).toHaveBeenCalledWith('local-1');
      expect(browser.listAllTargets).toHaveBeenCalled();
    });
  });

  it('a failing thumbnail keeps the card with its placeholder', async () => {
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    browser.screenshot.mockRejectedValue(new Error('occluded'));
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();
    expect((overlay as OverlayEl).tabs).toHaveLength(2);
    expect((overlay as OverlayEl).tabs.every((t) => t.screenshot === undefined)).toBe(true);
  });
});

describe('peek', () => {
  /** SLICC's own tab, which the refresh hides from the grid but a peek returns to. */
  function browserWithSelf() {
    const browser = makeFakeBrowser();
    browser.listAllTargets = vi.fn(async () => [
      { targetId: 'local-1', title: 'Docs', url: 'https://docs.example' },
      { targetId: 'slicc-self', title: 'SLICC', url: location.href },
    ]);
    return browser;
  }

  async function openOverlay(browser: ReturnType<typeof makeFakeBrowser>) {
    const refs = makeRefs();
    const handle = wireWcBrowser({ refs, browser: browser as unknown as BrowserAPI, log });
    await handle.refresh();
    return handle.overlay as OverlayEl;
  }

  it('brings the tab to the front, then comes back to SLICC', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      const overlay = await openOverlay(browser);
      browser.attachToPage.mockClear();
      browser.bringToFront.mockClear();

      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(browser.attachToPage).toHaveBeenCalledWith('local-1');
      expect(browser.bringToFront).toHaveBeenCalledTimes(1);

      // ...and five seconds later the user is back where they started.
      await vi.advanceTimersByTimeAsync(5000);
      expect(browser.attachToPage).toHaveBeenCalledWith('slicc-self');
      expect(browser.bringToFront).toHaveBeenCalledTimes(2);
      // The agent is put back on the page it was driving — attaching does not
      // foreground, so this last step is invisible.
      expect(browser.attachToPage).toHaveBeenLastCalledWith('agent-page');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a pending return rather than stacking one', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      const overlay = await openOverlay(browser);
      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(3000);
      browser.bringToFront.mockClear();
      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(0);
      // The first return would have fired here; only the second peek's does.
      await vi.advanceTimersByTimeAsync(2500);
      expect(browser.bringToFront).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2600);
      expect(browser.bringToFront).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Without a way home a peek is just a switch with a surprise in it, so it
   * stays a switch and says so.
   */
  it("degrades to a plain switch when SLICC's own tab cannot be found", async () => {
    vi.useFakeTimers();
    try {
      const browser = makeFakeBrowser();
      const overlay = await openOverlay(browser);
      browser.bringToFront.mockClear();
      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(6000);
      expect(browser.bringToFront).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('peek cannot find the SLICC tab'),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /** A follower's tab is copied here, not visited — there is nowhere to come back from. */
  it('teleports a follower tab instead of peeking it', async () => {
    const browser = browserWithSelf();
    const overlay = await openOverlay(browser);
    overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'follower-9:tab-2' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(teleportTabOneWay)).toHaveBeenCalled();
  });
});
