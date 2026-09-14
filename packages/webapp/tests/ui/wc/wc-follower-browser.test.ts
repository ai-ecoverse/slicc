// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import '@slicc/webcomponents';
import type { TrayTargetEntry } from '../../../src/scoops/tray-sync-protocol.js';
import {
  type FollowerBrowserSync,
  wireWcFollowerBrowser,
} from '../../../src/ui/wc/wc-follower-browser.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const TARGETS: TrayTargetEntry[] = [
  {
    targetId: 'leader:tab1',
    localTargetId: 'tab1',
    runtimeId: 'leader',
    title: 'Dashboard',
    url: 'https://dash.example',
    isLocal: false,
    kind: 'browser',
  },
];

function makeRefs(): WcShellRefs {
  const dock = document.createElement('slicc-dock');
  document.body.append(dock);
  return { dock, overlaySurfaces: new Set<string>() } as unknown as WcShellRefs;
}

function makeSync(overrides: Partial<FollowerBrowserSync> = {}): FollowerBrowserSync {
  return {
    requestTabTeleport: vi.fn(async () => 'runtime-1:new-tab'),
    getLeaderProtocolVersion: () => 6,
    ...overrides,
  };
}

type OverlayEl = HTMLElement & { tabs: Array<{ id: string; url?: string }> };

function wire(opts: {
  sync?: FollowerBrowserSync | null;
  hasCdpBrowser?: boolean;
  windowOpen?: ReturnType<typeof vi.fn>;
}) {
  const refs = makeRefs();
  const windowOpen = opts.windowOpen ?? vi.fn(() => ({}) as Window);
  const sync = opts.sync === undefined ? makeSync() : opts.sync;
  const handle = wireWcFollowerBrowser({
    refs,
    getSync: () => sync,
    getTargets: () => TARGETS,
    hasCdpBrowser: () => opts.hasCdpBrowser ?? true,
    window: { open: windowOpen } as unknown as Window,
    log,
  });
  return { handle, refs, sync, windowOpen };
}

describe('wireWcFollowerBrowser', () => {
  it('claims the browser surface so no placeholder pane opens behind it', () => {
    const { refs } = wire({});
    expect(refs.overlaySurfaces.has('browser')).toBe(true);
  });

  it('stands down when the float already has its own tab switcher', () => {
    const refs = makeRefs();
    refs.overlaySurfaces.add('browser');
    const before = document.querySelectorAll('slicc-tab-overlay').length;

    const handle = wireWcFollowerBrowser({
      refs,
      getSync: () => makeSync(),
      getTargets: () => TARGETS,
      hasCdpBrowser: () => true,
      window: { open: vi.fn() } as unknown as Window,
      log,
    });

    expect(document.querySelectorAll('slicc-tab-overlay').length).toBe(before);
    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'browser' } })
    );
    expect(handle.overlay.hasAttribute('open')).toBe(false);

    expect(() => handle.refresh()).not.toThrow();
  });

  it('opens the overlay with the tray-wide tab list on the globe', () => {
    const { handle, refs } = wire({});
    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'browser' } })
    );
    expect(handle.overlay.hasAttribute('open')).toBe(true);
    expect((handle.overlay as OverlayEl).tabs).toEqual([
      expect.objectContaining({ id: 'leader:tab1', url: 'https://dash.example' }),
    ]);
  });

  it('withholds peek, which a follower has nowhere to come back from', () => {
    const { handle } = wire({});
    expect(handle.overlay.hasAttribute('no-peek')).toBe(true);
    (handle.overlay as unknown as { peeking: boolean }).peeking = true;
    expect((handle.overlay as unknown as { peeking: boolean }).peeking).toBe(false);
  });

  it('asks the leader to teleport the tab here when the float can host it', async () => {
    const { handle, sync } = wire({});
    handle.refresh();
    handle.overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: 'leader:tab1' } })
    );
    await vi.waitFor(() => {
      expect(sync?.requestTabTeleport).toHaveBeenCalledWith('leader:tab1');
    });
    expect(handle.overlay.hasAttribute('open')).toBe(false);
  });

  it('keeps the overlay open when the teleport fails', async () => {
    const sync = makeSync({
      requestTabTeleport: vi.fn(async () => {
        throw new Error('leader refused');
      }),
    });
    const { handle, refs } = wire({ sync });
    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'browser' } })
    );
    handle.overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: 'leader:tab1' } })
    );
    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        'WC follower browser: tab teleport failed',
        expect.any(Error)
      );
    });
    expect(handle.overlay.hasAttribute('open')).toBe(true);
  });

  it('degrades to a synchronous window.open when the float has no CDP surface', () => {
    const windowOpen = vi.fn(() => ({}) as Window);
    const { handle, sync } = wire({ hasCdpBrowser: false, windowOpen });
    handle.refresh();
    handle.overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: 'leader:tab1' } })
    );

    expect(windowOpen).toHaveBeenCalledWith('https://dash.example', '_blank', 'noopener');
    expect(sync?.requestTabTeleport).not.toHaveBeenCalled();
  });

  it('degrades when the leader predates the teleport protocol', () => {
    const windowOpen = vi.fn(() => ({}) as Window);
    const sync = makeSync({ getLeaderProtocolVersion: () => 5 });
    const { handle } = wire({ sync, windowOpen });
    handle.refresh();
    handle.overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: 'leader:tab1' } })
    );
    expect(windowOpen).toHaveBeenCalled();
    expect(sync.requestTabTeleport).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when a blocked popup returns null', () => {
    const windowOpen = vi.fn(() => null);
    const { handle } = wire({ hasCdpBrowser: false, windowOpen });
    handle.refresh();
    handle.overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: 'leader:tab1' } })
    );
    expect(log.warn).toHaveBeenCalledWith('WC follower browser: window.open was blocked', {
      id: 'leader:tab1',
    });
  });
});
