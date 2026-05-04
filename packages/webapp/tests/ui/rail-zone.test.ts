// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RailZone } from '../../src/ui/rail-zone.js';

// jsdom under vitest doesn't always expose a working localStorage with
// `.clear()` / `.removeItem()`; install a minimal in-memory shim.
const storage = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storage.delete(key);
  }),
  clear: vi.fn(() => storage.clear()),
  get length() {
    return storage.size;
  },
  key: vi.fn((_i: number) => null),
};
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

function makeRail() {
  const railEl = document.createElement('div');
  const contentEl = document.createElement('div');
  document.body.appendChild(railEl);
  document.body.appendChild(contentEl);
  return { railEl, contentEl };
}

function makeItem(id: string, position: 'top' | 'bottom' = 'top') {
  const element = document.createElement('div');
  element.dataset.testItem = id;
  return {
    id,
    label: id,
    icon: '<svg></svg>',
    element,
    position,
  };
}

describe('RailZone', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    storage.clear();
    vi.useRealTimers();
  });

  it('starts collapsed and shows no active item', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));

    expect(rail.isCollapsed()).toBe(true);
    expect(rail.getActiveItemId()).toBeNull();
    expect(contentEl.classList.contains('rail-content--collapsed')).toBe(true);
  });

  it('plain click on idle item activates and expands the panel', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));

    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;
    btn.click();

    expect(rail.getActiveItemId()).toBe('terminal');
    expect(rail.isCollapsed()).toBe(false);
    expect(contentEl.classList.contains('rail-content--collapsed')).toBe(false);
    expect(btn.classList.contains('rail__item--active')).toBe(true);
  });

  it('plain click on the already-active item collapses the panel', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));

    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;
    btn.click();
    expect(rail.getActiveItemId()).toBe('terminal');

    btn.click();
    expect(rail.isCollapsed()).toBe(true);
    expect(rail.getActiveItemId()).toBeNull();
    expect(contentEl.classList.contains('rail-content--collapsed')).toBe(true);
    expect(btn.classList.contains('rail__item--active')).toBe(false);
  });

  it('switching to a different item moves the active state without collapsing', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));
    rail.addItem(makeItem('files', 'bottom'));

    const t = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;
    const f = railEl.querySelector<HTMLButtonElement>('[data-item-id="files"]')!;
    t.click();
    f.click();

    expect(rail.getActiveItemId()).toBe('files');
    expect(rail.isCollapsed()).toBe(false);
    expect(t.classList.contains('rail__item--active')).toBe(false);
    expect(f.classList.contains('rail__item--active')).toBe(true);
  });

  it.each([
    { name: 'Cmd', flag: { metaKey: true } },
    { name: 'Ctrl', flag: { ctrlKey: true } },
    { name: 'Shift', flag: { shiftKey: true } },
    { name: 'Alt', flag: { altKey: true } },
  ])('%s-click activates AND switches to fullpage', ({ flag }) => {
    const { railEl, contentEl } = makeRail();
    const onFullpageToggle = vi.fn();
    const rail = new RailZone(railEl, contentEl, 'primary', { onFullpageToggle });
    rail.addItem(makeItem('terminal', 'bottom'));

    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...flag }));

    expect(rail.getActiveItemId()).toBe('terminal');
    expect(rail.isFullpage()).toBe(true);
    expect(onFullpageToggle).toHaveBeenCalledWith(true);
  });

  it('long-press activates AND switches to fullpage; mouseup before threshold does not', () => {
    vi.useFakeTimers();
    const { railEl, contentEl } = makeRail();
    const onFullpageToggle = vi.fn();
    const rail = new RailZone(railEl, contentEl, 'primary', { onFullpageToggle });
    rail.addItem(makeItem('terminal', 'bottom'));
    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;

    // Quick click — no fullpage, just normal toggle.
    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(rail.__test__.longPressMs - 100);
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('click'));
    expect(rail.isFullpage()).toBe(false);

    // Long press — past the threshold without releasing → fullpage.
    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(rail.__test__.longPressMs + 1);
    expect(rail.isFullpage()).toBe(true);
    expect(onFullpageToggle).toHaveBeenCalledWith(true);
  });

  it('long-press still goes fullpage even when the item is already expanded', () => {
    vi.useFakeTimers();
    const { railEl, contentEl } = makeRail();
    const onFullpageToggle = vi.fn();
    const rail = new RailZone(railEl, contentEl, 'primary', { onFullpageToggle });
    rail.addItem(makeItem('terminal', 'bottom'));
    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;

    // First, plain click expands without going fullpage.
    btn.dispatchEvent(new MouseEvent('click'));
    expect(rail.getActiveItemId()).toBe('terminal');
    expect(rail.isFullpage()).toBe(false);

    // Long-press while already-active should promote to fullpage.
    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(rail.__test__.longPressMs + 1);
    expect(rail.isFullpage()).toBe(true);
    expect(onFullpageToggle).toHaveBeenLastCalledWith(true);
  });

  it('long-press paints a growing ripple inside a clipped press layer', () => {
    vi.useFakeTimers();
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));
    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="terminal"]')!;

    expect(btn.querySelector('.rail__item-press-layer')).not.toBeNull();
    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 5 }));

    const ripple = btn.querySelector<HTMLElement>('.rail__item-press');
    expect(ripple).not.toBeNull();
    expect(ripple!.style.transitionDuration).toBe(`${rail.__test__.longPressMs}ms`);

    // Releasing before threshold removes the ripple.
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    expect(btn.querySelector('.rail__item-press')).toBeNull();
  });

  it('removing an item that was active collapses the panel', () => {
    const { railEl, contentEl } = makeRail();
    const onCollapse = vi.fn();
    const rail = new RailZone(railEl, contentEl, 'primary', { onCollapse });
    rail.addItem(makeItem('sprinkle-foo', 'top'));

    const btn = railEl.querySelector<HTMLButtonElement>('[data-item-id="sprinkle-foo"]')!;
    btn.click();
    expect(rail.getActiveItemId()).toBe('sprinkle-foo');

    rail.removeItem('sprinkle-foo');
    expect(rail.hasItem('sprinkle-foo')).toBe(false);
    expect(rail.getActiveItemId()).toBeNull();
    expect(rail.isCollapsed()).toBe(true);
    expect(onCollapse).toHaveBeenCalled();
  });

  it('items render in the section matching their position prop', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));
    rail.addItem(makeItem('files', 'bottom'));
    rail.addItem(makeItem('sprinkle-a', 'top'));

    const top = railEl.querySelector('.rail__section--top')!;
    const bottom = railEl.querySelector('.rail__section--bottom')!;

    expect(top.querySelectorAll('[data-item-id]').length).toBe(1);
    expect(bottom.querySelectorAll('[data-item-id]').length).toBe(2);
    expect(top.querySelector('[data-item-id="sprinkle-a"]')).not.toBeNull();
    expect(bottom.querySelector('[data-item-id="terminal"]')).not.toBeNull();
  });

  it('the [+] button is hidden by default and only the section markup exposes it', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('terminal', 'bottom'));

    rail.enableAddButton();
    const addBtn = railEl.querySelector<HTMLButtonElement>('.rail__item--add')!;
    expect(addBtn).not.toBeNull();
    // No overflow possible in jsdom (offsetHeight is 0), so the +
    // button must default to hidden.
    expect(addBtn.style.display).toBe('none');
  });

  it('closable items do NOT render a close affordance — sprinkles can only be hidden via collapse', () => {
    const { railEl, contentEl } = makeRail();
    const onItemClose = vi.fn();
    const rail = new RailZone(railEl, contentEl, 'primary', { onItemClose });
    rail.addItem({
      id: 'sprinkle-x',
      label: 'X',
      icon: '<svg></svg>',
      element: document.createElement('div'),
      position: 'top',
      closable: true,
    });

    expect(railEl.querySelector('[data-item-id="sprinkle-x"] .rail__item-close')).toBeNull();
    expect(onItemClose).not.toHaveBeenCalled();
  });

  it('programmatic activateItem honors defaultFullpage when caller omits the flag', () => {
    const { railEl, contentEl } = makeRail();
    const onFullpageToggle = vi.fn();
    const rail = new RailZone(
      railEl,
      contentEl,
      'primary',
      { onFullpageToggle },
      { defaultFullpage: true }
    );
    rail.addItem(makeItem('sprinkle-foo', 'top'));

    rail.activateItem('sprinkle-foo');

    expect(rail.isFullpage()).toBe(true);
    expect(onFullpageToggle).toHaveBeenCalledWith(true);
  });

  it('explicit fullpage option still wins over defaultFullpage', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary', {}, { defaultFullpage: true });
    rail.addItem(makeItem('terminal', 'bottom'));

    rail.activateItem('terminal', { fullpage: false });
    expect(rail.isFullpage()).toBe(false);
  });

  it('programmatic activateItem leaves fullpage off when defaultFullpage is unset (standalone)', () => {
    const { railEl, contentEl } = makeRail();
    const rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('sprinkle-foo', 'top'));

    rail.activateItem('sprinkle-foo');

    expect(rail.isFullpage()).toBe(false);
  });

  it('persists and restores the last active item across constructor calls', () => {
    const { railEl, contentEl } = makeRail();
    let rail = new RailZone(railEl, contentEl, 'primary');
    rail.addItem(makeItem('files', 'bottom'));
    rail.addItem(makeItem('memory', 'bottom'));
    railEl.querySelector<HTMLButtonElement>('[data-item-id="memory"]')!.click();
    expect(rail.getActiveItemId()).toBe('memory');

    // Simulate a reload: tear down + reconstruct.
    document.body.innerHTML = '';
    const fresh = makeRail();
    rail = new RailZone(fresh.railEl, fresh.contentEl, 'primary');
    rail.addItem(makeItem('files', 'bottom'));
    rail.addItem(makeItem('memory', 'bottom'));
    rail.restoreActive();
    expect(rail.getActiveItemId()).toBe('memory');
  });
});
