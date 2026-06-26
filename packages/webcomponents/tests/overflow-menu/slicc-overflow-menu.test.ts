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

  it('clicking an item emits overflow-action with action + context and closes', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    SliccOverflowMenu.show({ anchor, items: ITEMS, context: { path: '/test.txt' } });
    const menu = document.querySelector('slicc-overflow-menu') as SliccOverflowMenu;
    const onAction = vi.fn();
    menu.addEventListener('overflow-action', onAction);
    const row = menu.shadowRoot?.querySelector('[data-action="rename"]') as HTMLElement;
    row.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    const detail = onAction.mock.calls[0][0].detail;
    expect(detail).toEqual({ action: 'rename', context: { path: '/test.txt' } });
    expect(document.querySelector('slicc-overflow-menu')).toBeNull();
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
