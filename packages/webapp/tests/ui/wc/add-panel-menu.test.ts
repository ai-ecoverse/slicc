// @vitest-environment jsdom
/**
 * The panels-and-layouts menu: the one UI surface for adding/removing panels and
 * for saving, loading and deleting named layouts.
 *
 * Saving matters most here because it WRITES A FILE from a user gesture, so the
 * name-handling cases (cancel, whitespace, path traversal) are the ones worth
 * pinning rather than the rendering.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { LAYOUT_SCHEMA_VERSION, SliccLayout } from '@slicc/webcomponents';
import { registerPanel, unregisterPanel } from '@slicc/webcomponents/panel/registry';
import {
  type AddPanelMenuDeps,
  createAddPanelMenu,
  sanitizeLayoutName,
} from '../../../src/ui/wc/add-panel-menu.js';

function makeLayout(): SliccLayout {
  const layout = new SliccLayout();
  document.body.appendChild(layout);
  layout.setLayout({
    version: LAYOUT_SCHEMA_VERSION,
    id: 'current',
    base: { zones: { center: ['chat'] } },
  });
  return layout;
}

function makeDeps(over: Partial<AddPanelMenuDeps> = {}): AddPanelMenuDeps {
  return {
    layout: makeLayout(),
    onToggle: vi.fn(),
    onLoadLayout: vi.fn(),
    onSaveLayout: vi.fn(),
    onDeleteLayout: vi.fn(),
    listLayoutNames: async () => ({ saved: [], presets: ['default'] }),
    promptForName: () => 'my layout',
    ...over,
  };
}

/** Open the menu and wait for its async render. */
async function open(root: HTMLElement): Promise<HTMLElement> {
  (root.querySelector('.slicc-addpanel__btn') as HTMLElement).click();
  // `render()` awaits `listLayoutNames`; two microtask turns covers it.
  await Promise.resolve();
  await Promise.resolve();
  return root.querySelector('.slicc-addpanel__menu') as HTMLElement;
}

function rows(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll('.slicc-addpanel__item')] as HTMLElement[];
}

function rowNamed(menu: HTMLElement, label: string): HTMLElement {
  return rows(menu).find((r) => r.textContent?.includes(label)) as HTMLElement;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('sanitizeLayoutName', () => {
  it('lowercases and hyphenates a human name', () => {
    expect(sanitizeLayoutName('My Dashboard')).toBe('my-dashboard');
  });

  it('keeps dots, dashes and underscores', () => {
    expect(sanitizeLayoutName('work_v2.1-final')).toBe('work_v2.1-final');
  });

  it('REFUSES path traversal — the name becomes a file path', () => {
    // `/workspace/layouts/<name>.json`, so an unsanitized `../../etc/sudoers` would
    // escape the layouts directory entirely.
    expect(sanitizeLayoutName('../../etc/sudoers')).toBe('etc-sudoers');
    expect(sanitizeLayoutName('/absolute/path')).toBe('absolute-path');
    expect(sanitizeLayoutName('..')).toBeNull();
  });

  it('returns null for a name that reduces to nothing', () => {
    expect(sanitizeLayoutName('   ')).toBeNull();
    expect(sanitizeLayoutName('///')).toBeNull();
    expect(sanitizeLayoutName('')).toBeNull();
  });

  it('caps the length', () => {
    expect(sanitizeLayoutName('a'.repeat(200))).toHaveLength(64);
  });
});

describe('saving a layout from the menu', () => {
  it('offers "Save layout as…" in the SAME menu as the panels', async () => {
    // One surface for panels, sprinkles and layouts — not a separate place to look.
    const deps = makeDeps();
    registerPanel({
      meta: { id: 'chat', title: 'Chat' },
      source: { kind: 'element', tag: 'slicc-panel' },
      origin: 'builtin',
    });
    const menu = await open(createAddPanelMenu(deps));

    expect(rowNamed(menu, 'Chat')).toBeDefined();
    expect(rowNamed(menu, 'Save layout as…')).toBeDefined();
    unregisterPanel('chat');
  });

  it('prompts, then saves under the sanitized name', async () => {
    const onSaveLayout = vi.fn();
    const deps = makeDeps({ onSaveLayout, promptForName: () => 'My Dashboard' });
    const menu = await open(createAddPanelMenu(deps));

    rowNamed(menu, 'Save layout as…').click();

    expect(onSaveLayout).toHaveBeenCalledWith('my-dashboard');
  });

  it('offers the current layout id as the default name', async () => {
    const promptForName = vi.fn(() => 'x');
    const menu = await open(createAddPanelMenu(makeDeps({ promptForName })));

    rowNamed(menu, 'Save layout as…').click();

    expect(promptForName).toHaveBeenCalledWith('Save this layout as:', 'current');
  });

  it('does NOT save when the prompt is cancelled', async () => {
    const onSaveLayout = vi.fn();
    const menu = await open(
      createAddPanelMenu(makeDeps({ onSaveLayout, promptForName: () => null }))
    );

    rowNamed(menu, 'Save layout as…').click();

    expect(onSaveLayout).not.toHaveBeenCalled();
  });

  it('does NOT save a name that sanitizes to nothing', async () => {
    // Better to do nothing than to write a file under an invented name.
    const onSaveLayout = vi.fn();
    const menu = await open(
      createAddPanelMenu(makeDeps({ onSaveLayout, promptForName: () => '   ' }))
    );

    rowNamed(menu, 'Save layout as…').click();

    expect(onSaveLayout).not.toHaveBeenCalled();
  });

  it('closes the menu after saving', async () => {
    const root = createAddPanelMenu(makeDeps());
    const menu = await open(root);
    rowNamed(menu, 'Save layout as…').click();
    expect(menu.hasAttribute('open')).toBe(false);
  });
});

describe('listing and loading layouts', () => {
  it('lists saved documents and presets', async () => {
    const deps = makeDeps({
      listLayoutNames: async () => ({ saved: ['mine'], presets: ['default', 'dev'] }),
    });
    const menu = await open(createAddPanelMenu(deps));

    expect(rowNamed(menu, 'mine')).toBeDefined();
    expect(rowNamed(menu, 'default')).toBeDefined();
    expect(rowNamed(menu, 'dev')).toBeDefined();
  });

  it('loads on click', async () => {
    const onLoadLayout = vi.fn();
    const deps = makeDeps({
      onLoadLayout,
      listLayoutNames: async () => ({ saved: ['mine'], presets: [] }),
    });
    const menu = await open(createAddPanelMenu(deps));

    rowNamed(menu, 'mine').click();

    expect(onLoadLayout).toHaveBeenCalledWith('mine');
  });

  it('shows the Layouts group even with nothing saved, since Save lives there', async () => {
    const menu = await open(createAddPanelMenu(makeDeps()));
    expect(menu.textContent).toContain('Layouts');
    expect(rowNamed(menu, 'Save layout as…')).toBeDefined();
  });

  it('still renders the panel list when listing layouts FAILS', async () => {
    // The panel toggles are this menu's primary function; a VFS error must not
    // blank them.
    registerPanel({
      meta: { id: 'chat', title: 'Chat' },
      source: { kind: 'element', tag: 'slicc-panel' },
      origin: 'builtin',
    });
    const deps = makeDeps({
      listLayoutNames: async () => {
        throw new Error('no fs');
      },
    });
    const menu = await open(createAddPanelMenu(deps));

    expect(rowNamed(menu, 'Chat')).toBeDefined();
    unregisterPanel('chat');
  });
});

describe('deleting a saved layout', () => {
  async function withSaved(over: Partial<AddPanelMenuDeps> = {}): Promise<HTMLElement> {
    return open(
      createAddPanelMenu(
        makeDeps({
          listLayoutNames: async () => ({ saved: ['mine'], presets: ['default'] }),
          ...over,
        })
      )
    );
  }

  it('offers a delete button on a SAVED layout', async () => {
    const menu = await withSaved();
    expect(rowNamed(menu, 'mine').querySelector('.slicc-addpanel__del')).not.toBeNull();
  });

  it('offers NO delete on a preset — presets are read-only', async () => {
    const menu = await withSaved();
    expect(rowNamed(menu, 'default').querySelector('.slicc-addpanel__del')).toBeNull();
  });

  it('deletes without also loading the layout underneath', async () => {
    // The button sits inside the row, so it must stop propagation or a delete would
    // load the layout it just removed.
    const onDeleteLayout = vi.fn();
    const onLoadLayout = vi.fn();
    const menu = await withSaved({ onDeleteLayout, onLoadLayout });

    (rowNamed(menu, 'mine').querySelector('.slicc-addpanel__del') as HTMLElement).click();

    expect(onDeleteLayout).toHaveBeenCalledWith('mine');
    expect(onLoadLayout).not.toHaveBeenCalled();
  });
});
