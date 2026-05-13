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
import { getLeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import { getFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { copyTextToClipboard } from './clipboard.js';
import { computeTrayMenuModel } from './tray-join-url.js';
import { showSyncEnabledDialog } from './sync-dialog.js';
import { getTrayResetter } from '../shell/supplemental-commands/host-command.js';
import { getHiddenTabs, setHiddenTabs, type ExtensionTabId } from './tabbed-ui.js';
import { RailZone } from './rail-zone.js';
import { PanelRegistry } from './panel-registry.js';
import { showSprinklePicker } from './sprinkle-picker.js';
import type { ZoneId } from './panel-types.js';
// ChatMessage import removed — copy chat moved to feedback row
import type { RegisteredScoop, ScoopTabState, ThinkingLevel } from '../scoops/types.js';

export interface LayoutPanels {
  chat: ChatPanel;
  terminal: TerminalPanel;
  fileBrowser: FileBrowserPanel;
  memory: MemoryPanel;
  scoops: ScoopsPanel;
}

type TabId = ExtensionTabId | string;

/**
 * Default rail icon used for any sprinkle-backed panel that doesn't
 * supply its own. Lucide `Sparkles` (16×16). When sprinkles want a
 * specific glyph, future work can wire up a `data-sprinkle-icon`
 * attribute on the .shtml `<html>` element and surface that here.
 */
const SPRINKLE_DEFAULT_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path><path d="M20 3v4"></path><path d="M22 5h-4"></path><path d="M4 17v2"></path><path d="M5 18H3"></path></svg>';

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

  // Right side — always-visible vertical icon rail + collapsible
  // content panel beside it. Replaces the old horizontal mini-tabs.
  private rightContentEl!: HTMLElement;
  private railEl!: HTMLElement;
  private primaryRail!: RailZone;
  /** Cached layout root for fullpage class toggling. */
  private layoutRootEl!: HTMLElement;

  // Tabbed-layout legacy state — kept around so `setActiveTab` /
  // `getActiveTab` callers (Electron overlay routing, deep links)
  // continue to work even though the actual tab bar is gone.
  private tabContainers = new Map<TabId, HTMLElement>();
  private activeTab: TabId = 'chat';
  /** Pre-created containers for debug tabs (terminal, memory) — always created, rail items added on demand. */
  private debugTabContainers: { terminal: HTMLElement; memory: HTMLElement } | null = null;
  /**
   * Cached element handle for the Memory rail container — needed so
   * `setDebugTabs(true)` can re-mount the rail item without losing
   * the existing MemoryPanel mount.
   */
  private memoryContainer!: HTMLElement;
  /** Cached SVGs reused when re-mounting pinned rail items. */
  private terminalIconSvg = '';
  private memoryIconSvg = '';

  // Scoop switcher (extension mode)
  private scoopSwitcher: ScoopSwitcher | null = null;
  private scoopSwitcherEl: HTMLElement | null = null;

  // Popout button + detached-active overlay (extension mode)
  private popoutButtonEl?: HTMLButtonElement;
  private popoutClickHandler?: () => void;
  private detachedActiveOverlayEl?: HTMLDivElement;

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
  /** Fired when the user cycles the brain icon in the chat panel. */
  public onThinkingLevelChange?: (level: ThinkingLevel) => void;
  /** Re-populate the model dropdown (call after provider login/logout). */
  public refreshModels?: () => void;
  /**
   * Fired after `refreshModels` finishes — i.e. whenever provider accounts
   * change and the chat panel's active model may have shifted. main.ts
   * uses this hook to re-sync the thinking-level brain icon to the new
   * model's reasoning support (a model swap from a non-reasoning to a
   * reasoning model has to un-hide the icon).
   */
  public onModelsRefreshed?: () => void;
  public onScoopSelect?: (scoop: RegisteredScoop) => void;
  public onClearChat?: () => Promise<void>;
  public onClearFilesystem?: () => Promise<void>;
  public onSprinkleClose?: (name: string) => void;
  /**
   * Fired when the user clicks a sprinkle's rail icon. Lets the
   * SprinkleManager promote attention-mode entries (which the user
   * has now actually engaged with) into persistently-open ones.
   */
  public onSprinkleActivate?: (name: string) => void;

  /** Callback to get available sprinkles for the [+] picker. */
  public getAvailableSprinkles?: () => Array<{ name: string; title: string }>;
  /** Callback to open a sprinkle by name. */
  public onOpenSprinkle?: (name: string, zone?: ZoneId) => Promise<void>;
  /**
   * Resolver for sprinkle icon specs → SVG/HTML markup.
   * `addSprinkle()` calls this when a sprinkle declares an icon
   * (Lucide name, VFS path, inline SVG, or data URL). Returns null
   * to fall back to the default Sparkles glyph.
   */
  public resolveSprinkleIcon?: (spec: string | undefined) => Promise<string | null>;

  // Layout uses CSS flex — no manual width fractions needed

  constructor(root: HTMLElement, isExtension = false) {
    this.root = root;
    this.isExtension = isExtension;
    // Single layout path — chat on the left, rail on the right.
    // The legacy tabbed layout (Chrome extension + Electron overlay)
    // has been retired; both modes now share the standalone rail UX.
    this.buildSplitLayout();
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

  /**
   * Show or hide the "Pop out" header button. The click handler is
   * provided by setPopoutClickHandler — Layout itself does not know
   * about the SW envelope shape.
   */
  setShowPopoutButton(show: boolean): void {
    if (!show) {
      this.popoutButtonEl?.remove();
      this.popoutButtonEl = undefined;
      return;
    }
    if (this.popoutButtonEl) return;

    // In standalone mode, Layout has a top-of-window `.header` div.
    // In extension mode, that header is omitted (the side panel is
    // narrower and uses `.thread-header` as its primary chrome).
    // Put the button wherever the user's eye is already looking.
    const containerEl = (
      this.isExtension
        ? this.root.querySelector('.thread-header')
        : this.root.querySelector('.header')
    ) as HTMLElement | null;
    if (!containerEl) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header__popout-btn';
    btn.title = 'Open in a new tab';
    btn.textContent = '⤴'; // simple glyph; CSS may replace with icon
    btn.setAttribute('aria-label', 'Pop out to a new tab');
    btn.addEventListener('click', () => {
      btn.disabled = true; // prevent double-fire
      this.popoutClickHandler?.();
    });
    containerEl.appendChild(btn);
    this.popoutButtonEl = btn;
  }

  /** Wire the popout button click handler. Replaces any previous handler. */
  setPopoutClickHandler(handler: () => void): void {
    this.popoutClickHandler = handler;
  }

  /**
   * Render a non-dismissible full-Layout overlay indicating that a
   * detached tab has taken over. The only escape is closing this
   * window via the overlay's close button.
   */
  showDetachedActiveOverlay(): void {
    if (this.detachedActiveOverlayEl) return;
    const overlay = document.createElement('div');
    overlay.className = 'layout-detached-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');

    const msg = document.createElement('p');
    msg.textContent = 'Detached in another tab. Close this window to continue.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layout-detached-overlay-close';
    btn.textContent = 'Close this window';
    btn.addEventListener('click', () => {
      window.close();
    });

    overlay.appendChild(msg);
    overlay.appendChild(btn);
    this.root.appendChild(overlay);
    this.detachedActiveOverlayEl = overlay;
  }

  /**
   * Activate a built-in panel by tab id. Held over from the legacy
   * tabbed layout — callers (Electron overlay routing, deep-linking)
   * still pass `'chat' | 'terminal' | 'files' | 'memory' | 'sprinkle-*'`
   * ids. In the unified rail layout `chat` is the default left
   * content and the rest are rail items, so we collapse the rail for
   * `chat` and activate the matching rail item otherwise.
   */
  setActiveTab(id: TabId): void {
    this.activeTab = id;
    if (id === 'chat') {
      this.primaryRail?.collapse?.();
      return;
    }
    this.primaryRail?.activateItem(id);
  }

  getActiveTab(): TabId {
    return this.activeTab;
  }

  /** Check if the terminal panel is currently open in a zone. */
  isTerminalOpen(): boolean {
    return this.primaryRail.getActiveItemId() === 'terminal';
  }

  /** Toggle the agent processing indicator on the thread header. */
  setAgentProcessing(busy: boolean): void {
    this.threadHeaderEl?.classList.toggle('thread-header--processing', busy);
  }

  /** Open the terminal panel (rail-driven). */
  openTerminal(): void {
    // Don't steal focus from an active sprinkle.
    const active = this.primaryRail.getActiveItemId();
    if (active && active.startsWith('sprinkle-')) return;
    this.primaryRail.activateItem('terminal');
  }

  /**
   * Show or hide the Terminal + Memory rail items.
   *
   * The `debug` shell command used to flip the visibility of these
   * tabs in the legacy tabbed extension layout. With the unified rail
   * the items are addable/removable like sprinkles, so we mirror the
   * same on/off semantics by adding or removing them from the rail.
   * Files stays pinned in the rail in either mode.
   */
  setDebugTabs(show: boolean): void {
    setHiddenTabs(show ? [] : ['terminal', 'memory']);
    if (!this.primaryRail) return;
    if (show) {
      // Re-add only if missing — addItem is a no-op when the id
      // already exists, so this is safe to call repeatedly.
      this.ensurePinnedRailItem('terminal');
      this.ensurePinnedRailItem('memory');
    } else {
      this.primaryRail.removeItem('terminal');
      this.primaryRail.removeItem('memory');
    }
  }

  /**
   * Re-mount a previously-removed pinned rail item without losing
   * the cached panel container. Called from `setDebugTabs(true)` to
   * restore terminal/memory after the user enabled debug mode.
   */
  private ensurePinnedRailItem(id: 'terminal' | 'memory'): void {
    if (!this.primaryRail || this.primaryRail.hasItem(id)) return;
    if (id === 'terminal') {
      this.primaryRail.addItem({
        id: 'terminal',
        label: 'Terminal',
        icon: this.terminalIconSvg,
        element: this.terminalContainer,
        position: 'bottom',
        onActivate: () => this.panels?.terminal?.refit(),
      });
    } else {
      this.primaryRail.addItem({
        id: 'memory',
        label: 'Memory',
        icon: this.memoryIconSvg,
        element: this.memoryContainer,
        position: 'bottom',
        onActivate: () => this.panels?.memory?.refresh(),
      });
    }
  }

  // ── Shared: Header ──────────────────────────────────────────────────

  /**
   * Auto-select a model on boot and wire `refreshModels` for downstream
   * callers. Runs in both modes — the extension drops the visible
   * header but still needs the model bookkeeping.
   */
  private initModelSelection(): void {
    const ensureModelSelected = () => {
      const groups = getAllAvailableModels();
      // Validate that the stored selection still resolves against
      // a configured account. Without this, deleting the active
      // provider through Settings leaves a dangling `selected-model`
      // (e.g. `bedrock-camp:…`) that the header dropdown silently
      // ignores while message-send continues routing to the removed
      // provider — surfacing as "No API key configured for provider".
      const raw = localStorage.getItem('selected-model') ?? '';
      const sep = raw.indexOf(':');
      const storedProvider = sep > 0 ? raw.slice(0, sep) : '';
      const storedModelId = sep > 0 ? raw.slice(sep + 1) : raw;
      const stillResolves =
        !!storedProvider &&
        groups.some(
          (g) => g.providerId === storedProvider && g.models.some((m) => m.id === storedModelId)
        );
      if (raw && stillResolves) return;
      // Re-pick a default from the surviving accounts.
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
      // No accounts at all → leave the selection empty so the chat
      // header surfaces the "no provider configured" state instead
      // of silently routing to a stale one.
      if (raw && groups.length === 0) {
        localStorage.removeItem('selected-model');
      }
    };
    ensureModelSelected();
    this.refreshModels = () => {
      ensureModelSelected();
      this.panels?.chat?.refreshModelSelector();
      this.refreshAvatar();
      // Notify main.ts so it can re-resolve the active model for the brain
      // icon. Done last so the chat panel has already re-rendered when the
      // hook fires.
      this.onModelsRefreshed?.();
    };
  }

  /** Construct the scoop switcher dropdown (used in extension mode). */
  private buildScoopSwitcher(): HTMLElement {
    this.scoopSwitcherEl = document.createElement('div');
    this.scoopSwitcherEl.className = 'scoop-switcher';
    this.scoopSwitcher = new ScoopSwitcher(this.scoopSwitcherEl, {
      onScoopSelect: (scoop) => this.onScoopSelect?.(scoop),
      onDeleteScoop: (jid) => {
        this.panels?.scoops?.deleteScoop?.(jid);
      },
    });
    return this.scoopSwitcherEl;
  }

  private buildHeader(parent: HTMLElement): void {
    this.initModelSelection();
    if (this.isExtension) {
      // Extension mode: no top-of-panel grey bar at all. The chrome
      // toolbar icon carries the brand, the scoop-switcher migrates
      // into the thread header (next to the scoop name), and the
      // user avatar drops into the rail's top slot. See
      // `buildSplitLayout` for the DOM wiring.
      return;
    }

    const header = document.createElement('div');
    header.className = 'header';

    const row = document.createElement('div');
    row.className = 'header__row';

    const brand = document.createElement('div');
    brand.className = 'header__brand';

    {
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

    // Wordmark — only reachable in standalone since extension
    // returned early.
    const title = document.createElement('div');
    title.className = 'header__title';
    title.textContent = 'slicc';
    brand.appendChild(title);

    row.appendChild(brand);

    const spacer = document.createElement('div');
    spacer.className = 'header__spacer';
    row.appendChild(spacer);

    // Avatar (standalone only — extension routes the avatar into the rail).
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

  /**
   * Render the Tray block of the avatar popover.
   *
   * Three shapes:
   *   - Leader with `state === 'leader'` and a session: a primary "Copy
   *     tray join URL" item plus a small status caption.
   *   - Leader connecting / reconnecting / error: a disabled item showing
   *     why no URL is available yet.
   *   - Follower with state !== 'inactive': a status caption showing the
   *     follower connection state.
   *
   * Returns nothing when this runtime is neither a leader nor a follower —
   * keeps the popover compact for users that don't use trays.
   */
  private appendTrayMenu(popover: HTMLElement): void {
    const model = computeTrayMenuModel(
      getLeaderTrayRuntimeStatus(),
      getFollowerTrayRuntimeStatus()
    );
    if (model.kind === 'hidden') return;

    const sep = document.createElement('div');
    sep.className = 'avatar-popover__separator';
    popover.appendChild(sep);

    if (model.kind === 'leader-copy') {
      const enableBtn = document.createElement('button');
      enableBtn.className = 'avatar-popover__item';
      enableBtn.textContent = model.label;
      enableBtn.addEventListener('click', async () => {
        popover.remove();
        const copied = await copyTextToClipboard(model.joinUrl);
        showSyncEnabledDialog({
          joinUrl: model.joinUrl,
          copied,
          onReset: getTrayResetter(),
        });
      });
      popover.appendChild(enableBtn);
      const caption = document.createElement('div');
      caption.className = 'avatar-popover__caption';
      caption.textContent = model.caption;
      popover.appendChild(caption);
    } else if (model.kind === 'leader-pending') {
      const item = document.createElement('button');
      item.className = 'avatar-popover__item';
      item.textContent = model.label;
      item.disabled = true;
      item.style.opacity = '0.6';
      item.style.cursor = 'not-allowed';
      popover.appendChild(item);
      const caption = document.createElement('div');
      caption.className = 'avatar-popover__caption';
      caption.textContent = model.caption;
      popover.appendChild(caption);
    } else {
      const item = document.createElement('div');
      item.className = 'avatar-popover__item';
      item.textContent = model.label;
      item.style.cursor = 'default';
      popover.appendChild(item);
      const caption = document.createElement('div');
      caption.className = 'avatar-popover__caption';
      caption.textContent = model.caption;
      popover.appendChild(caption);
    }
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

    // Tray section — surface the leader's join URL (only visible
    // when this runtime owns a tray) or the follower's connection
    // state, so first-time users can find the URL without dropping
    // into the shell.
    this.appendTrayMenu(popover);

    // Clear all accounts (danger)
    if (accounts.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'avatar-popover__separator';
      popover.appendChild(sep);

      const clearAllBtn = document.createElement('button');
      clearAllBtn.className = 'avatar-popover__item avatar-popover__item--danger';
      clearAllBtn.textContent = 'Clear all accounts';
      clearAllBtn.addEventListener('click', async () => {
        await clearAllSettings();
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
      if (!getApiKey()) await clearAllSettings();
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

  // ── Split Layout (single layout path) ───────────────────────────────
  // The legacy tabbed layout (Chrome extension + Electron overlay) and
  // its supporting helpers (`showExtensionPicker`, `switchTab`,
  // `extensionZone`, dual-zone TabZone wiring) have been retired.
  // Both modes now mount the same split layout below — the only
  // mode-specific tweaks live in `buildSplitLayout` / `buildHeader`.
  // ── Standalone: Split Layout ────────────────────────────────────────

  private buildSplitLayout(): void {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    this.buildHeader(this.root);

    // Main layout
    const layout = document.createElement('div');
    layout.className = 'layout';
    this.layoutRootEl = layout;

    // Scoops panel (leftmost — icon rail, 58px fixed). In extension
    // mode the rail is hidden (the side panel is too narrow for both
    // a scoop rail and the right rail) — the header's scoop-switcher
    // dropdown carries the active-scoop affordance instead. The
    // ScoopsPanel itself stays mounted off-screen so its
    // `onScoopsChanged` callback (which drives `updateLogoScoops` and
    // therefore the chrome.action icon) keeps firing.
    this.scoopsEl = document.createElement('div');
    this.scoopsEl.className = 'layout__scoops';
    if (this.isExtension) this.scoopsEl.style.display = 'none';
    layout.appendChild(this.scoopsEl);

    // Left panel (chat) — includes thread header
    this.leftEl = document.createElement('div');
    this.leftEl.className = 'layout__left';

    // Thread header (sub-header with scoop name)
    this.threadHeaderEl = document.createElement('div');
    this.threadHeaderEl.className = 'thread-header';
    if (this.isExtension) this.threadHeaderEl.classList.add('thread-header--with-switcher');
    const threadHeaderTitle = document.createElement('div');
    threadHeaderTitle.className = 'thread-header__title';

    if (this.isExtension) {
      // Extension mode: the scoop-switcher dropdown replaces the
      // static "sliccy" label — the dropdown trigger already shows
      // the active scoop's name (e.g. "cone") and lets the user
      // switch scoops directly from the thread header.
      const switcher = this.buildScoopSwitcher();
      threadHeaderTitle.appendChild(switcher);
      // Keep `threadHeaderName` defined so callers that mutate it
      // (scoop selection in standalone) don't blow up — it's a
      // detached node in extension mode.
      this.threadHeaderName = document.createElement('span');
    } else {
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
    }
    this.threadHeaderEl.appendChild(threadHeaderTitle);

    // Clear chat button — the rail now owns panel toggling, so the
    // chat header drops the panel-toggle button entirely.
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
    this.threadHeaderEl.appendChild(threadActions);

    this.leftEl.appendChild(this.threadHeaderEl);

    // Chat container
    const chatContainer = document.createElement('div');
    chatContainer.style.cssText = 'display: flex; flex-direction: column; flex: 1; min-height: 0;';
    this.leftEl.appendChild(chatContainer);

    layout.appendChild(this.leftEl);

    // Vertical divider — between chat and the rail-content panel.
    // Hidden when the panel is collapsed.
    this.verticalDivider = document.createElement('div');
    this.verticalDivider.className = 'layout__divider layout__divider--vertical';
    layout.appendChild(this.verticalDivider);

    // Rail content panel (collapsible — hosts the active item's UI).
    this.rightContentEl = document.createElement('div');
    this.rightContentEl.className = 'rail-content rail-content--collapsed';
    layout.appendChild(this.rightContentEl);

    // Vertical icon rail (always visible, far right edge).
    this.railEl = document.createElement('div');
    this.railEl.setAttribute('aria-label', 'Side panel rail');
    layout.appendChild(this.railEl);

    // Backwards-compat alias — some callers still read `rightEl` for
    // the old `.layout__right` container. Point it at the content
    // panel so existing toggleable-panel logic continues to work.
    this.rightEl = this.rightContentEl;

    this.primaryRail = new RailZone(
      this.railEl,
      this.rightContentEl,
      'primary',
      {
        onItemActivate: (id) => {
          if (id === 'terminal') this.panels?.terminal?.refit();
          if (id === 'memory') this.panels?.memory?.refresh();
          if (id.startsWith('sprinkle-')) {
            this.onSprinkleActivate?.(id.slice(9));
          }
        },
        onItemClose: (id) => {
          const name = id.startsWith('sprinkle-') ? id.slice(9) : id;
          this.onSprinkleClose?.(name);
        },
        onAddClick: () => this.showPickerForZone('primary', this.railEl),
        onFullpageToggle: (isFullpage) => {
          this.layoutRootEl.classList.toggle('layout--rail-fullpage', isFullpage);
        },
      },
      {
        // Extension mode: the side panel is too narrow to host both
        // chat and a second column, so any rail activation takes
        // over the full panel width. Standalone keeps the legacy
        // expand-beside-chat behaviour.
        defaultFullpage: this.isExtension,
      }
    );

    if (this.isExtension) {
      // Extension mode: the user avatar lives at the top of the rail
      // (above sprinkles) since the grey header is gone. It opens the
      // same account popover the standalone header avatar does.
      this.avatarEl = this.buildUserAvatar();
      this.avatarEl.classList.add('rail__avatar');
      this.primaryRail.mountTopWidget(this.avatarEl);
    }

    // Dev panel containers
    this.terminalContainer = document.createElement('div');
    this.terminalContainer.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';

    const fileBrowserContainer = document.createElement('div');
    fileBrowserContainer.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';

    this.memoryContainer = document.createElement('div');
    this.memoryContainer.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; flex: 1;';

    // 16×16 lucide icons for built-in rail tools.
    this.terminalIconSvg =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
    const folderIcon =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>';
    // Memory → BrainCircuit (lucide). Replaces the old gear icon.
    this.memoryIconSvg =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path><path d="M9 13a4.5 4.5 0 0 0 3-4"></path><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"></path><path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path><path d="M6 18a4 4 0 0 1-1.967-.516"></path><path d="M12 13h4"></path><path d="M12 18h6a2 2 0 0 1 2 2v1"></path><path d="M12 8h8"></path><path d="M16 8V5a2 2 0 0 1 2-2"></path><circle cx="16" cy="13" r=".5"></circle><circle cx="18" cy="3" r=".5"></circle><circle cx="20" cy="21" r=".5"></circle><circle cx="20" cy="8" r=".5"></circle></svg>';

    // In extension mode the panel is too narrow to host the legacy
    // debug surfaces by default — terminal + memory live behind the
    // shell's `debug` toggle. Files remains pinned in either mode.
    const showDebugByDefault = !this.isExtension || !getHiddenTabs().has('terminal');

    // Pinned bottom-section tools — always present, mounted from boot.
    if (showDebugByDefault) {
      this.primaryRail.addItem({
        id: 'terminal',
        label: 'Terminal',
        icon: this.terminalIconSvg,
        element: this.terminalContainer,
        position: 'bottom',
        onActivate: () => this.panels?.terminal?.refit(),
      });
    }
    this.primaryRail.addItem({
      id: 'files',
      label: 'Files',
      icon: folderIcon,
      element: fileBrowserContainer,
      position: 'bottom',
    });
    if (showDebugByDefault) {
      this.primaryRail.addItem({
        id: 'memory',
        label: 'Memory',
        icon: this.memoryIconSvg,
        element: this.memoryContainer,
        position: 'bottom',
        onActivate: () => this.panels?.memory?.refresh(),
      });
    }

    // [+] only appears when sprinkles overflow the available rail height.
    this.primaryRail.enableAddButton();

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
      memory: new MemoryPanel(this.memoryContainer),
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
    this.panels.chat.onThinkingLevelChange = (level) => this.onThinkingLevelChange?.(level);

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
    // The rail decides [+] visibility from its own overflow logic —
    // the legacy tabbed layout used to compute it from the registry,
    // but with a single layout path the rail handles it. Keep the
    // method as a no-op so existing callers (sprinkle add/remove) can
    // call it without branching.
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

  /** Open a closed registry panel via the rail. */
  private openPanelInZone(id: string, zone: ZoneId): void {
    const entry = this.registry.get(id);
    if (!entry) return;

    this.registry.setZone(id, zone);
    // Sprinkle-backed registry panels share the same generic
    // sparkles icon as dynamic sprinkles — they all live in the
    // rail's top section.
    this.primaryRail.addItem({
      id: entry.descriptor.id,
      label: entry.descriptor.label,
      icon: SPRINKLE_DEFAULT_ICON,
      element: entry.descriptor.element,
      position: 'top',
      closable: entry.descriptor.closable,
      onActivate: entry.descriptor.onActivate,
    });
    this.primaryRail.activateItem(id);
  }

  // ── Dynamic Sprinkles ────────────────────────────────────────────

  /** Track dynamic sprinkle sections in standalone mode. */
  private dynamicSprinkles = new Map<string, HTMLElement>();

  /** Add a dynamic .shtml sprinkle to the rail. */
  addSprinkle(
    name: string,
    title: string,
    element: HTMLElement,
    targetZone?: ZoneId,
    options?: { attention?: boolean; icon?: string }
  ): void {
    const zone = targetZone ?? 'primary';
    const tabId = `sprinkle-${name}`;

    const container = document.createElement('div');
    container.style.cssText =
      'display: flex; flex-direction: column; min-height: 0; overflow: auto; flex: 1;';
    container.appendChild(element);

    this.registry.register({
      id: tabId,
      label: title,
      zone,
      closable: true,
      element: container,
      onClose: () => this.onSprinkleClose?.(name),
    });

    this.primaryRail.addItem({
      id: tabId,
      label: title,
      icon: SPRINKLE_DEFAULT_ICON,
      element: container,
      position: 'top',
      closable: true,
    });
    this.dynamicSprinkles.set(name, container);

    // Resolve the per-sprinkle icon asynchronously and swap it in
    // when ready. We add the rail item with the default icon
    // first so the entry is clickable immediately, then upgrade
    // the SVG once the resolver responds.
    if (options?.icon && this.resolveSprinkleIcon) {
      this.resolveSprinkleIcon(options.icon)
        .then((html) => {
          if (html) this.primaryRail.setItemIcon(tabId, html);
        })
        .catch(() => {
          /* fall back to default — already rendered */
        });
    }

    if (options?.attention) {
      // Auto-installed sprinkle in extension mode: leave the panel
      // collapsed so we don't cover chat mid-onboarding. Pulse the
      // rail icon so the user notices it and clicks when ready.
      // The pulse class self-clears the first time the user
      // activates the item.
      this.primaryRail.markItemAttention(tabId);
    } else {
      // Auto-activate the new sprinkle.
      this.primaryRail.activateItem(tabId);
    }
    this.updateAddButtons();
  }

  /** Remove a dynamic .shtml sprinkle from the rail. */
  removeSprinkle(name: string): void {
    const tabId = `sprinkle-${name}`;
    this.primaryRail.removeItem(tabId);
    this.registry.unregister(tabId);
    this.dynamicSprinkles.delete(name);
    this.updateAddButtons();
  }

  // The legacy switchPrimaryTab/switchDrawerTab helpers were removed
  // when the tabbed layout was retired — see `setActiveTab` for the
  // current API surface.

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
