// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShortcutCaps } from '../../../src/ui/wc/wc-shortcut-caps.js';
import { DEFAULT_KEYMAP } from '../../../src/ui/wc/wc-shortcuts.js';

const RAIL_IDS = ['browser', 'files', 'term', 'memory', 'monitor'] as const;

function harness(
  options: { railIds?: readonly string[]; sprinkle?: boolean; scoops?: number } = {}
): {
  inputCard: HTMLElement;
  root: HTMLElement;
  dock: HTMLElement;
  track: HTMLElement;
  switcher: { scoops: unknown[] };
} {
  const dock = document.createElement('slicc-dock');
  for (const id of options.railIds ?? RAIL_IDS) {
    const item = document.createElement('slicc-dock-item');
    item.setAttribute('item-id', id);
    box(item);
    dock.append(item);
  }
  if (options.sprinkle) {
    const item = document.createElement('slicc-dock-item');
    item.setAttribute('item-id', 'sprinkle-hello');
    item.setAttribute('kind', 'sprinkle');
    box(item);
    dock.append(item);
  }

  const inputCard = document.createElement('slicc-input-card');
  box(inputCard, { left: 113, right: 793, width: 680, top: 400, height: 107 });
  for (const [tag, left] of [
    ['slicc-add-menu', 130],
    ['slicc-send-button', 750],
    ['textarea', 130],
  ] as const) {
    const el = document.createElement(tag);
    box(el, { left, right: left + 30 });
    inputCard.append(el);
  }

  const tabs = document.createElement('slicc-agent-tabs');
  const track = document.createElement('div');
  track.setAttribute('part', 'track-frame');
  box(track, { left: 100, width: 70, right: 170 });
  tabs.append(track);

  const freezer = document.createElement('slicc-freezer');
  const railToggle = document.createElement('button');
  railToggle.setAttribute('part', 'toggle');
  box(railToggle, { left: 8, right: 38 });
  freezer.append(railToggle);

  const root = document.createElement('div');
  document.body.append(dock, inputCard, tabs, freezer, root);

  const switcher = { scoops: Array.from({ length: options.scoops ?? 2 }, (_, i) => i) };
  return { inputCard, root, dock, track, switcher };
}

function box(el: Element, rect: Partial<DOMRect> = {}): void {
  const value = { x: 10, y: 20, width: 30, height: 30, top: 20, left: 10, ...rect } as DOMRect;
  el.getBoundingClientRect = () => value;
}

function caps(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.wcsc-caps slicc-keycap')];
}

function capFor(key: string): HTMLElement | undefined {
  return caps().find((cap) => cap.getAttribute('cap') === key);
}

describe('wc-shortcut-caps', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('mounts nothing until the mode turns on, and nothing after it turns off', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    expect(document.querySelector('.wcsc-caps')).toBeNull();

    handle.show(DEFAULT_KEYMAP);
    expect(caps().length).toBeGreaterThan(0);

    handle.hide();
    expect(document.querySelector('.wcsc-caps')).toBeNull();
    expect(caps()).toEqual([]);
  });

  it('caps each rail launcher with the key its command is bound to', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    for (const key of ['b', 'f', 't', 'm', 'g']) expect(capFor(key)).toBeDefined();

    for (const key of ['u', 's', 'i']) expect(capFor(key)).toBeDefined();
    handle.hide();
  });

  it('names the switcher with both arrows, on the track, clear of it', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    const cap = capFor('← →') as HTMLElement & { anchor?: HTMLElement | null };
    expect(cap).toBeDefined();
    expect(cap.anchor).toBe(deps.track);

    expect(cap.getAttribute('placement')).toBe('end');
    handle.hide();
  });

  it('has no switcher cap when there is only one unit', () => {
    const deps = harness({ scoops: 1 });
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('← →')).toBeUndefined();
    handle.hide();
  });

  it('grows the switcher cap once a second unit exists', () => {
    const deps = harness({ scoops: 1 });
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('← →')).toBeUndefined();

    deps.switcher.scoops.push(1);
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('← →')).toBeDefined();
    handle.hide();
  });

  it('caps the left rail toggle', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    const cap = capFor('[') as HTMLElement & { anchor?: HTMLElement | null };
    expect(cap).toBeDefined();
    expect(cap.anchor).toBe(document.querySelector('slicc-freezer [part="toggle"]'));
    handle.hide();
  });

  it('keeps the half of a pair that is still bound', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    const { ArrowLeft: _unbound, ...rest } = DEFAULT_KEYMAP;
    handle.show(rest);

    expect(capFor('→')).toBeDefined();
    expect(capFor('← →')).toBeUndefined();
    handle.hide();
  });

  it('puts the composer key on the textarea', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    const cap = capFor('i') as HTMLElement & { anchor?: HTMLElement | null };
    expect(cap.anchor).toBe(deps.inputCard.querySelector('textarea'));
    expect(cap.getAttribute('placement')).toBe('top-start');
    handle.hide();
  });

  it('flips a cap that would hang off the edge of the window', () => {
    const deps = harness();
    const item = deps.dock.querySelector('slicc-dock-item[item-id="files"]');

    if (item) box(item, { left: globalThis.innerWidth - 34, right: globalThis.innerWidth - 4 });

    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('f')?.getAttribute('placement')).toBe('top-start');

    if (item) box(item, { left: 400, right: 430 });
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('f')?.getAttribute('placement')).toBe('top-end');
    handle.hide();
  });

  it('follows a rebound key and drops a cap the config unbinds', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    const { f: _dropped, ...withoutFiles } = DEFAULT_KEYMAP;
    handle.show({ ...withoutFiles, q: 'files' });

    expect(capFor('q')).toBeDefined();
    expect(capFor('f')).toBeUndefined();
    handle.hide();
  });

  it('leaves a rail item this float does not have uncapped', () => {
    const deps = harness({ railIds: ['files', 'term'] });
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    expect(capFor('f')).toBeDefined();
    expect(capFor('m')).toBeUndefined();
    handle.hide();
  });

  it('drops a cap whose control has no box', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('f')).toBeDefined();

    const item = deps.dock.querySelector('slicc-dock-item[item-id="files"]');
    if (item) box(item, { width: 0, height: 0 });
    handle.show(DEFAULT_KEYMAP);

    expect(capFor('f')).toBeUndefined();
    handle.hide();
  });

  it('positions each cap on a ghost of its control, in viewport coordinates', () => {
    const deps = harness();
    const item = deps.dock.querySelector('slicc-dock-item[item-id="files"]');
    if (item) box(item, { left: 120, top: 240, width: 30, height: 34 });

    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    const ghost = capFor('f')?.parentElement;
    expect(ghost?.style.left).toBe('120px');
    expect(ghost?.style.top).toBe('240px');
    expect(ghost?.style.width).toBe('30px');
    expect(ghost?.style.height).toBe('34px');
    handle.hide();
  });

  it('anchors the hover to the real control, not to the ghost', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    const cap = capFor('f') as HTMLElement & { anchor?: HTMLElement | null };
    expect(cap.anchor).toBe(deps.dock.querySelector('slicc-dock-item[item-id="files"]'));
    handle.hide();
  });

  it('re-points a cap at a rebuilt control', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    deps.dock.replaceChildren();
    const rebuilt = document.createElement('slicc-dock-item');
    rebuilt.setAttribute('item-id', 'files');
    box(rebuilt, { left: 300, top: 60 });
    deps.dock.append(rebuilt);
    handle.show(DEFAULT_KEYMAP);

    const cap = capFor('f') as HTMLElement & { anchor?: HTMLElement | null };
    expect(cap.anchor).toBe(rebuilt);
    expect(cap.parentElement?.style.left).toBe('300px');
    handle.hide();
  });

  it('caps the first sprinkle launcher, which is the one the key opens', () => {
    const deps = harness({ sprinkle: true });
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);

    const cap = capFor('e') as HTMLElement & { anchor?: HTMLElement | null };
    expect(cap?.anchor).toBe(deps.dock.querySelector('slicc-dock-item[kind="sprinkle"]'));
    handle.hide();
  });

  it('has no sprinkle cap on a rail with no sprinkles installed', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);
    expect(capFor('e')).toBeUndefined();
    handle.hide();
  });

  it('stays on one cap per control across repeated shows', () => {
    const deps = harness();
    const handle = createShortcutCaps(deps);
    handle.show(DEFAULT_KEYMAP);
    const first = caps().length;
    handle.show(DEFAULT_KEYMAP);
    handle.show(DEFAULT_KEYMAP);
    expect(caps().length).toBe(first);
    handle.hide();
  });

  it('is safe to hide, destroy, or hide twice without a show', () => {
    const handle = createShortcutCaps(harness());
    expect(() => {
      handle.hide();
      handle.destroy();
    }).not.toThrow();

    handle.show(DEFAULT_KEYMAP);
    handle.hide();
    expect(() => handle.hide()).not.toThrow();
    expect(document.querySelector('.wcsc-caps')).toBeNull();
  });

  it('mounts the layer below the dialog stacking level', () => {
    const handle = createShortcutCaps(harness());
    handle.show(DEFAULT_KEYMAP);
    const layer = document.querySelector<HTMLElement>('.wcsc-caps');
    const style = document.getElementById('wcsc-caps-style')?.textContent ?? '';
    expect(layer).not.toBeNull();
    expect(style).toContain('position:fixed');

    const z = Number(/z-index:(\d+)/.exec(style)?.[1]);
    expect(z).toBeLessThan(100);
    handle.hide();
  });
});
