// @vitest-environment jsdom
/**
 * Tests for `showSprinklePicker` — the popup menu launched by [+] zone
 * buttons. Covers the toggle, separator, dismissal (outside click / Esc),
 * empty-state, and item selection callbacks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PanelRegistry } from '../../src/ui/panel-registry.js';
import type { PanelDescriptor, ZoneId } from '../../src/ui/panel-types.js';
import { showSprinklePicker } from '../../src/ui/sprinkle-picker.js';

function makeAnchor(): HTMLElement {
  const anchor = document.createElement('button');
  // jsdom returns zeros from getBoundingClientRect; that's fine — the picker
  // only reads the rect to set `top`/`left` and does not branch on values.
  document.body.appendChild(anchor);
  return anchor;
}

function makeRegistry(
  descriptors: Array<{ id: string; label: string; zone: ZoneId | null }>
): PanelRegistry {
  const registry = new PanelRegistry();
  for (const d of descriptors) {
    const desc: PanelDescriptor = {
      id: d.id,
      label: d.label,
      zone: d.zone,
    } as PanelDescriptor;
    registry.register(desc);
  }
  return registry;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.querySelector('.sprinkle-picker')?.remove();
});

describe('showSprinklePicker', () => {
  it('is a no-op when there are no closed panels and no available sprinkles', () => {
    const registry = makeRegistry([]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
      getAvailableSprinkles: () => [],
    });
    expect(document.querySelector('.sprinkle-picker')).toBeNull();
  });

  it('renders only closed panels when no sprinkles are available', () => {
    const registry = makeRegistry([
      { id: 'terminal', label: 'Terminal', zone: null },
      { id: 'files', label: 'Files', zone: 'rail' },
      { id: 'memory', label: 'Memory', zone: null },
    ]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    });
    const picker = document.querySelector('.sprinkle-picker')!;
    const items = picker.querySelectorAll('.sprinkle-picker__item');
    expect(items).toHaveLength(2);
    const labels = Array.from(items).map((el) => el.textContent);
    expect(labels).toContain('Terminal');
    expect(labels).toContain('Memory');
    expect(labels).not.toContain('Files');
  });

  it('renders only sprinkles when no panels are closed', () => {
    const registry = makeRegistry([]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
      getAvailableSprinkles: () => [
        { name: 'github', title: 'GitHub' },
        { name: 'jira', title: 'Jira' },
      ],
    });
    const picker = document.querySelector('.sprinkle-picker')!;
    const items = picker.querySelectorAll('.sprinkle-picker__item');
    expect(items).toHaveLength(2);
    expect(Array.from(items).map((el) => el.textContent)).toEqual(['GitHub', 'Jira']);
  });

  it('inserts a separator between closed panels and available sprinkles', () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
      getAvailableSprinkles: () => [{ name: 'github', title: 'GitHub' }],
    });
    const picker = document.querySelector('.sprinkle-picker')!;
    expect(picker.children).toHaveLength(3);
    expect(picker.children[0].textContent).toBe('Terminal');
    // The separator has no `.sprinkle-picker__item` class.
    expect(picker.children[1].classList.contains('sprinkle-picker__item')).toBe(false);
    expect(picker.children[2].textContent).toBe('GitHub');
  });

  it('toggles closed when the picker is already open', () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    const opts = {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    };
    showSprinklePicker(makeAnchor(), 'rail', opts);
    expect(document.querySelector('.sprinkle-picker')).not.toBeNull();
    showSprinklePicker(makeAnchor(), 'rail', opts);
    expect(document.querySelector('.sprinkle-picker')).toBeNull();
  });

  it('selecting a panel item invokes onSelectPanel with the triggering zone', () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    const onSelectPanel = vi.fn();
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel, onSelectSprinkle: vi.fn() },
    });
    const item = document.querySelector('.sprinkle-picker__item') as HTMLElement;
    item.click();
    expect(onSelectPanel).toHaveBeenCalledWith('terminal', 'rail');
    expect(document.querySelector('.sprinkle-picker')).toBeNull();
  });

  it('selecting a sprinkle item invokes onSelectSprinkle and dismisses', () => {
    const registry = makeRegistry([]);
    const onSelectSprinkle = vi.fn();
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle },
      getAvailableSprinkles: () => [{ name: 'github', title: 'GitHub' }],
    });
    const item = document.querySelector('.sprinkle-picker__item') as HTMLElement;
    item.click();
    expect(onSelectSprinkle).toHaveBeenCalledWith('github', 'rail');
    expect(document.querySelector('.sprinkle-picker')).toBeNull();
  });

  it('hover styling toggles background on enter/leave', () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    });
    const item = document.querySelector('.sprinkle-picker__item') as HTMLElement;
    item.dispatchEvent(new Event('mouseenter'));
    expect(item.style.background).not.toBe('');
    item.dispatchEvent(new Event('mouseleave'));
    expect(item.style.background).toBe('');
  });

  it('dismisses on Escape', async () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    });
    // The picker installs its document listeners on the next animation
    // frame, so wait one frame before dispatching the Escape.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.sprinkle-picker')).toBeNull();
  });

  it('dismisses on outside click', async () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.sprinkle-picker')).toBeNull();
  });

  it('does not dismiss on a click inside the picker', async () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    showSprinklePicker(makeAnchor(), 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const picker = document.querySelector('.sprinkle-picker') as HTMLElement;
    picker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // Picker should still be present.
    expect(document.querySelector('.sprinkle-picker')).not.toBeNull();
  });

  it('uses anchor.getBoundingClientRect() to position the menu', () => {
    const registry = makeRegistry([{ id: 'terminal', label: 'Terminal', zone: null }]);
    const anchor = makeAnchor();
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({ left: 50, top: 100, right: 150, bottom: 200, width: 100, height: 100 }) as DOMRect,
    });
    showSprinklePicker(anchor, 'rail', {
      registry,
      callbacks: { onSelectPanel: vi.fn(), onSelectSprinkle: vi.fn() },
    });
    const picker = document.querySelector('.sprinkle-picker') as HTMLElement;
    expect(picker.style.left).toBe('50px');
    expect(picker.style.top).toBe('204px');
  });
});
