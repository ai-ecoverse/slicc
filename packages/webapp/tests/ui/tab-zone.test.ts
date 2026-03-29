// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TabZone, type TabZoneTab } from '../../src/ui/tab-zone.js';

// Mock localStorage
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
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage });

function el(): HTMLElement {
  return document.createElement('div');
}

function makeTab(overrides: Partial<TabZoneTab> = {}): TabZoneTab {
  return {
    id: 'test',
    label: 'Test',
    closable: false,
    element: el(),
    ...overrides,
  };
}

describe('TabZone', () => {
  let tabBar: HTMLElement;
  let contentArea: HTMLElement;

  beforeEach(() => {
    tabBar = el();
    contentArea = el();
    storage.clear();
    vi.clearAllMocks();
  });

  it('adds a tab and auto-activates it', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'terminal', label: 'Terminal' }));

    expect(zone.getActiveTabId()).toBe('terminal');
    expect(zone.hasTab('terminal')).toBe(true);
    expect(zone.tabCount).toBe(1);
    expect(tabBar.children.length).toBe(1);
    expect(contentArea.children.length).toBe(1);
  });

  it('does not duplicate tabs with same id', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'terminal' }));
    zone.addTab(makeTab({ id: 'terminal' }));

    expect(zone.tabCount).toBe(1);
  });

  it('switches between tabs', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    const el1 = el();
    const el2 = el();
    zone.addTab(makeTab({ id: 'a', element: el1 }));
    zone.addTab(makeTab({ id: 'b', element: el2 }));

    expect(zone.getActiveTabId()).toBe('a');
    expect(el1.style.display).toBe('flex');
    expect(el2.style.display).toBe('none');

    zone.activateTab('b');
    expect(zone.getActiveTabId()).toBe('b');
    expect(el1.style.display).toBe('none');
    expect(el2.style.display).toBe('flex');
  });

  it('calls onActivate when a tab is activated', () => {
    const onActivate = vi.fn();
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'x' }));
    zone.addTab(makeTab({ id: 'y', onActivate }));

    zone.activateTab('y');
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('fires onTabActivate callback', () => {
    const onTabActivate = vi.fn();
    const zone = new TabZone(tabBar, contentArea, 'primary', { onTabActivate });
    zone.addTab(makeTab({ id: 'a' }));
    zone.addTab(makeTab({ id: 'b' }));

    zone.activateTab('b');
    expect(onTabActivate).toHaveBeenCalledWith('b');
  });

  it('removes a tab and falls back to first remaining', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'a' }));
    zone.addTab(makeTab({ id: 'b' }));
    zone.activateTab('b');

    zone.removeTab('b');
    expect(zone.hasTab('b')).toBe(false);
    expect(zone.getActiveTabId()).toBe('a');
    expect(zone.tabCount).toBe(1);
  });

  it('handles removing the last tab', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'only' }));
    zone.removeTab('only');

    expect(zone.getActiveTabId()).toBeNull();
    expect(zone.tabCount).toBe(0);
  });

  it('renders close button for closable tabs', () => {
    const onTabClose = vi.fn();
    const zone = new TabZone(tabBar, contentArea, 'primary', { onTabClose });
    zone.addTab(makeTab({ id: 'closable', closable: true }));

    const closeBtn = tabBar.querySelector('.mini-tabs__tab-close');
    expect(closeBtn).toBeTruthy();

    closeBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onTabClose).toHaveBeenCalledWith('closable');
  });

  it('does not render close button for non-closable tabs', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'fixed', closable: false }));

    expect(tabBar.querySelector('.mini-tabs__tab-close')).toBeNull();
  });

  it('persists active tab to localStorage', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'a' }));
    zone.addTab(makeTab({ id: 'b' }));
    zone.activateTab('b');

    expect(storage.get('slicc-primary-tab')).toBe('b');
  });

  it('restores active tab from localStorage', () => {
    // Pre-seed storage before zone creates tabs
    storage.set('slicc-drawer-tab', 'memory');
    const zone = new TabZone(tabBar, contentArea, 'drawer');
    zone.addTab(makeTab({ id: 'files' }));
    zone.addTab(makeTab({ id: 'memory' }));

    // addTab auto-activates first tab, overwriting storage.
    // Restore from the original saved value by re-seeding:
    storage.set('slicc-drawer-tab', 'memory');
    const restored = zone.restoreActiveTab();
    expect(restored).toBe('memory');
    expect(zone.getActiveTabId()).toBe('memory');
  });

  it('returns null when restoring with no saved tab', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'a' }));

    // addTab wrote 'a' to storage, so clear it to test "no saved" path
    storage.clear();
    expect(zone.restoreActiveTab()).toBeNull();
  });

  it('ignores restoring a non-existent tab', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'a' }));

    // Set a tab id that doesn't exist in the zone
    storage.set('slicc-primary-tab', 'gone');
    const restored = zone.restoreActiveTab();
    expect(restored).toBeNull();
    expect(zone.getActiveTabId()).toBe('a');
  });

  it('getTabIds returns all tab ids', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'a' }));
    zone.addTab(makeTab({ id: 'b' }));
    zone.addTab(makeTab({ id: 'c' }));

    expect(zone.getTabIds()).toEqual(['a', 'b', 'c']);
  });

  it('enables [+] button', () => {
    const onAddClick = vi.fn();
    const zone = new TabZone(tabBar, contentArea, 'primary', { onAddClick });
    zone.enableAddButton();

    const addBtn = tabBar.querySelector('.mini-tabs__tab--add');
    expect(addBtn).toBeTruthy();
    expect(addBtn!.textContent).toBe('+');

    addBtn!.dispatchEvent(new Event('click'));
    expect(onAddClick).toHaveBeenCalledTimes(1);
  });

  it('inserts new tabs before the [+] button', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.enableAddButton();
    zone.addTab(makeTab({ id: 'first' }));
    zone.addTab(makeTab({ id: 'second' }));

    const children = Array.from(tabBar.children);
    expect(children[children.length - 1].classList.contains('mini-tabs__tab--add')).toBe(true);
    expect((children[0] as HTMLElement).dataset.tabId).toBe('first');
    expect((children[1] as HTMLElement).dataset.tabId).toBe('second');
  });

  it('ignores activateTab for non-existent id', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'a' }));
    zone.activateTab('nonexistent');
    expect(zone.getActiveTabId()).toBe('a');
  });

  it('ignores removeTab for non-existent id', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.removeTab('nonexistent');
    expect(zone.tabCount).toBe(0);
  });

  it('renders and clears numeric badges for tabs', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary');
    zone.addTab(makeTab({ id: 'chat', label: 'Chat' }));

    zone.setTabBadge('chat', 3);
    const badge = tabBar.querySelector('.mini-tabs__tab-badge') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('3 notifications');

    zone.setTabBadge('chat', 0);
    expect(tabBar.querySelector('.mini-tabs__tab-badge')).toBeNull();
  });

  it('uses the configured class prefix for tab badges', () => {
    const zone = new TabZone(tabBar, contentArea, 'primary', {}, { classPrefix: 'tab-bar' });
    zone.addTab(makeTab({ id: 'chat', label: 'Chat' }));

    zone.setTabBadge('chat', 2);
    const badge = tabBar.querySelector('.tab-bar__tab-badge') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('2');
  });
});
