// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import '@slicc/webcomponents';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import { teleportTabOneWay } from '../../../src/scoops/tray-leader/tab-teleport.js';
import { getComputersStore, resetComputersStoreForTests } from '../../../src/ui/computers-store.js';
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
  let attached = 'agent-page';

  let locked = 0;

  const bare: string[] = [];
  const api = {
    bareCursorMoves: bare,
    listAllTargets: vi.fn(async () => [
      { targetId: 'local-1', title: 'Docs', url: 'https://docs.example' },

      { targetId: 'follower-9:tab-2', title: 'Dashboard', url: 'https://dash.example' },
    ]),
    attachToPage: vi.fn(async (id: string) => {
      if (locked === 0) bare.push(`attachToPage:${id}`);
      attached = id;
      return 'session-1';
    }),
    getAttachedTargetId: vi.fn(() => attached),
    screenshot: vi.fn(async () => 'BASE64'),
    bringToFront: vi.fn(async () => {
      if (locked === 0) bare.push('bringToFront');
    }),
    closePage: vi.fn(async () => undefined),

    withTab: vi.fn(async (id: string, fn: (tab: unknown) => Promise<unknown>) => {
      locked += 1;
      try {
        const sessionId = await api.attachToPage(id);
        return await fn({
          targetId: id,
          sessionId,
          screenshot: api.screenshot,
          bringToFront: api.bringToFront,
        });
      } finally {
        locked -= 1;
      }
    }),
    selectTab: vi.fn(async (id: string) => {
      await api.withTab(id, async () => undefined);
    }),
    bringTabToFront: vi.fn(async (id: string) => {
      await api.withTab(id, async () => api.bringToFront());
    }),
  };
  return api;
}

function makeRefs(): WcShellRefs {
  const dock = document.createElement('slicc-dock');
  document.body.append(dock);
  return { dock, overlaySurfaces: new Set<string>() } as unknown as WcShellRefs;
}

type OverlayEl = HTMLElement & { tabs: Array<{ id: string; screenshot?: string }> };

describe('wireWcBrowser', () => {
  beforeEach(() => {
    resetComputersStoreForTests();
  });

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

    expect(refs.dock.getAttribute('active')).toBeNull();

    await vi.waitFor(() => {
      expect(browser.attachToPage).toHaveBeenCalledWith('follower-9:tab-2');
      expect((overlay as OverlayEl).tabs.every((t) => t.screenshot?.startsWith('data:'))).toBe(
        true
      );
    });

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

      await vi.advanceTimersByTimeAsync(5000);
      expect(browser.attachToPage).toHaveBeenCalledWith('slicc-self');
      expect(browser.bringToFront).toHaveBeenCalledTimes(2);

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

      await vi.advanceTimersByTimeAsync(2500);
      expect(browser.bringToFront).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2600);
      expect(browser.bringToFront).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never moves the session cursor outside the bridge locks', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      const overlay = await openOverlay(browser);

      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(6000);
      overlay.dispatchEvent(new CustomEvent('tab-activate', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(0);

      expect(browser.bareCursorMoves).toEqual([]);
      expect(browser.bringTabToFront).toHaveBeenCalledWith('local-1');
      expect(browser.bringTabToFront).toHaveBeenCalledWith('slicc-self');
      expect(browser.selectTab).toHaveBeenCalledWith('agent-page');
      expect(browser.withTab).toHaveBeenCalledWith('local-1', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('teleports a follower tab instead of peeking it', async () => {
    const browser = browserWithSelf();
    const overlay = await openOverlay(browser);
    overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'follower-9:tab-2' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(teleportTabOneWay)).toHaveBeenCalled();
  });
});

describe('peek and the agent attachment', () => {
  function browserWithSelf() {
    const browser = makeFakeBrowser();
    browser.listAllTargets = vi.fn(async () => [
      { targetId: 'local-1', title: 'Docs', url: 'https://docs.example' },
      { targetId: 'local-2', title: 'Mail', url: 'https://mail.example' },
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

  it('returns the agent to the page it was on before the switcher opened', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      const overlay = await openOverlay(browser);

      expect(browser.getAttachedTargetId()).not.toBe('agent-page');

      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(5001);
      expect(browser.attachToPage).toHaveBeenLastCalledWith('agent-page');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores even when the agent was already on the peeked tab', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      browser.getAttachedTargetId = vi.fn(() => 'local-1');
      const overlay = await openOverlay(browser);
      browser.attachToPage.mockClear();
      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(5001);
      expect(browser.attachToPage).toHaveBeenLastCalledWith('local-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules no return from a trip that never happened', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      const overlay = await openOverlay(browser);
      browser.bringToFront = vi.fn(async () => {
        throw new Error('no such target');
      });
      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(6000);

      expect(log.error).toHaveBeenCalledWith(
        'WC browser overlay: tab activate failed',
        expect.anything()
      );
      expect(browser.bringToFront).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still switches when the target list cannot be read', async () => {
    vi.useFakeTimers();
    try {
      const browser = browserWithSelf();
      const overlay = await openOverlay(browser);
      browser.listAllTargets = vi.fn(async () => {
        throw new Error('cdp gone');
      });
      browser.bringToFront.mockClear();
      overlay.dispatchEvent(new CustomEvent('tab-peek', { detail: { id: 'local-1' } }));
      await vi.advanceTimersByTimeAsync(6000);
      expect(browser.bringToFront).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        'WC browser overlay: could not resolve the SLICC tab',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends computer cards after browser tabs without CDP attach', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({
      type: 'computers',
      computers: [
        {
          id: 'jsh:fake',
          kind: 'jsh',
          title: 'fake',
          size: { width: 8, height: 8 },
          state: 'live',
          capabilities: {
            screenshot: true,
            text: false,
            frames: 'poll',
            keyboard: true,
            mouse: 'absolute',
            scroll: true,
            exec: false,
            inputAllowed: true,
          },
          pid: null,
          softKeys: [{ label: 'Enter', keysym: 'Return' }],
        },
      ],
    });
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();
    const tabs = (overlay as OverlayEl & { tabs: Array<{ id: string; kind?: string }> }).tabs;
    expect(tabs.map((t) => t.id)).toEqual(['local-1', 'follower-9:tab-2', 'computer:jsh:fake']);
    expect(tabs[2]?.kind).toBe('computer');
    expect(overlay.getAttribute('heading')).toBe('Browser · tabs & computers');
    expect(browser.withTab).not.toHaveBeenCalledWith('jsh:fake', expect.anything());
    expect(browser.withTab).not.toHaveBeenCalledWith('computer:jsh:fake', expect.anything());
  });

  it('keeps computer cards when the CDP tab list fails', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({
      type: 'computers',
      computers: [
        {
          id: 'jsh:fake',
          kind: 'jsh',
          title: 'fake',
          size: { width: 8, height: 8 },
          state: 'live',
          capabilities: {
            screenshot: true,
            text: false,
            frames: 'poll',
            keyboard: true,
            mouse: 'absolute',
            scroll: true,
            exec: false,
            inputAllowed: true,
          },
          pid: null,
        },
      ],
    });
    const refs = makeRefs();
    const browser = makeFakeBrowser();
    browser.listAllTargets = vi.fn(async () => {
      throw new Error('cdp gone');
    });
    const { overlay, refresh } = wireWcBrowser({
      refs,
      browser: browser as unknown as BrowserAPI,
      log,
    });
    await refresh();
    const tabs = (overlay as OverlayEl & { tabs: Array<{ id: string; kind?: string }> }).tabs;
    expect(tabs.map((t) => t.id)).toEqual(['computer:jsh:fake']);
    expect(tabs[0]?.kind).toBe('computer');
    expect(overlay.hasAttribute('open')).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      'WC browser overlay: listing tabs failed',
      expect.anything()
    );
  });
});
