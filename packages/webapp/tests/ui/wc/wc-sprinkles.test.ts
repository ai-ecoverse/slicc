// @vitest-environment jsdom
/**
 * Sprinkle-zone bookkeeping tests: the SprinkleManagerCallbacks contract
 * over workbench tabs / surfaces / dock items, driven without a manager.
 */

import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import {
  sprinkleNameFromId,
  sprinkleSurfaceId,
  WcSprinkleZone,
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
