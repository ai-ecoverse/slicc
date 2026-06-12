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
import { wireWcBrowser } from '../../../src/ui/wc/wc-browser.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

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
    screenshot: vi.fn(async () => 'BASE64'),
    bringToFront: vi.fn(async () => undefined),
    closePage: vi.fn(async () => undefined),
  };
}

function makeRefs(): WcShellRefs {
  const dock = document.createElement('slicc-dock');
  document.body.append(dock);
  return { dock } as unknown as WcShellRefs;
}

type OverlayEl = HTMLElement & { tabs: Array<{ id: string; screenshot?: string }> };

describe('wireWcBrowser', () => {
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

  it('activating a card attaches + foregrounds the tab and closes the overlay', async () => {
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
      expect(browser.bringToFront).toHaveBeenCalled();
    });
    expect(browser.attachToPage).toHaveBeenCalledWith('follower-9:tab-2');
    expect(overlay.hasAttribute('open')).toBe(false);
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
