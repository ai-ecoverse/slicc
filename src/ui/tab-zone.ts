/**
 * TabZone — generic tab bar + content area manager for a single zone.
 *
 * Replaces the manual primaryTabs/drawerTabs Maps and switchPrimaryTab()/
 * switchDrawerTab() methods in layout.ts with a reusable component.
 */

import type { ZoneId } from './panel-types.js';

export interface TabZoneTab {
  id: string;
  label: string;
  closable: boolean;
  element: HTMLElement;
  onActivate?: () => void;
}

export interface TabZoneCallbacks {
  /** Called when a tab becomes active. */
  onTabActivate?: (id: string) => void;
  /** Called when a tab's close button is clicked. */
  onTabClose?: (id: string) => void;
  /** Called when the [+] button is clicked. */
  onAddClick?: () => void;
}

export interface TabZoneOptions {
  /** CSS class prefix for tab buttons (default: 'mini-tabs'). */
  classPrefix?: string;
}

export class TabZone {
  readonly zoneId: ZoneId;

  private tabBar: HTMLElement;
  private contentArea: HTMLElement;
  private tabs = new Map<string, {
    btn: HTMLButtonElement;
    container: HTMLElement;
    tab: TabZoneTab;
  }>();
  private activeTabId: string | null = null;
  private callbacks: TabZoneCallbacks;
  private addBtn: HTMLButtonElement | null = null;
  private storageKey: string;
  private classPrefix: string;

  constructor(
    tabBar: HTMLElement,
    contentArea: HTMLElement,
    zoneId: ZoneId,
    callbacks: TabZoneCallbacks = {},
    options: TabZoneOptions = {},
  ) {
    this.tabBar = tabBar;
    this.contentArea = contentArea;
    this.zoneId = zoneId;
    this.callbacks = callbacks;
    this.storageKey = `slicc-${zoneId}-tab`;
    this.classPrefix = options.classPrefix ?? 'mini-tabs';
  }

  /** Add a tab to this zone. */
  addTab(tab: TabZoneTab): void {
    if (this.tabs.has(tab.id)) return;

    const btn = document.createElement('button');
    btn.className = `${this.classPrefix}__tab`;
    btn.dataset.tabId = tab.id;

    btn.appendChild(document.createTextNode(tab.label));

    if (tab.closable) {
      const closeSpan = document.createElement('span');
      closeSpan.className = `${this.classPrefix}__tab-close`;
      closeSpan.title = 'Close panel';
      closeSpan.textContent = '\u00D7';
      closeSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onTabClose?.(tab.id);
      });
      btn.appendChild(closeSpan);
    }

    btn.addEventListener('click', () => this.activateTab(tab.id));

    // Insert before the [+] button if it exists
    if (this.addBtn) {
      this.tabBar.insertBefore(btn, this.addBtn);
    } else {
      this.tabBar.appendChild(btn);
    }

    const container = tab.element;
    container.style.display = 'none';
    this.contentArea.appendChild(container);

    this.tabs.set(tab.id, { btn, container, tab });

    // Auto-activate first tab or if no active tab
    if (!this.activeTabId) {
      this.activateTab(tab.id);
    }
  }

  /** Remove a tab from this zone. */
  removeTab(id: string): void {
    const entry = this.tabs.get(id);
    if (!entry) return;

    entry.btn.remove();
    entry.container.remove();
    this.tabs.delete(id);

    if (this.activeTabId === id) {
      // Activate the first remaining tab
      const firstId = this.tabs.keys().next().value;
      if (firstId) {
        this.activateTab(firstId);
      } else {
        this.activeTabId = null;
      }
    }
  }

  /** Activate a tab by id. */
  activateTab(id: string): void {
    if (!this.tabs.has(id)) return;

    this.activeTabId = id;
    for (const [tabId, { btn, container }] of this.tabs) {
      const active = tabId === id;
      btn.classList.toggle(`${this.classPrefix}__tab--active`, active);
      container.style.display = active ? 'flex' : 'none';
    }

    try {
      localStorage.setItem(this.storageKey, id);
    } catch {
      // localStorage may be unavailable
    }

    const entry = this.tabs.get(id);
    entry?.tab.onActivate?.();
    this.callbacks.onTabActivate?.(id);
  }

  /** Get the currently active tab id. */
  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  /** Get all tab ids in this zone. */
  getTabIds(): string[] {
    return Array.from(this.tabs.keys());
  }

  /** Check if a tab exists in this zone. */
  hasTab(id: string): boolean {
    return this.tabs.has(id);
  }

  /** Get the tab count. */
  get tabCount(): number {
    return this.tabs.size;
  }

  /** Enable the [+] button. */
  enableAddButton(): void {
    if (this.addBtn) return;

    this.addBtn = document.createElement('button');
    this.addBtn.className = `${this.classPrefix}__tab ${this.classPrefix}__tab--add`;
    this.addBtn.textContent = '+';
    this.addBtn.title = 'Open panel';
    this.addBtn.addEventListener('click', () => this.callbacks.onAddClick?.());
    this.tabBar.appendChild(this.addBtn);
  }

  /** Update the [+] button disabled state. */
  setAddButtonEnabled(enabled: boolean): void {
    if (!this.addBtn) return;
    this.addBtn.disabled = !enabled;
  }

  /** Restore the active tab from localStorage. Returns the restored id or null. */
  restoreActiveTab(): string | null {
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved && this.tabs.has(saved)) {
        this.activateTab(saved);
        return saved;
      }
    } catch {
      // localStorage may be unavailable
    }
    return null;
  }
}
