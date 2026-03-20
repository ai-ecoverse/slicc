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
  /** If set, renders as an icon-only mini-tab (SVG innerHTML). */
  icon?: string;
  /** If true, tab is always visible in the bar but starts dimmed (content not mounted). */
  pinned?: boolean;
}

export interface TabZoneCallbacks {
  /** Called when a tab becomes active. */
  onTabActivate?: (id: string) => void;
  /** Called when a tab's close button is clicked. */
  onTabClose?: (id: string) => void;
  /** Called when the [+] button is clicked. */
  onAddClick?: () => void;
  /** Called when the fullpage toggle is clicked. */
  onFullpageToggle?: (isFullpage: boolean) => void;
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
    mounted: boolean;
  }>();
  private activeTabId: string | null = null;
  private callbacks: TabZoneCallbacks;
  private addBtn: HTMLButtonElement | null = null;
  private fullpageBtn: HTMLButtonElement | null = null;
  private isFullpage = false;
  private separator: HTMLElement | null = null;
  /** Scrollable wrapper for text (non-pinned) tabs. */
  private scrollArea: HTMLElement | null = null;
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
    btn.dataset.tabId = tab.id;

    if (tab.pinned && tab.icon) {
      // Icon-only pinned tab — always visible, starts dimmed
      btn.className = `${this.classPrefix}__tab ${this.classPrefix}__tab--icon ${this.classPrefix}__tab--dimmed`;
      btn.innerHTML = tab.icon;
      btn.setAttribute('aria-label', tab.label);
      btn.dataset.tooltip = tab.label;
      btn.dataset.tooltipPos = 'top';

      // Insert after existing pinned tabs, before separator/text tabs
      const insertBefore = this.separator || this.findFirstNonPinnedBtn() || this.addBtn;
      if (insertBefore) {
        this.tabBar.insertBefore(btn, insertBefore);
      } else {
        this.tabBar.appendChild(btn);
      }

      // Ensure separator + scroll area exist after pinned tabs
      if (!this.separator) {
        this.separator = document.createElement('div');
        this.separator.className = `${this.classPrefix}__separator`;
        this.scrollArea = document.createElement('div');
        this.scrollArea.className = `${this.classPrefix}__scroll`;
        // Insert separator and scroll area before utility buttons (+, fullpage)
        const utilBefore = this.addBtn || this.fullpageBtn;
        if (utilBefore) {
          this.tabBar.insertBefore(this.separator, utilBefore);
          this.tabBar.insertBefore(this.scrollArea, utilBefore);
        } else {
          this.tabBar.appendChild(this.separator);
          this.tabBar.appendChild(this.scrollArea);
        }
      }

      btn.addEventListener('click', () => {
        const entry = this.tabs.get(tab.id);
        if (entry && !entry.mounted) {
          this.enablePinnedTab(tab.id);
        }
        this.activateTab(tab.id);
      });

      // Pinned tabs: content NOT mounted yet
      this.tabs.set(tab.id, { btn, container: tab.element, tab, mounted: false });

    } else {
      // Normal text tab
      btn.className = `${this.classPrefix}__tab`;
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

      // Insert into scroll area if it exists, otherwise directly into tab bar
      if (this.scrollArea) {
        this.scrollArea.appendChild(btn);
      } else if (this.addBtn) {
        this.tabBar.insertBefore(btn, this.addBtn);
      } else {
        this.tabBar.appendChild(btn);
      }

      const container = tab.element;
      container.style.display = 'none';
      this.contentArea.appendChild(container);

      this.tabs.set(tab.id, { btn, container, tab, mounted: true });

      // Auto-activate first mounted tab
      if (!this.activeTabId || !this.tabs.get(this.activeTabId)?.mounted) {
        this.activateTab(tab.id);
      }
    }
  }

  /** Remove a tab from this zone. */
  removeTab(id: string): void {
    const entry = this.tabs.get(id);
    if (!entry) return;

    entry.btn.remove();
    if (entry.mounted) entry.container.remove();
    this.tabs.delete(id);

    if (this.activeTabId === id) {
      // Activate the first remaining mounted tab
      const firstMounted = Array.from(this.tabs.entries()).find(([, e]) => e.mounted);
      if (firstMounted) {
        this.activateTab(firstMounted[0]);
      } else {
        this.activeTabId = null;
      }
    }
  }

  /** Enable a pinned tab — mount its content and light up the icon. */
  enablePinnedTab(id: string): void {
    const entry = this.tabs.get(id);
    if (!entry || entry.mounted) return;

    entry.mounted = true;
    entry.btn.classList.remove(`${this.classPrefix}__tab--dimmed`);
    entry.container.style.display = 'none';
    this.contentArea.appendChild(entry.container);
  }

  /** Check if a pinned tab is enabled (content mounted). */
  isPinnedTabEnabled(id: string): boolean {
    return this.tabs.get(id)?.mounted ?? false;
  }

  /** Activate a tab by id. Only works if the tab is mounted. */
  activateTab(id: string): void {
    const target = this.tabs.get(id);
    if (!target || !target.mounted) return;

    this.activeTabId = id;
    for (const [tabId, { btn, container, mounted }] of this.tabs) {
      const active = tabId === id;
      btn.classList.toggle(`${this.classPrefix}__tab--active`, active);
      if (mounted) {
        container.style.display = active ? 'flex' : 'none';
      }
    }

    try {
      localStorage.setItem(this.storageKey, id);
    } catch {
      // localStorage may be unavailable
    }

    target.tab.onActivate?.();
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
    this.addBtn.dataset.tooltip = 'Open panel';
    this.addBtn.dataset.tooltipPos = 'top';
    this.addBtn.setAttribute('aria-label', 'Open panel');
    this.addBtn.addEventListener('click', () => this.callbacks.onAddClick?.());
    this.tabBar.appendChild(this.addBtn);
  }

  /** Update the [+] button disabled state. */
  setAddButtonEnabled(enabled: boolean): void {
    if (!this.addBtn) return;
    this.addBtn.disabled = !enabled;
  }

  /** Enable the fullpage toggle button in the tab bar. */
  enableFullpageButton(): void {
    if (this.fullpageBtn) return;

    this.fullpageBtn = document.createElement('button');
    this.fullpageBtn.className = `${this.classPrefix}__tab ${this.classPrefix}__tab--fullpage`;
    this.fullpageBtn.dataset.tooltip = 'Full page';
    this.fullpageBtn.dataset.tooltipPos = 'top';
    this.fullpageBtn.setAttribute('aria-label', 'Toggle full page');
    // Expand icon (arrows pointing outward)
    this.fullpageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4v4"/><path d="M6 14H2v-4"/><path d="M14 2L9.5 6.5"/><path d="M2 14l4.5-4.5"/></svg>';

    this.fullpageBtn.addEventListener('click', () => {
      this.isFullpage = !this.isFullpage;
      this.fullpageBtn!.classList.toggle(`${this.classPrefix}__tab--active`, this.isFullpage);
      // Swap icon: expand ↔ collapse
      this.fullpageBtn!.innerHTML = this.isFullpage
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6h-4V2"/><path d="M2 10h4v4"/><path d="M10 6l4.5-4.5"/><path d="M6 10L1.5 14.5"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4v4"/><path d="M6 14H2v-4"/><path d="M14 2L9.5 6.5"/><path d="M2 14l4.5-4.5"/></svg>';
      this.fullpageBtn!.dataset.tooltip = this.isFullpage ? 'Exit full page' : 'Full page';
      this.callbacks.onFullpageToggle?.(this.isFullpage);
    });

    this.tabBar.appendChild(this.fullpageBtn);
  }

  /** Restore the active tab from localStorage. Returns the restored id or null. */
  restoreActiveTab(): string | null {
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved && this.tabs.has(saved) && this.tabs.get(saved)!.mounted) {
        this.activateTab(saved);
        return saved;
      }
    } catch {
      // localStorage may be unavailable
    }
    return null;
  }

  /** Find the first non-pinned tab button in the tab bar. */
  private findFirstNonPinnedBtn(): HTMLButtonElement | null {
    for (const [, entry] of this.tabs) {
      if (!entry.tab.pinned) return entry.btn;
    }
    return null;
  }
}
