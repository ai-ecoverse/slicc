/**
 * Layout — split-pane (standalone) or tabbed (extension) layout.
 *
 * Standalone mode (CLI):
 *   ┌───────┬─────────────┬───┬───────────────┐
 *   │  Header (full width)                    │
 *   ├───────┬─────────────┬───┬───────────────┤
 *   │Scoops │             │ ║ │  Terminal      │
 *   │       │  Chat       │ ║ ├───────────────┤
 *   │       │  Panel      │ ║ │  Files        │
 *   │       │             │ ║ │               │
 *   └───────┴─────────────┴───┴───────────────┘
 *
 * Extension mode (side panel):
 *   ┌─ Header [switcher] ─────────┐
 *   ├─ Tabs: [Chat] [Term] [Files] [Memory] ─┤
 *   │                                │
 *   │  Active panel (full size)      │
 *   │                                │
 *   └────────────────────────────────┘
 */

import { ChatPanel } from './chat-panel.js';
import { TerminalPanel } from './terminal-panel.js';
import { FileBrowserPanel } from './file-browser-panel.js';
import { MemoryPanel } from './memory-panel.js';
import { ScoopsPanel } from './scoops-panel.js';
import { ScoopSwitcher } from './scoop-switcher.js';
import {
  getApiKey,
  clearAllSettings,
  getSelectedModelId,
  setSelectedModelId,
  showProviderSettings,
  getAllAvailableModels,
  getAccounts,
  getProviderConfig,
  removeAccount,
} from './provider-settings.js';
import { EXTENSION_TAB_SPECS, setHiddenTabs, type ExtensionTabId } from './tabbed-ui.js';
import { TabZone } from './tab-zone.js';
import { PanelRegistry } from './panel-registry.js';
import { showSprinklePicker } from './sprinkle-picker.js';
import type { ZoneId } from './panel-types.js';
// ChatMessage import removed — copy chat moved to feedback row
import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';

export interface LayoutPanels {
  chat: ChatPanel;
  terminal: TerminalPanel;
  fileBrowser: FileBrowserPanel;
  memory: MemoryPanel;
  scoops: ScoopsPanel;
}

type TabId = ExtensionTabId | string;

export class Layout {
  private root: HTMLElement;
  private isExtension: boolean;

  // Split-layout elements (standalone only)
  private scoopsEl!: HTMLElement;
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private verticalDivider!: HTMLElement;
  private terminalContainer!: HTMLElement;
  private iframeContainer!: HTMLElement;

  // Thread header (sub-header with scoop name)
  private threadHeaderEl!: HTMLElement;
  private threadHeaderName!: HTMLElement;

  // Unified right panel zone (Terminal + Files + Memory + sprinkle tabs)
  private primaryZoneEl!: HTMLElement;
  private primaryZone!: TabZone;

  // Keep drawerZone as alias for backward compat
  private get drawerZone(): TabZone {
    return this.primaryZone;
  }
  private get drawerZoneEl(): HTMLElement {
    return this.primaryZoneEl;
  }

  // Tabbed-layout elements (extension only)
  private tabContainers = new Map<TabId, HTMLElement>();
  private activeTab: TabId = 'chat';
  /** Pre-created containers for debug tabs (terminal, memory) — always created, tab added on demand. */
  private debugTabContainers: { terminal: HTMLElement; memory: HTMLElement } | null = null;

  // Scoop switcher (extension mode)
  private scoopSwitcher: ScoopSwitcher | null = null;
  private scoopSwitcherEl: HTMLElement | null = null;

  // User avatar element
  private avatarEl!: HTMLElement;

  // Dynamic logo
  private logoSvg: SVGSVGElement | null = null; // kept for API compat (unused)
  private logoImg: HTMLImageElement | null = null;
  private logoScoopCount = -1; // -1 = initial load, skip animation
  private headerHamburger: HTMLButtonElement | null = null;

  public panels!: LayoutPanels;
  public readonly registry = new PanelRegistry();
  public onModelChange?: (model: string) => void;
  /** Re-populate the model dropdown (call after provider login/logout). */
  public refreshModels?: () => void;
  public onScoopSelect?: (scoop: RegisteredScoop) => void;
  public onClearChat?: () => Promise<void>;
  public onClearFilesystem?: () => Promise<void>;
  public onSprinkleClose?: (name: string) => void;

  /** Callback to get available sprinkles for the [+] picker. */
  public getAvailableSprinkles?: () => Array<{ name: string; title: string }>;
  /** Callback to open a sprinkle by name. */
  public onOpenSprinkle?: (name: string, zone?: ZoneId) => Promise<void>;

  // Layout uses CSS flex — no manual width fractions needed

  constructor(root: HTMLElement, isExtension = false) {
    this.root = root;
    this.isExtension = isExtension;
    if (isExtension) {
      this.buildTabbedLayout();
    } else {
      this.buildSplitLayout();
    }
  }

  /** Set the orchestrator on the scoop switcher (extension mode). */
  setScoopSwitcherOrchestrator?(
    orchestrator: import('../scoops/orchestrator.js').Orchestrator
  ): void {
    this.scoopSwitcher?.setOrchestrator(orchestrator);
  }

  /** Update scoop switcher status (extension mode). */
  updateScoopSwitcherStatus?(scoopJid: string, status: ScoopTabState['status']): void {
    this.scoopSwitcher?.updateStatus(scoopJid, status);
  }

  /** Set the selected scoop in the switcher dropdown (extension mode). */
  setScoopSwitcherSelected?(jid: string): void {
    this.scoopSwitcher?.setSelected(jid);
  }

  /** Re-render the scoop switcher dropdown (extension mode). */
  refreshScoopSwitcher?(): void {
    this.scoopSwitcher?.refresh();
  }

  setActiveTab(id: TabId): void {
    if (!this.isExtension) return;
    this.extensionZone?.activateTab(id);
  }

  getActiveTab(): TabId {
    return this.activeTab;
  }

  setPendingHandoffCount(count: number): void {
    if (!this.isExtension) return;
    this.extensionZone.setTabBadge('chat', count > 0 ? count : null);
  }

  /** Check if the terminal panel is currently open in a zone. */
  isTerminalOpen(): boolean {
    if (this.isExtension) return true;
    return this.primaryZone.isPinnedTabEnabled('terminal');
  }

  /** Toggle the agent processing indicator on the thread header. */
  setAgentProcessing(busy: boolean): void {
    this.threadHeaderEl?.classList.toggle('thread-header--processing', busy);
  }

  /** Open the terminal tab (enables pinned tab if dimmed). */
  openTerminal(): void {
    if (this.isExtension) return;
    if (!this.primaryZone.isPinnedTabEnabled('terminal')) {
      this.primaryZone.enablePinnedTab('terminal');
    }
    // Don't steal focus from an active sprinkle
    const active = this.primaryZone.getActiveTabId();
    if (active && active.startsWith('sprinkle-')) return;
    this.primaryZone.activateTab('terminal');
  }

  /** Show or hide debug tabs (terminal, memory) in extension mode. */
  setDebugTabs(show: boolean): void {
    if (!this.isExtension || !this.debugTabContainers) return;

    const DEBUG_TABS = [
      {
        id: 'terminal' as const,
        label: 'Terminal',
        container: this.debugTabContainers.terminal,
        onActivate: () => this.panels?.terminal?.refit?.(),
      },
      {
        id: 'memory' as const,
        label: 'Memory',
        container: this.debugTabContainers.memory,
        onActivate: () => this.panels?.memory?.refresh(),
      },
    ];

    for (const { id, label, container, onActivate } of DEBUG_TABS) {
      if (show && !this.extensionZone.hasTab(id)) {
        this.extensionZone.addTab({ id, label, closable: false, element: container, onActivate });
        this.tabContainers.set(id, container);
      } else if (!show && this.extensionZone.hasTab(id)) {
        this.extensionZone.removeTab(id);
        this.tabContainers.delete(id);
      }
    }

    setHiddenTabs(show ? [] : ['terminal', 'memory']);
  }

  // ── Shared: Header ──────────────────────────────────────────────────

  private buildHeader(parent: HTMLElement): void {
    const header = document.createElement('div');
    header.className = 'header';

    // ── Auto-select first model if none set ────────────────────────
    const ensureModelSelected = () => {
      const currentModelId = getSelectedModelId();
      if (currentModelId) return;
      const groups = getAllAvailableModels();
      for (const group of groups) {
        if (group.models.length > 0) {
          const { defaultModelId } = getProviderConfig(group.providerId);
          const preferred = defaultModelId
            ? group.models.find((m) => m.id.toLowerCase().includes(defaultModelId.toLowerCase()))
            : undefined;
          const model = preferred ?? group.models[0];
          setSelectedModelId(`${group.providerId}:${model.id}`);
          return;
        }
      }
    };
    ensureModelSelected();
    this.refreshModels = () => {
      ensureModelSelected();
      this.panels?.chat?.refreshModelSelector();
      this.refreshAvatar();
    };

    const row = document.createElement('div');
    row.className = 'header__row';

    const brand = document.createElement('div');
    brand.className = 'header__brand';

    if (this.isExtension) {
      // Extension mode: no scoops rail visible, show logo instead
      const logoSize = 24;
      const logo = this.sliccLogo(logoSize);
      brand.appendChild(logo);
    } else {
      // Standalone mode: hamburger toggle for the scoops panel
      const hamburger = document.createElement('button');
      hamburger.className = 'scoops-hamburger';
      hamburger.dataset.tooltip = 'Toggle navigation';
      hamburger.dataset.tooltipPos = 'right';
      hamburger.setAttribute('aria-label', 'Toggle navigation');
      hamburger.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M9.61805 16.2451C9.31922 15.958 9.30945 15.4834 9.59754 15.1855L14.5839 10.002L9.58485 4.80469C9.29677 4.50684 9.30653 4.03223 9.60536 3.74512C9.90223 3.45801 10.3778 3.4668 10.6649 3.76563L16.1649 9.48243C16.4452 9.77247 16.4452 10.2315 16.1649 10.5215L10.6776 16.2246C10.5311 16.3779 10.3339 16.4551 10.1376 16.4551C9.95008 16.4551 9.76258 16.3857 9.61805 16.2451Z"/><path d="M3.86805 16.2451C3.56922 15.958 3.55945 15.4834 3.84754 15.1855L8.83387 10.002L3.83485 4.80469C3.54677 4.50684 3.55653 4.03223 3.85536 3.74512C4.15223 3.45801 4.62782 3.4668 4.91493 3.76563L10.4149 9.48243C10.6952 9.77247 10.6952 10.2315 10.4149 10.5215L4.92763 16.2246C4.78114 16.3779 4.58388 16.4551 4.38759 16.4551C4.20008 16.4551 4.01258 16.3857 3.86805 16.2451Z"/></svg>';
      this.headerHamburger = hamburger;
      hamburger.addEventListener('click', () => {
        this.panels?.scoops?.toggleExpanded();
        // Swap chevron direction
        const expanded = this.scoopsEl?.classList.contains('layout__scoops--expanded');
        hamburger.innerHTML = expanded
          ? '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M9.86241 16.4551C9.66612 16.4551 9.46886 16.3779 9.32237 16.2246L3.83507 10.5215C3.5548 10.2315 3.5548 9.77247 3.83507 9.48243L9.33507 3.76563C9.62218 3.4668 10.0978 3.45801 10.3946 3.74512C10.6935 4.03223 10.7032 4.50684 10.4151 4.80469L5.41613 10.002L10.4025 15.1855C10.6906 15.4834 10.6808 15.958 10.382 16.2451C10.2374 16.3857 10.0499 16.4551 9.86241 16.4551Z"/><path d="M15.6124 16.4551C15.4161 16.4551 15.2189 16.3779 15.0724 16.2246L9.58507 10.5215C9.3048 10.2315 9.3048 9.77247 9.58507 9.48243L15.0851 3.76563C15.3722 3.4668 15.8478 3.45801 16.1446 3.74512C16.4435 4.03223 16.4532 4.50684 16.1652 4.80469L11.1661 10.002L16.1525 15.1855C16.4406 15.4834 16.4308 15.958 16.132 16.2451C15.9874 16.3857 15.7999 16.4551 15.6124 16.4551Z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M9.61805 16.2451C9.31922 15.958 9.30945 15.4834 9.59754 15.1855L14.5839 10.002L9.58485 4.80469C9.29677 4.50684 9.30653 4.03223 9.60536 3.74512C9.90223 3.45801 10.3778 3.4668 10.6649 3.76563L16.1649 9.48243C16.4452 9.77247 16.4452 10.2315 16.1649 10.5215L10.6776 16.2246C10.5311 16.3779 10.3339 16.4551 10.1376 16.4551C9.95008 16.4551 9.76258 16.3857 9.61805 16.2451Z"/><path d="M3.86805 16.2451C3.56922 15.958 3.55945 15.4834 3.84754 15.1855L8.83387 10.002L3.83485 4.80469C3.54677 4.50684 3.55653 4.03223 3.85536 3.74512C4.15223 3.45801 4.62782 3.4668 4.91493 3.76563L10.4149 9.48243C10.6952 9.77247 10.6952 10.2315 10.4149 10.5215L4.92763 16.2246C4.78114 16.3779 4.58388 16.4551 4.38759 16.4551C4.20008 16.4551 4.01258 16.3857 3.86805 16.2451Z"/></svg>';
      });
      brand.appendChild(hamburger);
    }

    const title = document.createElement('div');
    title.className = 'header__title';
    title.textContent = 'slicc';
    brand.appendChild(title);

    row.appendChild(brand);

    if (this.isExtension) {
      this.scoopSwitcherEl = document.createElement('div');
      this.scoopSwitcherEl.className = 'scoop-switcher';
      this.scoopSwitcher = new ScoopSwitcher(this.scoopSwitcherEl, {
        onScoopSelect: (scoop) => this.onScoopSelect?.(scoop),
        onDeleteScoop: (jid) => {
          this.panels?.scoops?.deleteScoop?.(jid);
        },
      });
      row.appendChild(this.scoopSwitcherEl);
    }

    const spacer = document.createElement('div');
    spacer.className = 'header__spacer';
    row.appendChild(spacer);

    // Avatar
    this.avatarEl = this.buildUserAvatar();
    row.appendChild(this.avatarEl);

    header.appendChild(row);
    parent.appendChild(header);
  }

  /** Scoop brand palette — cycles for scoops beyond 5. */
  private static readonly SCOOP_COLORS = ['#f000a0', '#00f0f0', '#90f000', '#15d675', '#e68619'];

  /** Create the SLICC logo as an <img> using the new Sliccy variants. */
  private sliccLogo(size = 22): HTMLImageElement {
    const img = document.createElement('img');
    img.width = size;
    img.height = size;
    img.src = '/logos/sliccy-color-0scoops-128x128.png';
    img.alt = 'slicc';
    img.classList.add('header__logo');
    img.style.objectFit = 'contain';
    this.logoImg = img;
    return img;
  }

  /** Fixed scoop radius in SVG units — scoops never shrink. */
  private static readonly SCOOP_R = 5;
  private static readonly SCOOP_SPACING = 8.5; // center-to-center horizontal
  private static readonly ROW_STEP = 7.5; // center-to-center vertical

  /**
   * Calculate pyramid layout positions for N scoops.
   * Constant size — the ice cream just gets taller and wider.
   */
  private pyramidLayout(count: number): Array<{ cx: number; cy: number }> {
    if (count === 0) return [];

    const { SCOOP_SPACING, ROW_STEP } = Layout;

    // Find bottom row width: smallest w where w*(w+1)/2 >= count
    let w = 1;
    while ((w * (w + 1)) / 2 < count) w++;

    // Build rows bottom-up
    const rows: number[] = [];
    let remaining = count;
    let rowWidth = w;
    while (remaining > 0) {
      const n = Math.min(remaining, rowWidth);
      rows.push(n);
      remaining -= n;
      rowWidth--;
    }

    const centerX = 16;
    const coneTopY = 19;
    const positions: Array<{ cx: number; cy: number }> = [];
    let y = coneTopY - Layout.SCOOP_R;

    for (const rowCount of rows) {
      const totalW = (rowCount - 1) * SCOOP_SPACING;
      const startX = centerX - totalW / 2;
      for (let i = 0; i < rowCount; i++) {
        positions.push({ cx: startX + i * SCOOP_SPACING, cy: y });
      }
      y -= ROW_STEP;
    }

    return positions;
  }

  /** Update the logo to reflect current scoop count. */
  updateLogoScoops(scoops: RegisteredScoop[]): void {
    const nonCone = scoops.filter((s) => !s.isCone);
    const prevCount = this.logoScoopCount;

    // Skip redundant calls (same count, no change)
    if (prevCount === nonCone.length && prevCount >= 0) return;
    this.logoScoopCount = nonCone.length;

    // Update header logo image
    const clamped = Math.min(Math.max(nonCone.length, 0), 10);
    if (this.logoImg) {
      this.logoImg.src = `/logos/sliccy-color-${clamped}scoops-128x128.png`;
    }

    // Update browser favicon and extension icon to match scoop count
    this.updateFaviconForScoops(nonCone.length);
  }

  /** Get initials from a user name (up to 2 characters). */
  /** Update browser favicon and extension toolbar icon to reflect scoop count. */
  private updateFaviconForScoops(scoopCount: number): void {
    const clamped = Math.min(Math.max(scoopCount, 0), 10);

    // Update browser tab favicon
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (link) {
      link.href = `/logos/sliccy-color-${clamped}scoops-32x32.png`;
    }

    // Update extension toolbar icon (if in extension mode)
    const chromeAny = typeof chrome !== 'undefined' ? (chrome as any) : null;
    if (chromeAny?.action?.setIcon) {
      chromeAny.action
        .setIcon({
          path: {
            16: `logos/sliccy-color-${clamped}scoops-16x16.png`,
            32: `logos/sliccy-color-${clamped}scoops-32x32.png`,
            48: `logos/sliccy-color-${clamped}scoops-48x48.png`,
            128: `logos/sliccy-color-${clamped}scoops-128x128.png`,
          },
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }

  private getInitials(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  /** Build the user avatar element — 28px circle, three states. */
  private buildUserAvatar(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'header__avatar';
    el.setAttribute('aria-label', 'Account');
    el.dataset.tooltip = 'Account';

    // Find first account with user info
    const accounts = getAccounts();
    const account = accounts.find((a) => a.userName || a.userAvatar);

    if (account?.userAvatar) {
      // Avatar URL
      const img = document.createElement('img');
      img.src = account.userAvatar;
      img.alt = account.userName ?? 'User';
      img.addEventListener('error', () => {
        // Fallback to initials on error
        el.removeChild(img);
        if (account.userName) {
          el.classList.add('header__avatar--initials');
          el.textContent = this.getInitials(account.userName);
        }
      });
      el.appendChild(img);
    } else if (account?.userName) {
      // Initials circle
      el.classList.add('header__avatar--initials');
      el.textContent = this.getInitials(account.userName);
    } else {
      // Placeholder person icon
      el.classList.add('header__avatar--placeholder');
      el.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 10c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v1c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-1c0-2.66-5.33-4-8-4z"/></svg>';
    }

    el.addEventListener('click', () => this.showAvatarPopover());
    return el;
  }

  /** Refresh the avatar after provider settings change. */
  private refreshAvatar(): void {
    if (!this.avatarEl) return;
    const parent = this.avatarEl.parentElement;
    if (!parent) return;
    const newAvatar = this.buildUserAvatar();
    parent.replaceChild(newAvatar, this.avatarEl);
    this.avatarEl = newAvatar;
  }

  /** Show the avatar profile popover. */
  private showAvatarPopover(): void {
    // Toggle — if already open, just close it
    const existing = document.querySelector('.avatar-popover');
    if (existing) {
      existing.remove();
      return;
    }

    const popover = document.createElement('div');
    popover.className = 'avatar-popover';

    // Find current account info
    const accounts = getAccounts();
    const account = accounts.find((a) => a.userName || a.accessToken || a.apiKey);

    if (account) {
      const userSection = document.createElement('div');
      userSection.className = 'avatar-popover__user';

      const nameEl = document.createElement('div');
      nameEl.className = 'avatar-popover__name';
      nameEl.textContent = account.userName || 'Logged in';
      userSection.appendChild(nameEl);

      const providerEl = document.createElement('div');
      providerEl.className = 'avatar-popover__provider';
      providerEl.textContent = getProviderConfig(account.providerId).name;
      userSection.appendChild(providerEl);

      popover.appendChild(userSection);

      // Sign out
      const signOutBtn = document.createElement('button');
      signOutBtn.className = 'avatar-popover__item';
      signOutBtn.textContent = 'Sign out';
      signOutBtn.addEventListener('click', () => {
        removeAccount(account.providerId);
        popover.remove();
        this.refreshAvatar();
        this.refreshModels?.();
      });
      popover.appendChild(signOutBtn);
    }

    // Clear all accounts (danger)
    if (accounts.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'avatar-popover__separator';
      popover.appendChild(sep);

      const clearAllBtn = document.createElement('button');
      clearAllBtn.className = 'avatar-popover__item avatar-popover__item--danger';
      clearAllBtn.textContent = 'Clear all accounts';
      clearAllBtn.addEventListener('click', () => {
        clearAllSettings();
        popover.remove();
        this.refreshAvatar();
        this.refreshModels?.();
      });
      popover.appendChild(clearAllBtn);
    }

    // Clear chat
    const sepChat = document.createElement('div');
    sepChat.className = 'avatar-popover__separator';
    popover.appendChild(sepChat);

    const clearChatBtn = document.createElement('button');
    clearChatBtn.className = 'avatar-popover__item avatar-popover__item--danger';
    clearChatBtn.textContent = 'Clear chat';
    clearChatBtn.addEventListener('click', async () => {
      popover.remove();
      await this.panels?.chat?.clearSession();
      await this.onClearChat?.();
      location.reload();
    });
    popover.appendChild(clearChatBtn);

    // Account settings link
    const sep2 = document.createElement('div');
    sep2.className = 'avatar-popover__separator';
    popover.appendChild(sep2);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'avatar-popover__item';
    settingsBtn.textContent = 'Account settings\u2026';
    settingsBtn.addEventListener('click', async () => {
      popover.remove();
      if (!getApiKey()) clearAllSettings();
      const changed = await showProviderSettings();
      if (changed) {
        this.refreshAvatar();
        this.refreshModels?.();
      }
    });
    popover.appendChild(settingsBtn);

    document.body.appendChild(popover);

    // Position below avatar
    const rect = this.avatarEl.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.right = `${window.innerWidth - rect.right}px`;

    // Dismiss on outside click or Escape (avatar clicks handled by toggle in showAvatarPopover)
    const dismiss = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
      } else if (popover.contains(e.target as Node) || this.avatarEl.contains(e.target as Node)) {
        return;
      }
      popover.remove();
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
    // Delay to avoid immediate dismissal from the click that opened it
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown', dismiss);
    });
  }

  // ── Extension: Tabbed Layout ────────────────────────────────────────

  /** Extension-mode TabZone (single zone for all tabs). */
  private extensionZone!: TabZone;

  private buildTabbedLayout(): void {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    this.buildHeader(this.root);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    this.root.appendChild(tabBar);

    // Tab content area
    const content = document.createElement('div');
    content.className = 'tab-content';
    this.root.appendChild(content);

    this.extensionZone = new TabZone(
      tabBar,
      content,
      'primary',
      {
        onTabActivate: (id) => {
          this.activeTab = id;
          if (id === 'terminal') this.panels?.terminal?.refit?.();
          if (id === 'memory') this.panels?.memory?.refresh();
        },
        onTabClose: (id) => {
          const name = id.startsWith('sprinkle-') ? id.slice(9) : id;
          this.onSprinkleClose?.(name);
        },
        onAddClick: () => this.showExtensionPicker(tabBar),
      },
      { classPrefix: 'tab-bar' }
    );

    // Create containers for built-in tabs
    const chatContainer = document.createElement('div');
    chatContainer.className = 'tab-content__panel';

    const terminalContainer = document.createElement('div');
    terminalContainer.className = 'tab-content__panel';

    const filesContainer = document.createElement('div');
    filesContainer.className = 'tab-content__panel';

    const memoryContainer = document.createElement('div');
    memoryContainer.className = 'tab-content__panel';

    // Add built-in tabs
    for (const { id, label } of EXTENSION_TAB_SPECS) {
      const container =
        id === 'chat'
          ? chatContainer
          : id === 'terminal'
            ? terminalContainer
            : id === 'files'
              ? filesContainer
              : memoryContainer;
      this.extensionZone.addTab({
        id,
        label,
        closable: false,
        element: container,
        onActivate:
          id === 'terminal'
            ? () => this.panels?.terminal?.refit?.()
            : id === 'memory'
              ? () => this.panels?.memory?.refresh()
              : undefined,
      });
      // Keep tabContainers in sync for backward compat
      this.tabContainers.set(id, container);
    }

    // Store debug tab containers for dynamic add/remove
    this.debugTabContainers = { terminal: terminalContainer, memory: memoryContainer };

    this.extensionZone.enableAddButton();

    // Hidden container for scoop iframes
    this.iframeContainer = document.createElement('div');
    this.iframeContainer.id = 'scoop-iframes';
    this.iframeContainer.style.display = 'none';
    this.root.appendChild(this.iframeContainer);

    // Create a dummy scoops element for extension mode (hidden — switcher is in header)
    this.scoopsEl = document.createElement('div');
    this.scoopsEl.style.display = 'none';
    this.root.appendChild(this.scoopsEl);

    // Create panels in their tab containers
    this.panels = {
      chat: new ChatPanel(chatContainer),
      terminal: new TerminalPanel(terminalContainer, {
        onClearTerminal: () => {
          this.panels.terminal.clearTerminal();
        },
      }),
      fileBrowser: new FileBrowserPanel(filesContainer, {
        onRunCommand: async (command) => {
          await this.runFileBrowserCommand(command);
          this.extensionZone.activateTab('terminal');
        },
      }),
      memory: new MemoryPanel(memoryContainer),
      scoops: new ScoopsPanel(this.scoopsEl, {
        onScoopSelect: (scoop) => this.onScoopSelect?.(scoop),
        onSendMessage: () => {},
        onScoopsChanged: (scoops) => this.updateLogoScoops(scoops),
      }),
    };

    // Wire chat panel model selector to layout's onModelChange
    this.panels.chat.onModelChange = (modelId) => this.onModelChange?.(modelId);
  }

  /** Show the [+] picker in extension mode. */
  private showExtensionPicker(anchor: HTMLElement): void {
    const availableSprinkles = this.getAvailableSprinkles?.() ?? [];
    // In extension mode, all panels are in one zone — filter already-open ones
    const openIds = new Set(this.extensionZone.getTabIds());
    const available = availableSprinkles.filter((p) => !openIds.has(`sprinkle-${p.name}`));

    if (available.length === 0) return;

    showSprinklePicker(anchor, 'primary', {
      registry: this.registry,
      callbacks: {
        onSelectPanel: () => {},
        onSelectSprinkle: (name) => {
          this.onOpenSprinkle?.(name);
        },
      },
      getAvailableSprinkles: () => available,
    });
  }

  private switchTab(id: TabId): void {
    if (this.extensionZone) {
      this.extensionZone.activateTab(id);
    }
  }

  // ── Standalone: Split Layout ────────────────────────────────────────

  private buildSplitLayout(): void {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    this.buildHeader(this.root);

    // Main layout
    const layout = document.createElement('div');
    layout.className = 'layout';

    // Scoops panel (leftmost — icon rail, 58px fixed)
    this.scoopsEl = document.createElement('div');
    this.scoopsEl.className = 'layout__scoops';
    layout.appendChild(this.scoopsEl);

    // Left panel (chat) — includes thread header
    this.leftEl = document.createElement('div');
    this.leftEl.className = 'layout__left';

    // Thread header (sub-header with scoop name)
    this.threadHeaderEl = document.createElement('div');
    this.threadHeaderEl.className = 'thread-header';
    const threadHeaderTitle = document.createElement('div');
    threadHeaderTitle.className = 'thread-header__title';
    // Chat history icon
    const threadIcon = document.createElement('span');
    threadIcon.className = 'thread-header__icon';
    threadIcon.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H7l-4 3V5a1 1 0 0 1 1-1z"/><path d="M7 8h6"/><path d="M7 11h3"/></svg>';
    threadHeaderTitle.appendChild(threadIcon);
    this.threadHeaderName = document.createElement('span');
    this.threadHeaderName.className = 'thread-header__name';
    this.threadHeaderName.textContent = 'sliccy';
    threadHeaderTitle.appendChild(this.threadHeaderName);
    this.threadHeaderEl.appendChild(threadHeaderTitle);

    // Right panel toggle button
    const panelToggle = document.createElement('button');
    panelToggle.className = 'thread-header__panel-toggle thread-header__panel-toggle--right';
    panelToggle.dataset.tooltip = 'Toggle panel';
    panelToggle.setAttribute('aria-label', 'Toggle panel');
    panelToggle.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 3v14"/></svg>';
    panelToggle.addEventListener('click', () => {
      this.rightEl.classList.toggle('layout__right--open');
    });
    // Clear chat button (in thread header, before panel toggle)
    const clearChatBtn = document.createElement('button');
    clearChatBtn.className = 'thread-header__panel-toggle';
    clearChatBtn.dataset.tooltip = 'Clear Chat';
    clearChatBtn.setAttribute('aria-label', 'Clear Chat');
    clearChatBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="m8.249,15.021c-.4,0-.733-.317-.748-.72l-.25-6.5c-.017-.414.307-.763.72-.778.01-.001.021-.001.03-.001.4,0,.733.317.748.72l.25,6.5c.017.414-.307.763-.72.778-.01.001-.021.001-.03.001Z" fill="currentColor"/><path d="m11.751,15.021c-.01,0-.02,0-.03-.001-.413-.016-.736-.364-.72-.778l.25-6.5c.015-.403.348-.72.748-.72.01,0,.02,0,.03.001.413.016.736.364.72.778l-.25,6.5c-.015.403-.348.72-.748.72Z" fill="currentColor"/><path d="m17,4h-3.5v-.75c0-1.24-1.01-2.25-2.25-2.25h-2.5c-1.24,0-2.25,1.01-2.25,2.25v.75h-3.5c-.414,0-.75.336-.75.75s.336.75.75.75h.52l.422,10.342c.048,1.21,1.036,2.158,2.248,2.158h7.619c1.212,0,2.2-.948,2.248-2.158l.422-10.342h.52c.414,0,.75-.336.75-.75s-.336-.75-.75-.75Zm-9-.75c0-.413.337-.75.75-.75h2.5c.413,0,.75.337.75.75v.75h-4v-.75Zm6.56,12.531c-.017.403-.346.719-.75.719h-7.619c-.404,0-.733-.316-.75-.719l-.42-10.281h9.959l-.42,10.281Z" fill="currentColor"/></svg>';
    clearChatBtn.addEventListener('click', async () => {
      await this.panels.chat.clearSession();
      await this.onClearChat?.();
      location.reload();
    });

    const threadActions = document.createElement('div');
    threadActions.className = 'thread-header__actions';
    threadActions.appendChild(clearChatBtn);
    threadActions.appendChild(panelToggle);
    this.threadHeaderEl.appendChild(threadActions);

    this.leftEl.appendChild(this.threadHeaderEl);

    // Chat container
    const chatContainer = document.createElement('div');
    chatContainer.style.cssText = 'display: flex; flex-direction: column; flex: 1; min-height: 0;';
    this.leftEl.appendChild(chatContainer);

    layout.appendChild(this.leftEl);

    // Vertical divider
    this.verticalDivider = document.createElement('div');
    this.verticalDivider.className = 'layout__divider layout__divider--vertical';
    layout.appendChild(this.verticalDivider);

    // Right panel — unified single zone with pill tabs
    this.rightEl = document.createElement('div');
    this.rightEl.className = 'layout__right';

    this.primaryZoneEl = document.createElement('div');
    this.primaryZoneEl.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';

    const primaryTabBar = document.createElement('div');
    primaryTabBar.className = 'mini-tabs';

    // Close button for overlay mode (<1440px) — first item in tab bar
    const rightCloseBtn = document.createElement('button');
    rightCloseBtn.className = 'thread-header__panel-toggle thread-header__panel-toggle--right';
    rightCloseBtn.dataset.tooltip = 'Close panel';
    rightCloseBtn.setAttribute('aria-label', 'Close panel');
    rightCloseBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14"/><path d="M3 3h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>';
    rightCloseBtn.addEventListener('click', () => {
      this.rightEl.classList.remove('layout__right--open');
    });
    primaryTabBar.appendChild(rightCloseBtn);

    this.primaryZoneEl.appendChild(primaryTabBar);

    const primaryContentArea = document.createElement('div');
    primaryContentArea.style.cssText =
      'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;';
    this.primaryZoneEl.appendChild(primaryContentArea);

    this.primaryZone = new TabZone(primaryTabBar, primaryContentArea, 'primary', {
      onTabActivate: (id) => {
        if (id === 'terminal') this.panels?.terminal?.refit();
        if (id === 'memory') this.panels?.memory?.refresh();
      },
      onTabClose: (id) => {
        const name = id.startsWith('sprinkle-') ? id.slice(9) : id;
        this.onSprinkleClose?.(name);
      },
      onAddClick: () => this.showPickerForZone('primary', primaryTabBar),
      onFullpageToggle: (isFullpage) => {
        this.leftEl.classList.toggle('layout__left--fullpage-hidden', isFullpage);
        this.verticalDivider.classList.toggle('layout__divider--fullpage-hidden', isFullpage);
        this.scoopsEl.classList.toggle('layout__scoops--fullpage-hidden', isFullpage);
        this.rightEl.classList.toggle('layout__right--fullpage', isFullpage);
      },
    });

    // Dev panel containers
    this.terminalContainer = document.createElement('div');
    this.terminalContainer.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';

    const fileBrowserContainer = document.createElement('div');
    fileBrowserContainer.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';

    const memoryContainer = document.createElement('div');
    memoryContainer.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; flex: 1;';

    // S2 icon SVGs for pinned tabs (16×16, filled)
    const iconSvg = (inner: string) =>
      `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    const codeIcon =
      '<path d="M5.5 14.5C5.30762 14.5 5.11621 14.4268 4.96973 14.2803L1.21973 10.5303C0.92676 10.2373 0.92676 9.76269 1.21973 9.46972L4.96973 5.71972C5.2627 5.42675 5.73731 5.42675 6.03028 5.71972C6.32325 6.01269 6.32325 6.4873 6.03028 6.78027L2.81055 10L6.03028 13.2197C6.32325 13.5127 6.32325 13.9873 6.03028 14.2803C5.8838 14.4268 5.69238 14.5 5.5 14.5Z" fill="currentColor"/><path d="M14.5 14.5C14.3076 14.5 14.1162 14.4268 13.9697 14.2803C13.6768 13.9873 13.6768 13.5127 13.9697 13.2197L17.1895 9.99999L13.9697 6.78026C13.6768 6.48729 13.6768 6.01268 13.9697 5.71971C14.2627 5.42674 14.7373 5.42674 15.0303 5.71971L18.7803 9.46971C19.0732 9.76268 19.0732 10.2373 18.7803 10.5303L15.0303 14.2803C14.8838 14.4267 14.6924 14.5 14.5 14.5Z" fill="currentColor"/><path d="M8.22852 18C8.16993 18 8.11036 17.9932 8.05176 17.9795C7.64844 17.8818 7.40137 17.4766 7.49805 17.0742L10.998 2.57422C11.0957 2.1709 11.5078 1.92871 11.9033 2.02051C12.3066 2.11817 12.5537 2.52344 12.457 2.92578L8.95703 17.4258C8.87402 17.7695 8.56642 18 8.22852 18Z" fill="currentColor"/>';
    const dataIcon =
      '<path d="M18 4.75C18 2.61621 13.9756 1.5 10 1.5C6.02441 1.5 2 2.61621 2 4.75C2 4.81714 2.01538 4.88037 2.02325 4.94556C2.01696 4.98462 2 5.01978 2 5.06055V15C2 17.0615 6.14697 18 10 18C13.853 18 18 17.0615 18 15V5.06055C18 5.01978 17.983 4.98462 17.9767 4.94556C17.9846 4.88037 18 4.81714 18 4.75ZM16.5002 9.99451C16.4084 10.4097 14.2719 11.5 10 11.5C5.72705 11.5 3.59033 10.4092 3.5 10V6.72449C5.02985 7.56665 7.52393 8 10 8C12.4761 8 14.9701 7.56665 16.5001 6.72437L16.5002 9.99451ZM10 3C14.2886 3 16.5 4.22656 16.5 4.75C16.5 5.27344 14.2886 6.5 10 6.5C5.71143 6.5 3.5 5.27344 3.5 4.75C3.5 4.22656 5.71143 3 10 3ZM10 16.5C5.72705 16.5 3.59033 15.4092 3.5 15V11.8464C5.05219 12.6304 7.58337 13 10 13C12.4168 13 14.9482 12.6304 16.5003 11.8463L16.5005 14.9941C16.4097 15.4092 14.273 16.5 10 16.5Z" fill="currentColor"/>';
    const settingsIcon =
      '<path d="M10.0039 12.5889C9.11573 12.5889 8.25098 12.1289 7.77588 11.3057C7.06787 10.0781 7.48975 8.50489 8.71582 7.79688C9.30908 7.45313 10.001 7.36329 10.665 7.54004C11.3276 7.71777 11.8814 8.14356 12.2241 8.73731C12.5674 9.33106 12.6582 10.0234 12.481 10.6855C12.3032 11.3486 11.8784 11.9024 11.2842 12.2451C10.8809 12.4785 10.4395 12.5889 10.0039 12.5889ZM9.07471 10.5557C9.36914 11.0645 10.0229 11.2392 10.5342 10.9463C10.7812 10.8037 10.958 10.5732 11.0317 10.2978C11.1055 10.0225 11.0679 9.73436 10.9253 9.48729C10.7822 9.24022 10.5522 9.06346 10.2764 8.98924C10.0015 8.916 9.71337 8.95408 9.46581 9.09569C8.95556 9.39061 8.78027 10.0449 9.07471 10.5557Z" fill="currentColor"/><path d="M6.90674 18.3184C6.56738 18.3184 6.22461 18.2334 5.91455 18.0537L5.09473 17.5811C4.20166 17.0674 3.84473 15.9316 4.28369 14.998L4.86377 13.7646C4.59863 13.4014 4.37402 13.0137 4.19189 12.6035L2.83496 12.4912C1.80615 12.4063 1.00049 11.5313 1.00049 10.5L0.99951 9.55371C0.99951 8.52051 1.80469 7.64453 2.83301 7.55957L4.1875 7.44531C4.2793 7.23633 4.37988 7.03613 4.48926 6.8457C4.59912 6.65429 4.72266 6.46679 4.8584 6.28125L4.27783 5.05176C3.83691 4.11914 4.1914 2.9834 5.08496 2.4668L5.90527 1.99317C6.79785 1.47657 7.95898 1.73438 8.54785 2.58301L9.32519 3.70117C9.76904 3.65137 10.2173 3.65332 10.666 3.70117L11.4414 2.58203C12.0303 1.73242 13.1924 1.47265 14.085 1.98828L14.9048 2.46094C15.7988 2.97656 16.1543 4.11231 15.7153 5.04492L15.1352 6.27734C15.4009 6.6416 15.6255 7.02929 15.8071 7.43847L17.164 7.55077C18.1924 7.63573 18.998 8.51073 18.999 9.54198L18.9995 10.4893C19.0005 11.5205 18.1958 12.3965 17.1675 12.4834L15.812 12.5976C15.7207 12.8066 15.6201 13.0059 15.5093 13.1973C15.3999 13.3867 15.2769 13.5752 15.1411 13.7607L15.7217 14.9902C16.1621 15.9219 15.8081 17.0576 14.915 17.5752L14.0942 18.0498C13.2007 18.5684 12.0405 18.3076 11.4517 17.459L10.6743 16.3408C10.2285 16.3897 9.78028 16.3887 9.3335 16.3418L8.55713 17.4619C8.17334 18.0156 7.54541 18.3184 6.90674 18.3184ZM6.9043 3.22461C6.81934 3.22461 6.73389 3.24609 6.65625 3.29102L5.83545 3.76563C5.61279 3.89454 5.52393 4.17774 5.63428 4.41114L6.41309 6.06153C6.53907 6.32813 6.49707 6.64356 6.30567 6.86817C6.10157 7.10743 5.93262 7.34473 5.78907 7.59376C5.64796 7.83985 5.52393 8.11231 5.42091 8.40333C5.32277 8.68165 5.07081 8.87599 4.77687 8.9004L2.95802 9.05372C2.6963 9.07618 2.49952 9.29005 2.49952 9.55274L2.5005 10.499C2.5005 10.7568 2.70167 10.9756 2.959 10.9971L4.77834 11.1475C5.07229 11.1719 5.32473 11.3662 5.42336 11.6445C5.62209 12.2051 5.92043 12.7207 6.31008 13.1768C6.50197 13.4004 6.54446 13.7168 6.41897 13.9834L5.64114 15.6358C5.53176 15.8692 5.62014 16.1533 5.84378 16.2813L6.66409 16.7549C6.88821 16.8848 7.17825 16.8184 7.32425 16.6074L8.36527 15.1055C8.53275 14.8633 8.82425 14.7363 9.11771 14.7959C9.70609 14.9033 10.3023 14.9043 10.8877 14.7949C11.1773 14.7402 11.4727 14.8613 11.6412 15.1045L12.6831 16.6035C12.8296 16.8135 13.1216 16.8799 13.3438 16.751L14.1641 16.2773C14.3902 16.1465 14.4776 15.8682 14.3653 15.6309L13.5864 13.9805C13.4605 13.7139 13.5025 13.3984 13.6939 13.1738C13.898 12.9336 14.0669 12.6973 14.2095 12.4492L14.21 12.4483C14.3526 12.2012 14.4732 11.9365 14.5786 11.6387C14.6773 11.3604 14.9292 11.166 15.2232 11.1416L17.042 10.9893C17.2984 10.9668 17.4995 10.7481 17.4995 10.4902L17.499 9.54298C17.499 9.28126 17.3018 9.06739 17.0401 9.04493L15.2212 8.89454C14.9273 8.87013 14.6748 8.67579 14.5762 8.39747C14.3784 7.8379 14.0796 7.32227 13.689 6.86524C13.4976 6.64063 13.4551 6.3252 13.5806 6.0586L14.3579 4.40626C14.4678 4.17286 14.3789 3.88868 14.1553 3.75978L13.3355 3.28712C13.1108 3.16017 12.8213 3.2256 12.6743 3.43653L11.6348 4.93653C11.4668 5.17969 11.1758 5.30469 10.8819 5.24708C10.2905 5.1377 9.69435 5.1377 9.11183 5.24708C8.81984 5.29884 8.52638 5.1797 8.35841 4.93751L7.31642 3.43849C7.22023 3.30079 7.06348 3.22461 6.9043 3.22461Z" fill="currentColor"/>';

    // Pinned icon tabs for technical panels — always visible, start dimmed
    this.primaryZone.addTab({
      id: 'terminal',
      label: 'Terminal',
      closable: false,
      element: this.terminalContainer,
      pinned: true,
      icon: iconSvg(codeIcon),
      onActivate: () => this.panels?.terminal?.refit(),
    });
    this.primaryZone.addTab({
      id: 'files',
      label: 'Files',
      closable: false,
      element: fileBrowserContainer,
      pinned: true,
      icon: iconSvg(dataIcon),
    });
    this.primaryZone.addTab({
      id: 'memory',
      label: 'Memory',
      closable: false,
      element: memoryContainer,
      pinned: true,
      icon: iconSvg(settingsIcon),
      onActivate: () => this.panels?.memory?.refresh(),
    });

    // [+] button after pinned tabs — only shows sprinkles
    this.primaryZone.enableAddButton();
    this.primaryZone.enableFullpageButton();

    this.rightEl.appendChild(this.primaryZoneEl);
    layout.appendChild(this.rightEl);

    // Hidden container for scoop iframes
    this.iframeContainer = document.createElement('div');
    this.iframeContainer.id = 'scoop-iframes';
    this.iframeContainer.style.display = 'none';
    layout.appendChild(this.iframeContainer);

    this.root.appendChild(layout);

    // Create panels
    this.panels = {
      chat: new ChatPanel(chatContainer),
      terminal: new TerminalPanel(this.terminalContainer, {
        onClearTerminal: () => {
          this.panels.terminal.clearTerminal();
          this.openTerminal();
        },
      }),
      fileBrowser: new FileBrowserPanel(fileBrowserContainer, {
        onRunCommand: async (command) => {
          await this.runFileBrowserCommand(command);
          this.openTerminal();
        },
      }),
      memory: new MemoryPanel(memoryContainer),
      scoops: new ScoopsPanel(this.scoopsEl, {
        onScoopSelect: (scoop) => {
          this.onScoopSelect?.(scoop);
          // Update thread header name
          this.threadHeaderName.textContent = scoop.assistantLabel;
        },
        onSendMessage: () => {},
        onScoopsChanged: (scoops) => this.updateLogoScoops(scoops),
      }),
    };

    // Wire chat panel model selector to layout's onModelChange
    this.panels.chat.onModelChange = (modelId) => this.onModelChange?.(modelId);

    this.setupVerticalDrag();
    window.addEventListener('resize', () => {});
  }

  // Layout sizes are now handled by CSS flex (no manual sizing needed)

  /** Get the iframe container for the orchestrator */
  getIframeContainer(): HTMLElement {
    return this.iframeContainer;
  }

  private async runFileBrowserCommand(command: string): Promise<void> {
    const result = await this.panels.terminal.runCommand(command);
    if (result.exitCode !== 0 && result.stderr) {
      console.warn('[Layout] File browser command failed:', result.stderr.trim());
    }
  }

  private setupVerticalDrag(): void {
    // The vertical divider between chat and right panel is still draggable
    // but only on desktop (≥1440px). On smaller screens it's hidden.
    if (!this.verticalDivider) return;
    let dragging = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const layoutRect = this.root.querySelector('.layout')?.getBoundingClientRect();
      if (!layoutRect) return;
      const navRailW = 58; // fixed
      const x = e.clientX - layoutRect.left - navRailW;
      const available = layoutRect.width - navRailW;
      const fraction = Math.max(0.3, Math.min(0.7, x / available));
      this.leftEl.style.flex = `${fraction * 100} 0 0`;
      this.rightEl.style.flex = `${(1 - fraction) * 100} 0 0`;
    };

    const onMouseUp = () => {
      dragging = false;
      this.verticalDivider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      this.panels?.terminal?.refit();
    };

    this.verticalDivider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      this.verticalDivider.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // ── Panel Picker ───────────────────────────────────────────────────

  /** Update [+] button enabled state based on available panels. */
  updateAddButtons(): void {
    const closedCount = this.registry.getClosed().length;
    const availableSprinkles = this.getAvailableSprinkles?.() ?? [];
    const openSprinkles = new Set<string>();
    for (const id of this.registry.ids()) {
      if (id.startsWith('sprinkle-') && this.registry.get(id)?.descriptor.zone !== null) {
        openSprinkles.add(id.slice(9));
      }
    }
    const unopenedSprinkles = availableSprinkles.filter((p) => !openSprinkles.has(p.name)).length;
    const hasAvailable = closedCount + unopenedSprinkles > 0;
    this.primaryZone?.setAddButtonEnabled(hasAvailable);
  }

  /** Show the [+] panel picker for a zone. */
  private showPickerForZone(zone: ZoneId, anchor: HTMLElement): void {
    // Collect available sprinkles that are not currently open
    const openSprinkles = new Set<string>();
    for (const id of this.registry.ids()) {
      if (id.startsWith('sprinkle-') && this.registry.get(id)?.descriptor.zone !== null) {
        openSprinkles.add(id.slice(9)); // strip 'sprinkle-' prefix
      }
    }
    const availableSprinkles = (this.getAvailableSprinkles?.() ?? []).filter(
      (p) => !openSprinkles.has(p.name)
    );

    showSprinklePicker(anchor, zone, {
      registry: this.registry,
      callbacks: {
        onSelectPanel: (id, targetZone) => {
          this.openPanelInZone(id, targetZone);
        },
        onSelectSprinkle: (name, targetZone) => {
          this.onOpenSprinkle?.(name, targetZone);
        },
      },
      getAvailableSprinkles: () => availableSprinkles,
    });
  }

  /** Open a closed registry panel in a specific zone. */
  private openPanelInZone(id: string, zone: ZoneId): void {
    const entry = this.registry.get(id);
    if (!entry) return;

    // Unified right panel — always use primaryZone
    const tabZone = this.primaryZone;
    this.registry.setZone(id, zone);
    tabZone.addTab({
      id: entry.descriptor.id,
      label: entry.descriptor.label,
      closable: entry.descriptor.closable,
      element: entry.descriptor.element,
      onActivate: entry.descriptor.onActivate,
    });
    tabZone.activateTab(id);
  }

  // ── Dynamic Sprinkles ────────────────────────────────────────────

  /** Track dynamic sprinkle sections in standalone mode. */
  private dynamicSprinkles = new Map<string, HTMLElement>();

  /** Add a dynamic .shtml sprinkle to the layout. */
  addSprinkle(name: string, title: string, element: HTMLElement, targetZone?: ZoneId): void {
    if (this.isExtension) {
      // Extension mode: add as a new tab via TabZone
      const tabId = `sprinkle-${name}`;

      const container = document.createElement('div');
      container.className = 'tab-content__panel';
      container.appendChild(element);

      this.extensionZone.addTab({
        id: tabId,
        label: title,
        closable: true,
        element: container,
      });
      this.tabContainers.set(tabId, container);
      this.dynamicSprinkles.set(name, container);

      // Auto-switch to the new tab
      this.extensionZone.activateTab(tabId);
    } else {
      // Standalone mode: unified right panel
      const zone = targetZone ?? 'primary';
      const tabZone = this.primaryZone;
      const tabId = `sprinkle-${name}`;

      const container = document.createElement('div');
      container.style.cssText =
        'display: flex; flex-direction: column; min-height: 0; overflow: auto; flex: 1;';
      container.appendChild(element);

      // Register in the panel registry
      this.registry.register({
        id: tabId,
        label: title,
        zone,
        closable: true,
        element: container,
        onClose: () => this.onSprinkleClose?.(name),
      });

      tabZone.addTab({
        id: tabId,
        label: title,
        closable: true,
        element: container,
      });
      this.dynamicSprinkles.set(name, container);

      // Auto-switch to the new tab
      tabZone.activateTab(tabId);
      this.updateAddButtons();
    }
  }

  /** Remove a dynamic .shtml sprinkle from the layout. */
  removeSprinkle(name: string): void {
    if (this.isExtension) {
      const tabId = `sprinkle-${name}`;
      this.extensionZone.removeTab(tabId);
      this.tabContainers.delete(tabId);
      this.dynamicSprinkles.delete(name);
    } else {
      const tabId = `sprinkle-${name}`;
      this.primaryZone.removeTab(tabId);
      this.registry.unregister(tabId);
      this.dynamicSprinkles.delete(name);
      this.updateAddButtons();
    }
  }

  // switchPrimaryTab and switchDrawerTab are now handled by TabZone instances

  // ── Cleanup ─────────────────────────────────────────────────────────

  dispose(): void {
    this.panels.chat.dispose();
    this.panels.terminal.dispose();
    this.panels.fileBrowser.dispose();
    this.panels.memory.dispose();
    this.panels.scoops.dispose();
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }
}
