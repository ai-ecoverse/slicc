// @vitest-environment jsdom
/**
 * Sprinkle-zone bookkeeping tests: the SprinkleManagerCallbacks contract
 * over workbench tabs / surfaces / dock items, driven without a manager.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

// Registers the library elements so makeRefs gets a REAL slicc-tab-bar —
// the tab-close regression test drives its actual event contract.
import '@slicc/webcomponents';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import {
  enrichSprinkleIcons,
  isLucideIconSpec,
  pruneSprinkleIconLedger,
  readSprinkleIconLedger,
  recordSprinkleIcon,
  sprinkleNameFromId,
  sprinkleSurfaceId,
  WcSprinkleZone,
  wireSprinkleTabClose,
} from '../../../src/ui/wc/wc-sprinkles.js';

function makeRefs(): WcShellRefs {
  const shell = document.createElement('slicc-shell');
  const workbenchBody = document.createElement('slicc-workbench-body');
  workbenchBody.setAttribute('active', 'files');
  const workbenchHeader = document.createElement('slicc-workbench-header');
  workbenchHeader.setAttribute('hidden', '');
  const dock = document.createElement('slicc-dock') as WcShellRefs['dock'];
  const tabBar = document.createElement('slicc-tab-bar') as WcShellRefs['tabBar'];
  document.body.append(shell, workbenchBody, workbenchHeader, dock, tabBar);
  return { shell, workbenchBody, workbenchHeader, dock, tabBar } as unknown as WcShellRefs;
}

function tabIds(refs: WcShellRefs): string[] {
  return (refs.tabBar.tabs as Array<{ id: string }>).map((t) => t.id);
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

describe('sprinkle ids', () => {
  it('round-trips names through surface ids', () => {
    expect(sprinkleSurfaceId('hero')).toBe('sprinkle:hero');
    expect(sprinkleNameFromId('sprinkle:hero')).toBe('hero');
    expect(sprinkleNameFromId('files')).toBeNull();
    expect(sprinkleNameFromId(null)).toBeNull();
  });
});

describe('WcSprinkleZone', () => {
  it('addSprinkle creates surface + closable tab + dock item and activates', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const element = document.createElement('div');
    element.textContent = 'hero studio';

    zone.callbacks().addSprinkle('hero', 'Hero studio', element);

    const surface = refs.workbenchBody.querySelector('[surface-id="sprinkle:hero"]');
    expect(surface?.contains(element)).toBe(true);
    expect(tabIds(refs)).toContain('sprinkle:hero');
    expect(dockIds(refs)).toContain('sprinkle:hero');
    expect(refs.shell.hasAttribute('open')).toBe(true);
    expect(refs.workbenchBody.getAttribute('active')).toBe('sprinkle:hero');
    expect(zone.isOpen('hero')).toBe(true);
  });

  it('reveals the workbench header only while sprinkle tabs exist', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    // Tool tabs never render, so the header strip starts hidden (empty chrome).
    expect(refs.workbenchHeader.hasAttribute('hidden')).toBe(true);

    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    expect(refs.workbenchHeader.hasAttribute('hidden')).toBe(false);

    callbacks.removeSprinkle('hero');
    expect(refs.workbenchHeader.hasAttribute('hidden')).toBe(true);
  });

  it('attention adds without activating', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('hero', 'Hero', document.createElement('div'), undefined, {
      attention: true,
    });
    expect(refs.shell.hasAttribute('open')).toBe(false);
    expect(refs.workbenchBody.getAttribute('active')).toBe('files');
  });

  it('background adds (session restore) keep the current focus', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    zone.callbacks().addSprinkle('pomodoro', 'Pomodoro', document.createElement('div'), undefined, {
      background: true,
    });
    // The panel is open (tab + dock + surface) but nothing was focused —
    // after a reload the `ws` URL param decides what's on screen.
    expect(zone.isOpen('pomodoro')).toBe(true);
    expect(tabIds(refs)).toContain('sprinkle:pomodoro');
    expect(refs.shell.hasAttribute('open')).toBe(false);
    expect(refs.workbenchBody.getAttribute('active')).toBe('files');
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

  it('routes the tab bar tab-close (canonical id detail) to a sprinkle close', () => {
    // Drive the REAL component: removeTab emits `tab-close` with `{ id }`.
    // The old handler read `detail.tabId` and silently never closed —
    // the sprinkle lingered in the URL and reopened on the next reload.
    const refs = makeRefs();
    const closed: string[] = [];
    wireSprinkleTabClose(refs.tabBar, (name) => closed.push(name));
    (refs.tabBar as HTMLElement & { tabs: unknown }).tabs = [
      { id: 'sprinkle:pomodoro', label: 'Pomodoro', kind: 'sprinkle', closable: true },
    ];
    (refs.tabBar as HTMLElement & { removeTab(id: string): void }).removeTab('sprinkle:pomodoro');
    expect(closed).toEqual(['pomodoro']);
  });

  it('re-adding replaces the surface content in place', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    const next = document.createElement('span');
    callbacks.addSprinkle('hero', 'Hero', next);
    const surfaces = refs.workbenchBody.querySelectorAll('[surface-id="sprinkle:hero"]');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].contains(next)).toBe(true);
  });

  it('removeSprinkle drops surface, tab, and dock item, falling back to files', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    callbacks.removeSprinkle('hero');
    expect(refs.workbenchBody.querySelector('[surface-id="sprinkle:hero"]')).toBeNull();
    expect(tabIds(refs)).not.toContain('sprinkle:hero');
    expect(dockIds(refs)).not.toContain('sprinkle:hero');
    expect(refs.workbenchBody.getAttribute('active')).toBe('files');
    expect(zone.isOpen('hero')).toBe(false);
  });

  it('closeSprinkleContent keeps the dock launcher', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    callbacks.closeSprinkleContent?.('hero');
    expect(tabIds(refs)).not.toContain('sprinkle:hero');
    expect(dockIds(refs)).toContain('sprinkle:hero');
    expect(zone.isOpen('hero')).toBe(false);
  });

  it('registerSprinkle adds a dock launcher only; unregister removes it', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.registerSprinkle?.('palette', 'Palette');
    expect(dockIds(refs)).toContain('sprinkle:palette');
    expect(tabIds(refs)).not.toContain('sprinkle:palette');
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

  it('minimize collapses the workbench only when the sprinkle is active', () => {
    const refs = makeRefs();
    const zone = new WcSprinkleZone(refs);
    const callbacks = zone.callbacks();
    callbacks.addSprinkle('hero', 'Hero', document.createElement('div'));
    callbacks.minimizeSprinkle('hero');
    expect(refs.shell.hasAttribute('open')).toBe(false);

    refs.shell.setAttribute('open', '');
    refs.workbenchBody.setAttribute('active', 'files');
    callbacks.minimizeSprinkle('hero');
    expect(refs.shell.hasAttribute('open')).toBe(true);
  });

  it('keeps the base tool tabs first', () => {
    const refs = makeRefs();
    new WcSprinkleZone(refs).callbacks().addSprinkle('hero', 'Hero', document.createElement('div'));
    expect(tabIds(refs).slice(0, 3)).toEqual(['files', 'term', 'memory']);
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
    expect(pickIcon.mock.calls[0][0]).toContain('Pomodoro');
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
