// @vitest-environment jsdom
/**
 * Sprinkle-zone bookkeeping tests: the SprinkleManagerCallbacks contract
 * over the dock-tree's surfaces/dock items, driven without a manager.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { VirtualFS } from '../../../src/fs/virtual-fs.js';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import { LAYOUT_PRESETS } from '../../../src/ui/wc/layout-spec.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import {
  CHAT_SURFACE_ID,
  DEFAULT_TOOL_ZONE,
  type DockTreeSpecLike,
  enrichSprinkleIcons,
  isLucideIconSpec,
  isToolPanelId,
  pruneSprinkleIconLedger,
  readSprinkleIconLedger,
  recordSprinkleIcon,
  sprinkleNameFromId,
  sprinkleSurfaceId,
  WcSprinkleZone,
  wireWcSprinkles,
  zoneOfSurface,
} from '../../../src/ui/wc/wc-sprinkles.js';

// Fake dock-tree ref: a plain div carrying vi.fn() stubs for the dock-tree
// API (setTree/getTree/getSurfaceIds/placeSurface/removeSurface/
// moveSurfaceToZone/beginExternalDrag/setPinned). Kept as a real `div` (not a
// bare object) so `querySelector`/`append` behave exactly like the production
// `<slicc-dock-tree>` ref.
function makeDockTreeRef(tilesMovable = false) {
  return Object.assign(document.createElement('div'), {
    tilesMovable,
    setTree: vi.fn(),
    getTree: vi.fn(() => ({ zones: {}, rowFr: {}, colFr: {} })),
    getSurfaceIds: vi.fn(() => [] as string[]),
    placeSurface: vi.fn(),
    removeSurface: vi.fn(),
    moveSurfaceToZone: vi.fn(),
    setSurfaceSize: vi.fn(() => true),
    beginExternalDrag: vi.fn(),
    setPinned: vi.fn(),
  });
}

function makeRefs(tilesMovable = false): WcShellRefs {
  const shell = document.createElement('slicc-shell');
  const dockTree = makeDockTreeRef(tilesMovable);
  const dock = document.createElement('slicc-dock') as WcShellRefs['dock'];
  shell.append(dockTree, dock);
  document.body.append(shell);
  return { shell, dockTree, dock } as unknown as WcShellRefs;
}

function dockIds(refs: WcShellRefs): string[] {
  const items = (refs.dock as HTMLElement & { items?: Array<{ id: string }> }).items ?? [];
  return items.map((i) => i.id);
}

function dockItem(refs: WcShellRefs, id: string): { id: string; icon: string } | undefined {
  const items =
    (refs.dock as HTMLElement & { items?: Array<{ id: string; icon: string }> }).items ?? [];
  return items.find((i) => i.id === id);
}

function treeSpies(refs: WcShellRefs) {
  return refs.dockTree as unknown as {
    setTree: ReturnType<typeof vi.fn>;
    getSurfaceIds: ReturnType<typeof vi.fn>;
    placeSurface: ReturnType<typeof vi.fn>;
    removeSurface: ReturnType<typeof vi.fn>;
    moveSurfaceToZone: ReturnType<typeof vi.fn>;
    setSurfaceSize: ReturnType<typeof vi.fn>;
    setPinned: ReturnType<typeof vi.fn>;
  };
}

describe('wireWcSprinkles boot resilience', () => {
  it('resolves without waiting for the initial discovery (a hung VFS walk must not strand boot)', async () => {
    // Discovery does `for await (... of fs.walk(root))`; a walk that never
    // yields makes manager.refresh() — and the initial resync() — hang.
    // wireWcSprinkles MUST still resolve so downstream boot (the tray leader,
    // sequenced after it in attachWcClient) runs. The initial resync is
    // best-effort and re-run on kernel-ready, so dropping the await is safe.
    const fs = {
      exists: async () => true, // enter scanDir so discovery reaches the walk
      async *walk(): AsyncGenerator<string> {
        await new Promise<void>(() => {}); // never resolves → discovery hangs
        yield ''; // unreachable; present so this is a generator
      },
      readFile: async () => '',
    } as unknown as VirtualFS;
    const client = {
      sendSprinkleLick: () => {},
      getScoops: () => [],
      stopScoop: () => {},
    } as unknown as OffscreenClient;
    const log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as BootStageLogger;

    const settled = await Promise.race([
      wireWcSprinkles({ refs: makeRefs(), client, fs, log }).then(() => 'resolved' as const),
      new Promise<'blocked'>((resolve) => {
        setTimeout(() => resolve('blocked'), 1000);
      }),
    ]);
    expect(settled).toBe('resolved');
  });

  it('accepts an onAttachImage callback without falling back to the warn logger', async () => {
    const fs = {
      exists: async () => false,
      async *walk(): AsyncGenerator<string> {
        /* empty */
      },
      readFile: async () => '',
    } as unknown as VirtualFS;
    const client = {
      sendSprinkleLick: () => {},
      getScoops: () => [],
      stopScoop: () => {},
    } as unknown as OffscreenClient;
    const warnSpy = vi.fn();
    const log = {
      info: () => {},
      warn: warnSpy,
      error: () => {},
      debug: () => {},
    } as unknown as BootStageLogger;

    const handler = vi.fn();
    const result = await wireWcSprinkles({
      refs: makeRefs(),
      client,
      fs,
      onAttachImage: handler,
      log,
    });
    expect(result.manager).toBeDefined();
    // The fallback warn logger should NOT have been called during setup.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('image attachments from sprinkles')
    );
  });
});

describe('sprinkle ids', () => {
  it('round-trips names through surface ids', () => {
    expect(sprinkleSurfaceId('hero')).toBe('sprinkle:hero');
    expect(sprinkleNameFromId('sprinkle:hero')).toBe('hero');
    expect(sprinkleNameFromId('files')).toBeNull();
    expect(sprinkleNameFromId(null)).toBeNull();
  });
});

describe('WcSprinkleZone', () => {
  it.each([false, true])(
    'addSprinkle creates and places its surface with tilesMovable=%s',
    (tilesMovable) => {
      const refs = makeRefs(tilesMovable);
      const zone = new WcSprinkleZone(refs);
      const element = document.createElement('div');
      element.textContent = 'hero studio';

      zone.callbacks().addSprinkle('hero', 'Hero studio', element);

      const surface = (refs.dockTree as unknown as HTMLElement).querySelector(
        '[surface-id="sprinkle:hero"]'
      );
      expect(surface?.contains(element)).toBe(true);
      expect(dockIds(refs)).toContain('sprinkle:hero');
      expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('sprinkle:hero', DEFAULT_TOOL_ZONE);
      expect(zone.isOpen('hero')).toBe(true);
    }
  );

  it('attention adds without placing anywhere special (defaults still apply)', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('hero', 'Hero', document.createElement('div'), undefined, {
      attention: true,
    });
    expect(zone.isOpen('hero')).toBe(true);
    expect(dockIds(refs)).toContain('sprinkle:hero');
  });

  it('background adds (session restore) still compose the surface', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('pomodoro', 'Pomodoro', document.createElement('div'), undefined, {
      background: true,
    });
    expect(zone.isOpen('pomodoro')).toBe(true);
    expect(dockIds(refs)).toContain('sprinkle:pomodoro');
  });

  it('seeds rail launchers from the ledger and prunes unconfirmed seeds', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.seedDockItems(['pomodoro', 'stale-uninstalled']);
    expect(dockIds(refs)).toEqual(
      expect.arrayContaining(['sprinkle:pomodoro', 'sprinkle:stale-uninstalled'])
    );

    // Discovery confirms pomodoro (registerSprinkle trues the title up)…
    zone.callbacks().registerSprinkle?.('pomodoro', 'Pomodoro');
    zone.dropUnconfirmedSeeds();
    // …and the never-confirmed seed is pruned.
    expect(dockIds(refs)).toContain('sprinkle:pomodoro');
    expect(dockIds(refs)).not.toContain('sprinkle:stale-uninstalled');
  });

  it('re-adding replaces the surface content in place', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    const next = document.createElement('span');
    callbacks.addSprinkle('hero', 'Hero', next);
    const surfaces = (refs.dockTree as unknown as HTMLElement).querySelectorAll(
      '[surface-id="sprinkle:hero"]'
    );
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].contains(next)).toBe(true);
  });

  it('removeSprinkle drops the surface, dock item, and calls removeSurface', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    callbacks.removeSprinkle('hero');
    expect(
      (refs.dockTree as unknown as HTMLElement).querySelector('[surface-id="sprinkle:hero"]')
    ).toBeNull();
    expect(dockIds(refs)).not.toContain('sprinkle:hero');
    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('sprinkle:hero');
    expect(zone.isOpen('hero')).toBe(false);
  });

  it('closeSprinkleContent keeps the dock launcher', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    callbacks.closeSprinkleContent?.('hero');
    expect(dockIds(refs)).toContain('sprinkle:hero');
    expect(zone.isOpen('hero')).toBe(false);
  });

  it('registerSprinkle adds a dock launcher only; unregister removes it', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.registerSprinkle?.('palette', 'Palette');
    expect(dockIds(refs)).toContain('sprinkle:palette');
    callbacks.unregisterSprinkle?.('palette');
    expect(dockIds(refs)).not.toContain('sprinkle:palette');
  });

  it('unregister keeps the dock item while the sprinkle is open', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    callbacks.unregisterSprinkle?.('hero');
    expect(dockIds(refs)).toContain('sprinkle:hero');
  });

  it('minimize clears the dock rail active indicator and parks the surface off the tree', () => {
    const refs = makeRefs();
    refs.dock.setAttribute('active', 'sprinkle:hero');
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));

    callbacks.minimizeSprinkle('hero');

    expect(refs.dock.hasAttribute('active')).toBe(false);
    // Detached from the tree (mirrors the pre-panels "close the workbench
    // body" behavior) but NOT destroyed or dropped from bookkeeping — the
    // rail icon can still reopen it.
    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('sprinkle:hero');
    expect(zone.isOpen('hero')).toBe(true);
    expect(dockIds(refs)).toContain('sprinkle:hero');
  });

  it('minimize is a no-op on the dock-tree for a panelized shell (host owns hiding)', () => {
    const refs = makeRefs();
    const hostSprinkleSurface = vi.fn();
    const zone = new WcSprinkleZone(refs, { hostSprinkleSurface });
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    treeSpies(refs).removeSurface.mockClear();

    callbacks.minimizeSprinkle('hero');

    expect(treeSpies(refs).removeSurface).not.toHaveBeenCalled();
  });

  it('placeSurface collapses every other non-chat surface first (one panel at a time, classic mode)', () => {
    const refs = makeRefs();
    treeSpies(refs).getSurfaceIds.mockReturnValue(['chat', 'files', 'sprinkle:hero']);
    const zone = new WcSprinkleZone(refs);

    zone.placeSurface('right', 'term');

    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('files');
    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('sprinkle:hero');
    expect(treeSpies(refs).removeSurface).not.toHaveBeenCalledWith('chat');
    expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('term', 'right');
    expect((refs.dock as unknown as { active: string | null }).active).toBe('term');
  });

  it('opening a new sprinkle collapses whatever tool panel/sprinkle was showing', () => {
    const refs = makeRefs();
    treeSpies(refs).getSurfaceIds.mockReturnValue(['chat', 'files']);
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();

    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));

    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('files');
    expect(treeSpies(refs).removeSurface).not.toHaveBeenCalledWith('chat');
    expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('sprinkle:hero', DEFAULT_TOOL_ZONE);
  });

  it('does not collapse other surfaces in a panelized shell', () => {
    const refs = makeRefs();
    treeSpies(refs).getSurfaceIds.mockReturnValue(['chat', 'files']);
    const hostSprinkleSurface = vi.fn();
    const zone = new WcSprinkleZone(refs, { hostSprinkleSurface });

    zone.placeSurface('right', 'term');

    expect(treeSpies(refs).removeSurface).not.toHaveBeenCalled();
  });

  it('attention adds do not place a surface (must not steal the visible slot)', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('hero', 'Hero', document.createElement('div'), undefined, {
      attention: true,
    });
    expect(treeSpies(refs).placeSurface).not.toHaveBeenCalled();
  });

  it('background (session-restore) adds do not place a surface either', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('pomodoro', 'Pomodoro', document.createElement('div'), undefined, {
      background: true,
    });
    expect(treeSpies(refs).placeSurface).not.toHaveBeenCalled();
  });
});

describe('rail icons (declared > ledger > sparkles)', () => {
  beforeEach(() => {
    localStorage.removeItem('slicc-sprinkle-icons');
  });

  it('honors a declared lucide icon spec from registerSprinkle and addSprinkle', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().registerSprinkle?.('pomodoro', 'Pomodoro', { icon: 'timer' });
    expect(dockItem(refs, 'sprinkle:pomodoro')?.icon).toBe('timer');

    zone.callbacks().addSprinkle('music', 'Music', document.createElement('div'), undefined, {
      icon: 'music',
    } as never);
    expect(dockItem(refs, 'sprinkle:music')?.icon).toBe('music');
  });

  it('falls back for non-lucide specs (VFS paths, inline SVG) the rail cannot render', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().registerSprinkle?.('hero', 'Hero', { icon: '/workspace/icon.svg' });
    expect(dockItem(refs, 'sprinkle:hero')?.icon).toBe('sparkles');
    expect(isLucideIconSpec('/workspace/icon.svg')).toBe(false);
    expect(isLucideIconSpec('calendar-clock')).toBe(true);
  });

  it('seeds launchers with previously picked ledger icons', () => {
    recordSprinkleIcon('pomodoro', 'timer');
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.seedDockItems(['pomodoro', 'unknown']);
    expect(dockItem(refs, 'sprinkle:pomodoro')?.icon).toBe('timer');
    expect(dockItem(refs, 'sprinkle:unknown')?.icon).toBe('sparkles');
  });

  it('enrichSprinkleIcons LLM-picks only for sparkles-default entries and records the ledger', async () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().registerSprinkle?.('declared', 'Declared', { icon: 'music' });
    zone.callbacks().registerSprinkle?.('pomodoro', 'Pomodoro', {});
    const pickIcon = vi.fn(async () => 'timer');

    await enrichSprinkleIcons(
      zone,
      [
        { name: 'declared', title: 'Declared', icon: 'music' },
        { name: 'pomodoro', title: 'Pomodoro' },
      ],
      pickIcon
    );
    // Only the icon-less sprinkle was labeled; the pick landed on the dock
    // and in the ledger (so the next boot seeds it without another call).
    expect(pickIcon).toHaveBeenCalledTimes(1);
    expect((pickIcon.mock.calls[0] as unknown[])[0]).toContain('Pomodoro');
    expect(dockItem(refs, 'sprinkle:pomodoro')?.icon).toBe('timer');
    expect(readSprinkleIconLedger()).toEqual({ pomodoro: 'timer' });

    // A remembered pick is reapplied with NO further LLM call.
    const refs2 = makeRefs();
    const zone2 = new WcSprinkleZone(refs2);
    zone2.callbacks().registerSprinkle?.('pomodoro', 'Pomodoro', {});
    expect(dockItem(refs2, 'sprinkle:pomodoro')?.icon).toBe('timer');
    await enrichSprinkleIcons(zone2, [{ name: 'pomodoro', title: 'Pomodoro' }], pickIcon);
    expect(pickIcon).toHaveBeenCalledTimes(1);
  });

  it('pruneSprinkleIconLedger drops picks for sprinkles discovery did not confirm', () => {
    recordSprinkleIcon('pomodoro', 'timer');
    recordSprinkleIcon('deleted-long-ago', 'ghost');
    pruneSprinkleIconLedger(['pomodoro']);
    expect(readSprinkleIconLedger()).toEqual({ pomodoro: 'timer' });
  });

  it('pruneSprinkleIconLedger empties the ledger when nothing was confirmed', () => {
    recordSprinkleIcon('ghost', 'skull');
    pruneSprinkleIconLedger([]);
    expect(readSprinkleIconLedger()).toEqual({});
  });
});

describe('WcSprinkleZone applyLayout / placeSurface / moveSurfaceToZone', () => {
  it('applyLayout loads the tree and re-places already-open sprinkles', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('hero', 'Hero', document.createElement('div'));
    treeSpies(refs).placeSurface.mockClear();

    zone.applyLayout(LAYOUT_PRESETS.focus.tree);

    expect(treeSpies(refs).setTree).toHaveBeenCalledWith(LAYOUT_PRESETS.focus.tree);
    expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('sprinkle:hero', DEFAULT_TOOL_ZONE);
  });

  it('placeSurface forwards to the dock-tree with (surfaceId, zone) order', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);

    zone.placeSurface('right', 'sprinkle:x');

    expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('sprinkle:x', 'right');
  });

  it('moveSurfaceToZone forwards to the dock-tree primitive', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);

    zone.moveSurfaceToZone(CHAT_SURFACE_ID, 'right');

    expect(treeSpies(refs).moveSurfaceToZone).toHaveBeenCalledWith(CHAT_SURFACE_ID, 'right');
  });

  it('applyLayout tolerates a missing dockTree ref (defensive no-op, no throw)', () => {
    const refs = {
      dock: document.createElement('div'),
      shell: document.createElement('div'),
    } as unknown as WcShellRefs;
    const zone = new WcSprinkleZone(refs);

    expect(() => zone.applyLayout(LAYOUT_PRESETS.focus.tree)).not.toThrow();
    expect(() =>
      zone.callbacks().addSprinkle('hero', 'Hero', document.createElement('div'))
    ).not.toThrow();
  });
});

describe('isToolPanelId / zoneOfSurface (v6 helpers)', () => {
  it('classifies the four fixed tool panels and rejects sprinkles / browser / chat', () => {
    for (const id of ['files', 'term', 'memory', 'monitor']) expect(isToolPanelId(id)).toBe(true);
    for (const id of ['sprinkle:hero', 'browser', 'chat', 'tools', ''])
      expect(isToolPanelId(id)).toBe(false);
  });

  it('finds the zone a surface lives in (leaf or nested split), null when absent', () => {
    const spec: DockTreeSpecLike = {
      zones: {
        top: null,
        left: { type: 'leaf', surfaceId: 'chat' },
        middle: null,
        right: { type: 'split', dir: 'col', children: [{ type: 'leaf', surfaceId: 'files' }] },
        bottom: null,
      } as DockTreeSpecLike['zones'],
      rowFr: { top: 1, center: 1, bottom: 1 },
      colFr: { left: 1, middle: 1, right: 1 },
    };
    expect(zoneOfSurface(spec, 'chat')).toBe('left');
    expect(zoneOfSurface(spec, 'files')).toBe('right');
    expect(zoneOfSurface(spec, 'nope')).toBeNull();
  });
});

describe('WcSprinkleZone / wireWcSprinkles tool panels (independent leaves)', () => {
  it('a dock select for a tool id places its surface into the default zone and fires onToolPanelActivate', async () => {
    const refs = makeRefs();
    const fs = {
      exists: async () => false,
      async *walk(): AsyncGenerator<string> {
        /* empty */
      },
      readFile: async () => '',
    } as unknown as VirtualFS;
    const client = {
      sendSprinkleLick: () => {},
      getScoops: () => [],
      stopScoop: () => {},
    } as unknown as OffscreenClient;
    const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as BootStageLogger;
    const onToolPanelActivate = vi.fn();
    const onToolPanelDeactivate = vi.fn();
    await wireWcSprinkles({ refs, client, fs, log, onToolPanelActivate, onToolPanelDeactivate });

    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { detail: { id: 'files' }, bubbles: true })
    );

    expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('files', DEFAULT_TOOL_ZONE);
    expect(onToolPanelActivate).toHaveBeenCalledWith('files');
    expect(onToolPanelDeactivate).not.toHaveBeenCalled();
  });

  it('a dock collapse for a tool id removes its surface and fires onToolPanelDeactivate', async () => {
    const refs = makeRefs();
    const fs = {
      exists: async () => false,
      async *walk(): AsyncGenerator<string> {
        /* empty */
      },
      readFile: async () => '',
    } as unknown as VirtualFS;
    const client = {
      sendSprinkleLick: () => {},
      getScoops: () => [],
      stopScoop: () => {},
    } as unknown as OffscreenClient;
    const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as BootStageLogger;
    const onToolPanelDeactivate = vi.fn();
    await wireWcSprinkles({ refs, client, fs, log, onToolPanelDeactivate });

    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-collapse', { detail: { id: 'term' }, bubbles: true })
    );

    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('term');
    expect(onToolPanelDeactivate).toHaveBeenCalledWith('term');
  });

  it('WcSprinkleZone.placeSurface fires onToolPanelActivate directly — not just via the dock-select event — so an agent-driven `layout open` gets the same lifecycle as a dock-rail click', () => {
    const refs = makeRefs();
    const onToolPanelActivate = vi.fn();
    const zone = new WcSprinkleZone(refs, { onToolPanelActivate });

    zone.placeSurface('right', 'files');

    expect(treeSpies(refs).placeSurface).toHaveBeenCalledWith('files', 'right');
    expect(onToolPanelActivate).toHaveBeenCalledWith('files');
  });

  it('WcSprinkleZone.placeSurface does not fire onToolPanelActivate for a sprinkle or chat id', () => {
    const refs = makeRefs();
    const onToolPanelActivate = vi.fn();
    const zone = new WcSprinkleZone(refs, { onToolPanelActivate });

    zone.placeSurface('right', 'sprinkle:weather');
    zone.placeSurface('left', CHAT_SURFACE_ID);

    expect(onToolPanelActivate).not.toHaveBeenCalled();
  });

  it('WcSprinkleZone.removeSurface fires onToolPanelDeactivate directly — e.g. an agent-driven `layout close`', () => {
    const refs = makeRefs();
    const onToolPanelDeactivate = vi.fn();
    const zone = new WcSprinkleZone(refs, { onToolPanelDeactivate });

    zone.removeSurface('term');

    expect(treeSpies(refs).removeSurface).toHaveBeenCalledWith('term');
    expect(onToolPanelDeactivate).toHaveBeenCalledWith('term');
  });

  it('WcSprinkleZone omitting the hooks arg is a safe no-op (default {})', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    expect(() => {
      zone.placeSurface('right', 'files');
      zone.removeSurface('files');
    }).not.toThrow();
  });

  it('WcSprinkleZone.setSurfaceSize forwards to the dock-tree and returns its result — e.g. `layout size`', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);

    const changed = zone.setSurfaceSize('files', { widthPercent: 40 });

    expect(changed).toBe(true);
    expect(treeSpies(refs).setSurfaceSize).toHaveBeenCalledWith('files', { widthPercent: 40 });
  });

  it('a sprinkle collapse does not touch the dock-tree (isToolPanelId gate)', async () => {
    const refs = makeRefs();
    const fs = {
      exists: async () => false,
      async *walk(): AsyncGenerator<string> {
        /* empty */
      },
      readFile: async () => '',
    } as unknown as VirtualFS;
    const client = {
      sendSprinkleLick: () => {},
      getScoops: () => [],
      stopScoop: () => {},
    } as unknown as OffscreenClient;
    const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as BootStageLogger;
    await wireWcSprinkles({ refs, client, fs, log });

    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-collapse', { detail: { id: 'sprinkle:hero' }, bubbles: true })
    );

    expect(treeSpies(refs).removeSurface).not.toHaveBeenCalled();
  });
});
