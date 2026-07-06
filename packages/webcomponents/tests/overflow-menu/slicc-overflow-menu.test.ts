import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../../src/overflow-menu/slicc-overflow-menu.js';
import { SliccOverflowMenu } from '../../src/overflow-menu/slicc-overflow-menu.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const ITEMS: MenuItem[] = [
  { id: 'rename', label: 'Rename' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'copy-path', label: 'Copy path' },
  { id: 'delete', label: 'Delete', destructive: true },
];

describe('slicc-overflow-menu', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    SliccOverflowMenu.hide();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-overflow-menu')).toBe(SliccOverflowMenu);
  });

  it('show() renders the menu anchored in the DOM', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    SliccOverflowMenu.show({ anchor, items: ITEMS });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    expect(menu).not.toBeNull();
    expect(menu.shadowRoot?.querySelectorAll('[data-action]')).toHaveLength(4);
  });

  it('hides items with visible: false', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const items: MenuItem[] = [
      { id: 'rename', label: 'Rename' },
      { id: 'open-browser', label: 'Open in browser', visible: false },
    ];
    SliccOverflowMenu.show({ anchor, items });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    expect(menu.shadowRoot?.querySelectorAll('[data-action]')).toHaveLength(1);
  });

  it('clicking an item emits overflow-action on the anchor with action + context and closes', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    SliccOverflowMenu.show({ anchor, items: ITEMS, context: { path: '/test.txt' } });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    const onAction = vi.fn();
    // The menu is appended to document.body, a separate branch from wherever the
    // anchor lives — callers (e.g. the file tree) listen on the anchor's ancestry,
    // so the event must dispatch from the anchor for it to bubble there.
    anchor.addEventListener('overflow-action', onAction);
    const row = menu.shadowRoot?.querySelector('[data-action="rename"]') as HTMLElement;
    row.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    const detail = onAction.mock.calls[0][0].detail;
    expect(detail).toEqual({ action: 'rename', context: { path: '/test.txt' } });
    expect(document.querySelector('slicc-overflow-menu')).toBeNull();
  });

  it('dispatchTarget receives overflow-action even after anchor is detached', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.appendChild(anchor);
    document.body.appendChild(container);
    SliccOverflowMenu.show({
      anchor,
      items: ITEMS,
      context: { path: '/test.txt' },
      dispatchTarget: container,
    });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    const onAction = vi.fn();
    container.addEventListener('overflow-action', onAction);
    // Simulate a caller (e.g. the file tree) rebuilding its rows — and thus
    // detaching `anchor` — before the user acts on the still-open menu.
    anchor.remove();
    const row = menu.shadowRoot?.querySelector('[data-action="copy-path"]') as HTMLElement;
    row.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0].detail).toEqual({
      action: 'copy-path',
      context: { path: '/test.txt' },
    });
  });

  it('falls back to anchor when no dispatchTarget is given, and misses once detached', () => {
    const container = document.createElement('div');
    const anchor = document.createElement('button');
    container.appendChild(anchor);
    document.body.appendChild(container);
    SliccOverflowMenu.show({ anchor, items: ITEMS });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    const onAction = vi.fn();
    container.addEventListener('overflow-action', onAction);
    anchor.remove();
    const row = menu.shadowRoot?.querySelector('[data-action="copy-path"]') as HTMLElement;
    row.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('hide() removes the menu from DOM', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    SliccOverflowMenu.show({ anchor, items: ITEMS });
    expect(document.querySelector('slicc-overflow-menu')).not.toBeNull();
    SliccOverflowMenu.hide();
    expect(document.querySelector('slicc-overflow-menu')).toBeNull();
  });

  it('Escape dismisses the menu', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    SliccOverflowMenu.show({ anchor, items: ITEMS });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('slicc-overflow-menu')).toBeNull();
  });

  it('only one menu open at a time', () => {
    const a1 = document.createElement('button');
    const a2 = document.createElement('button');
    document.body.append(a1, a2);
    SliccOverflowMenu.show({ anchor: a1, items: ITEMS });
    SliccOverflowMenu.show({ anchor: a2, items: ITEMS });
    expect(document.querySelectorAll('slicc-overflow-menu')).toHaveLength(1);
  });

  it('styles destructive items distinctly', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    SliccOverflowMenu.show({ anchor, items: ITEMS });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    const del = menu.shadowRoot?.querySelector('[data-action="delete"]') as HTMLElement;
    expect(del.classList.contains('destructive')).toBe(true);
  });
});
