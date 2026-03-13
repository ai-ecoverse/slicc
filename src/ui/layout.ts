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
  getSelectedProvider,
  getProviderModels,
  getSelectedModelId,
  setSelectedModelId,
  showProviderSettings,
  getAllAvailableModels,
  getProviderConfig,
} from './provider-settings.js';
import { EXTENSION_TAB_SPECS, type ExtensionTabId } from './tabbed-ui.js';
import { TabZone } from './tab-zone.js';
import { PanelRegistry } from './panel-registry.js';
import { showSprinklePicker } from './sprinkle-picker.js';
import type { ZoneId } from './panel-types.js';
import type { ChatMessage } from './types.js';
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
  private scoopsDivider!: HTMLElement;
  private verticalDivider!: HTMLElement;
  private horizontalDivider!: HTMLElement;
  private terminalContainer!: HTMLElement;
  private iframeContainer!: HTMLElement;

  // Primary zone (top of right column — Terminal + sprinkle tabs)
  private primaryZoneEl!: HTMLElement;
  private primaryZone!: TabZone;

  // Drawer zone (bottom of right column — Files + Memory)
  private drawerZoneEl!: HTMLElement;
  private drawerZone!: TabZone;

  private drawerHeightFraction = 0.35;

  // Tabbed-layout elements (extension only)
  private tabContainers = new Map<TabId, HTMLElement>();
  private activeTab: TabId = 'chat';
  private actionsEl!: HTMLElement;

  // Scoop switcher (extension mode)
  private scoopSwitcher: ScoopSwitcher | null = null;
  private scoopSwitcherEl: HTMLElement | null = null;

  // Button references for tab-sensitive visibility
  private clearChatBtn!: HTMLButtonElement;
  private copyChatBtn!: HTMLButtonElement;
  private clearTermBtn!: HTMLButtonElement;
  private clearFsBtn!: HTMLButtonElement;

  // Dynamic logo
  private logoSvg: SVGSVGElement | null = null;
  private logoScoopCount = -1; // -1 = initial load, skip animation

  public panels!: LayoutPanels;
  public readonly registry = new PanelRegistry();
  public onModelChange?: (model: string) => void;
  public onScoopSelect?: (scoop: RegisteredScoop) => void;
  public onClearChat?: () => Promise<void>;
  public onClearFilesystem?: () => Promise<void>;
  public onSprinkleClose?: (name: string) => void;

  /** Callback to get available sprinkles for the [+] picker. */
  public getAvailableSprinkles?: () => Array<{ name: string; title: string }>;
  /** Callback to open a sprinkle by name. */
  public onOpenSprinkle?: (name: string, zone?: ZoneId) => Promise<void>;

  private scoopsWidth = 0.15;
  private leftWidth = 0.45;

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
  setScoopSwitcherOrchestrator?(orchestrator: import('../scoops/orchestrator.js').Orchestrator): void {
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

  /** Check if the terminal panel is currently open in a zone. */
  isTerminalOpen(): boolean {
    return true; // always present in drawer
  }

  /** Activate the terminal tab in the drawer. */
  openTerminal(): void {
    if (this.isExtension) return;
    this.drawerZone.activateTab('terminal');
  }

  // ── Shared: Header ──────────────────────────────────────────────────

  private buildHeader(parent: HTMLElement): void {
    const header = document.createElement('div');
    header.className = 'header';

    // ── Provider indicator (shared, created once) ─────────────────
    const providerIndicator = document.createElement('span');
    providerIndicator.style.cssText =
      'font-size: 11px; color: var(--s2-content-tertiary); cursor: pointer; padding: 2px 8px; ' +
      'background: transparent; border-radius: var(--s2-radius-pill); border: none; ' +
      'transition: color 130ms ease, background 130ms ease;';
    providerIndicator.dataset.tooltip = 'Change provider';
    providerIndicator.addEventListener('click', async () => {
      await showProviderSettings();
      location.reload();
    });

    // ── Model picker (shared, created once) ───────────────────────
    const modelSelect = document.createElement('select');
    modelSelect.style.cssText = this.isExtension
      ? 'background: var(--s2-bg-sunken); color: var(--s2-content-default); border: 1px solid var(--s2-border-subtle); border-radius: var(--s2-radius-default); ' +
        'padding: 3px 6px; font-size: 11px; cursor: pointer; outline: none; max-width: 140px; font-family: var(--s2-font-family);'
      : 'background: var(--s2-bg-sunken); color: var(--s2-content-default); border: 1px solid var(--s2-border-subtle); border-radius: var(--s2-radius-default); ' +
        'padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; margin-left: 8px; font-family: var(--s2-font-family);';

    const sortModels = (models: { id: string; name: string; reasoning?: boolean }[]) => {
      return [...models].sort((a, b) => {
        if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    };

    const populateModels = () => {
      const groups = getAllAvailableModels();
      const currentModelId = getSelectedModelId();
      const currentProvider = getSelectedProvider();
      providerIndicator.textContent = getProviderConfig(currentProvider).name;
      while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);

      if (groups.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models';
        modelSelect.appendChild(opt);
        return;
      }

      const useGroups = groups.length > 1;
      for (const group of groups) {
        const sorted = sortModels(group.models);
        if (useGroups) {
          const optgroup = document.createElement('optgroup');
          optgroup.label = group.providerName;
          for (const model of sorted) {
            const opt = document.createElement('option');
            opt.value = `${group.providerId}:${model.id}`;
            opt.textContent = model.name;
            if (model.id === currentModelId && group.providerId === currentProvider) opt.selected = true;
            optgroup.appendChild(opt);
          }
          modelSelect.appendChild(optgroup);
        } else {
          for (const model of sorted) {
            const opt = document.createElement('option');
            opt.value = `${group.providerId}:${model.id}`;
            opt.textContent = model.name;
            if (model.id === currentModelId) opt.selected = true;
            modelSelect.appendChild(opt);
          }
        }
      }

      if (modelSelect.selectedIndex === -1 && modelSelect.options.length > 0) {
        modelSelect.selectedIndex = 0;
        if (modelSelect.value) setSelectedModelId(modelSelect.value);
      }
    };
    populateModels();
    modelSelect.addEventListener('change', () => {
      setSelectedModelId(modelSelect.value);
      // Update provider indicator
      const newProvider = getSelectedProvider();
      providerIndicator.textContent = getProviderConfig(newProvider).name;
      this.onModelChange?.(modelSelect.value);
    });

    if (this.isExtension) {
      // ── Extension: single compact row ───────────────────────────
      // slicc | scoop dropdown | model dropdown | icons
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; width: 100%; gap: 6px;';

      const logo = this.sliccLogo(22);
      row.appendChild(logo);

      const title = document.createElement('div');
      title.className = 'header__title';
      title.textContent = 'slicc';
      row.appendChild(title);

      this.scoopSwitcherEl = document.createElement('div');
      this.scoopSwitcherEl.className = 'scoop-switcher';
      this.scoopSwitcher = new ScoopSwitcher(this.scoopSwitcherEl, {
        onScoopSelect: (scoop) => this.onScoopSelect?.(scoop),
        onCreateScoop: (name) => { this.panels?.scoops?.createScoop(name); },
        onDeleteScoop: (jid) => { this.panels?.scoops?.deleteScoop?.(jid); },
      });
      row.appendChild(this.scoopSwitcherEl);

      // Model dropdown button
      const modelDD = document.createElement('div');
      modelDD.style.cssText = 'position: relative;';
      const modelBtn = document.createElement('button');
      modelBtn.style.cssText =
        'display: flex; align-items: center; gap: 4px; padding: 3px 8px; ' +
        'border: 1px solid var(--s2-border-subtle); border-radius: var(--s2-radius-default); ' +
        'background: var(--s2-bg-sunken); color: var(--s2-content-secondary); ' +
        'font-size: 11px; cursor: pointer; white-space: nowrap; font-family: var(--s2-font-family); ' +
        'transition: color 130ms ease, background 130ms ease;';
      modelBtn.textContent = 'Model \u25BE';
      let modelMenuOpen = false;

      const renderModelMenu = () => {
        const old = modelDD.querySelector('.model-dd-menu');
        if (old) old.remove();
        if (!modelMenuOpen) return;

        const menu = document.createElement('div');
        menu.className = 'model-dd-menu';
        menu.style.cssText =
          'position: absolute; top: 100%; left: 0; margin-top: 4px; min-width: 200px; max-height: 300px; ' +
          'overflow-y: auto; background: var(--s2-bg-layer-2); border: 1px solid var(--s2-border-default); ' +
          'border-radius: var(--s2-radius-l); padding: 4px 0; box-shadow: var(--s2-shadow-elevated); z-index: 1000;';

        const groups = getAllAvailableModels();
        const currentModelId = getSelectedModelId();
        const currentProvider = getSelectedProvider();
        const useGroupHeaders = groups.length > 1;

        for (const group of groups) {
          if (useGroupHeaders) {
            const groupHeader = document.createElement('div');
            groupHeader.style.cssText =
              'padding: 4px 12px; font-size: 10px; color: var(--s2-content-secondary); text-transform: uppercase; ' +
              'letter-spacing: 0.5px; font-weight: 600;';
            if (menu.children.length > 0) {
              groupHeader.style.borderTop = '1px solid var(--s2-border-default)';
              groupHeader.style.marginTop = '4px';
              groupHeader.style.paddingTop = '8px';
            }
            groupHeader.textContent = group.providerName;
            menu.appendChild(groupHeader);
          }

          const sorted = sortModels(group.models);
          for (const model of sorted) {
            const isSelected = model.id === currentModelId && group.providerId === currentProvider;
            const item = document.createElement('div');
            item.style.cssText =
              'padding: 6px 12px; cursor: pointer; font-size: 12px; color: var(--s2-content-default); ' +
              'display: flex; align-items: center; gap: 6px; border-radius: var(--s2-radius-s); ' +
              'margin: 0 4px; transition: background 130ms ease;';
            if (isSelected) {
              item.style.color = 'var(--slicc-cone)';
              item.style.fontWeight = '700';
            }
            item.addEventListener('mouseenter', () => { item.style.background = 'var(--s2-bg-elevated)'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });

            const check = document.createElement('span');
            check.style.cssText = 'width: 14px; text-align: center; font-size: 10px;';
            check.textContent = isSelected ? '\u2713' : '';
            item.appendChild(check);

            const label = document.createElement('span');
            label.textContent = model.name;
            item.appendChild(label);

            item.addEventListener('click', () => {
              setSelectedModelId(`${group.providerId}:${model.id}`);
              this.onModelChange?.(`${group.providerId}:${model.id}`);
              modelMenuOpen = false;
              renderModelMenu();
            });
            menu.appendChild(item);
          }
        }

        modelDD.appendChild(menu);
      };

      modelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modelMenuOpen = !modelMenuOpen;
        renderModelMenu();
      });
      document.addEventListener('click', () => {
        if (modelMenuOpen) { modelMenuOpen = false; renderModelMenu(); }
      });

      modelDD.appendChild(modelBtn);
      row.appendChild(modelDD);

      const spacer = document.createElement('div');
      spacer.style.flex = '1';
      row.appendChild(spacer);

      this.actionsEl = document.createElement('div');
      this.actionsEl.className = 'header__actions';
      this.buildButtons();
      row.appendChild(this.actionsEl);

      header.appendChild(row);
    } else {
      // ── Standalone: single row (original layout) ────────────────
      const leftGroup = document.createElement('div');
      leftGroup.style.cssText = 'display: flex; align-items: center; gap: 6px;';

      const logo = this.sliccLogo(22);
      leftGroup.appendChild(logo);

      const title = document.createElement('div');
      title.className = 'header__title';
      title.textContent = 'slicc';
      leftGroup.appendChild(title);

      // Separator between branding and controls
      const headerSep = document.createElement('div');
      headerSep.className = 'header__separator';
      leftGroup.appendChild(headerSep);

      leftGroup.appendChild(providerIndicator);
      leftGroup.appendChild(modelSelect);

      header.appendChild(leftGroup);

      this.actionsEl = document.createElement('div');
      this.actionsEl.className = 'header__actions';
      this.buildButtons();
      header.appendChild(this.actionsEl);
    }

    parent.appendChild(header);
  }

  /** Scoop brand palette — cycles for scoops beyond 5. */
  private static readonly SCOOP_COLORS = ['#f000a0', '#00f0f0', '#90f000', '#15d675', '#e68619'];

  /** Create the SLICC ice cream cone SVG logo (transparent bg, dynamic scoops). */
  private sliccLogo(size = 22): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('overflow', 'visible');
    svg.classList.add('header__logo');

    // Cone (orange triangle) — always present
    const cone = document.createElementNS(ns, 'path');
    cone.setAttribute('d', 'M10 20l6 11 6-11z');
    cone.setAttribute('fill', '#f07000');
    cone.classList.add('logo-cone');
    svg.appendChild(cone);

    // Scoops container group — dynamically populated
    const scoopsGroup = document.createElementNS(ns, 'g');
    scoopsGroup.classList.add('logo-scoops');
    svg.appendChild(scoopsGroup);

    this.logoSvg = svg;
    return svg;
  }

  /** Fixed scoop radius in SVG units — scoops never shrink. */
  private static readonly SCOOP_R = 5;
  private static readonly SCOOP_SPACING = 8.5; // center-to-center horizontal
  private static readonly ROW_STEP = 7.5;      // center-to-center vertical

  /**
   * Calculate pyramid layout positions for N scoops.
   * Constant size — the ice cream just gets taller and wider.
   */
  private pyramidLayout(count: number): Array<{ cx: number; cy: number }> {
    if (count === 0) return [];

    const { SCOOP_SPACING, ROW_STEP } = Layout;

    // Find bottom row width: smallest w where w*(w+1)/2 >= count
    let w = 1;
    while (w * (w + 1) / 2 < count) w++;

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

  /** Update the logo to reflect current scoops. Animates new scoops. */
  updateLogoScoops(scoops: RegisteredScoop[]): void {
    if (!this.logoSvg) return;

    const ns = 'http://www.w3.org/2000/svg';
    const group = this.logoSvg.querySelector('.logo-scoops');
    if (!group) return;

    const nonCone = scoops.filter(s => !s.isCone);
    const prevCount = this.logoScoopCount;

    // Skip redundant calls (same count, no change)
    if (prevCount === nonCone.length && prevCount >= 0) return;
    this.logoScoopCount = nonCone.length;

    // Clear existing scoops
    while (group.firstChild) group.removeChild(group.firstChild);

    if (nonCone.length === 0) {
      this.logoSvg.setAttribute('viewBox', '0 0 32 32');
      return;
    }

    // Animate when count grew after initial load (prevCount -1 = first render, skip)
    const isNewScoop = prevCount >= 0 && nonCone.length > prevCount;
    const positions = this.pyramidLayout(nonCone.length);
    const r = Layout.SCOOP_R;

    for (let i = 0; i < nonCone.length; i++) {
      const pos = positions[i];
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(pos.cx));
      circle.setAttribute('cy', String(pos.cy));
      circle.setAttribute('r', String(r));
      circle.setAttribute('fill', Layout.SCOOP_COLORS[i % Layout.SCOOP_COLORS.length]);

      if (isNewScoop) {
        if (i >= prevCount) {
          // New scoop: drop in from above
          circle.classList.add('logo-scoop-enter');
        } else {
          // Existing scoops: wiggle as the new one lands
          circle.classList.add('logo-scoop-wiggle');
        }
      }

      group.appendChild(circle);
    }

    // Squash the cone when a new scoop lands
    if (isNewScoop) {
      const cone = this.logoSvg.querySelector('.logo-cone');
      if (cone) {
        cone.classList.remove('logo-cone-squash');
        // Force reflow to restart animation
        void (cone as SVGGraphicsElement).getBBox();
        cone.classList.add('logo-cone-squash');
      }
    }

    // Expand viewBox to fit the growing ice cream — never shrink scoops
    const allX = positions.map(p => p.cx);
    const allY = positions.map(p => p.cy);
    const minX = Math.min(...allX) - r - 1;
    const maxX = Math.max(...allX) + r + 1;
    const minY = Math.min(...allY) - r - 1;
    const maxY = 32; // cone bottom stays fixed
    this.logoSvg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  }

  /** Create an S2-style outline SVG icon. */
  private svgIcon(paths: string[], viewBox = '0 0 20 20'): SVGSVGElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  /** Create an icon button with custom tooltip. */
  private iconBtn(icon: SVGSVGElement, tooltip: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'header__btn';
    btn.setAttribute('aria-label', tooltip);
    btn.dataset.tooltip = tooltip;
    btn.appendChild(icon);
    return btn;
  }

  private buildButtons(): void {
    // SVG icon paths (S2 outline style: 20×20 canvas, 1.5px stroke)
    const icons = {
      trash: ['M4 6h12', 'M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2', 'M6 6v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6'],
      copy: ['M7 7h9v9H7z', 'M13 7V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2'],
      terminal: ['M3 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M6 10l2-2', 'M6 10l2 2', 'M11 12h3'],
      database: ['M10 3c3.87 0 7 1.12 7 2.5S13.87 8 10 8 3 6.88 3 5.5 6.13 3 10 3z', 'M3 5.5v9C3 15.88 6.13 17 10 17s7-1.12 7-2.5v-9', 'M3 10c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5'],
      gear: ['M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17.4 10a7.46 7.46 0 0 0-.1-1.3l1.5-1.2-1.5-2.6-1.8.7a7.13 7.13 0 0 0-1.9-1.1L13.2 3h-3l-.4 1.5a7.13 7.13 0 0 0-1.9 1.1l-1.8-.7-1.5 2.6 1.5 1.2a7.46 7.46 0 0 0 0 2.6l-1.5 1.2 1.5 2.6 1.8-.7c.6.5 1.2.8 1.9 1.1l.4 1.5h3l.4-1.5c.7-.3 1.3-.6 1.9-1.1l1.8.7 1.5-2.6-1.5-1.2a7.46 7.46 0 0 0 .1-1.3z'],
      clearScoops: ['M10 3c3.87 0 7 1.12 7 2.5S13.87 8 10 8 3 6.88 3 5.5 6.13 3 10 3z', 'M3 5.5v9C3 15.88 6.13 17 10 17s7-1.12 7-2.5v-9', 'M7 12l6-4', 'M7 8l6 4'],
    };

    // Clear Chat
    this.clearChatBtn = this.iconBtn(this.svgIcon(icons.trash), 'Clear Chat');
    this.clearChatBtn.addEventListener('click', async () => {
      await this.panels.chat.clearSession();
      await this.onClearChat?.();
      location.reload();
    });
    this.actionsEl.appendChild(this.clearChatBtn);

    // Copy Chat
    this.copyChatBtn = this.iconBtn(this.svgIcon(icons.copy), 'Copy Chat');
    this.copyChatBtn.addEventListener('click', async () => {
      const messages: ChatMessage[] = this.panels.chat.getMessages();
      let formatted = '';
      for (const msg of messages) {
        const heading = msg.role === 'user' ? 'User' : 'Assistant';
        formatted += `## ${heading}\n${msg.content}\n\n`;
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            formatted += `### Tool: ${tc.name}\nInput: ${JSON.stringify(tc.input, null, 2)}\nResult: ${tc.result ?? ''}\n\n`;
          }
        }
      }
      await navigator.clipboard.writeText(formatted);
      // Brief visual feedback — swap icon color
      this.copyChatBtn.style.color = 'var(--s2-positive)';
      setTimeout(() => { this.copyChatBtn.style.color = ''; }, 1500);
    });
    this.actionsEl.appendChild(this.copyChatBtn);

    // Terminal: clears terminal and switches to terminal tab
    this.clearTermBtn = this.iconBtn(this.svgIcon(icons.terminal), 'Clear Terminal');
    this.clearTermBtn.addEventListener('click', () => {
      this.panels.terminal.clearTerminal();
      this.openTerminal();
    });
    this.actionsEl.appendChild(this.clearTermBtn);

    // Clear FS
    this.clearFsBtn = this.iconBtn(this.svgIcon(icons.database), 'Clear Filesystem');
    this.clearFsBtn.addEventListener('click', async () => {
      await this.onClearFilesystem?.();
      location.reload();
    });
    this.actionsEl.appendChild(this.clearFsBtn);

    // Clear Scoops DB (dev mode only)
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      const clearScoopsBtn = this.iconBtn(this.svgIcon(icons.clearScoops), 'Clear Scoops DB');
      clearScoopsBtn.addEventListener('click', async () => {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name?.startsWith('slicc-fs') || db.name === 'slicc-groups') {
            indexedDB.deleteDatabase(db.name);
          }
        }
        location.reload();
      });
      this.actionsEl.appendChild(clearScoopsBtn);
    }

    // Separator before settings
    const sep = document.createElement('div');
    sep.className = 'header__separator';
    this.actionsEl.appendChild(sep);

    // Settings button
    const settingsBtn = this.iconBtn(this.svgIcon(icons.gear), 'Settings');
    if (!getApiKey()) {
      settingsBtn.style.color = 'var(--slicc-cone)'; // highlight unconfigured state
    }
    settingsBtn.addEventListener('click', async () => {
      if (getApiKey()) {
        await showProviderSettings();
        location.reload();
      } else {
        clearAllSettings();
        await showProviderSettings();
        location.reload();
      }
    });
    this.actionsEl.appendChild(settingsBtn);
  }

  /** Show/hide buttons based on active tab (extension mode only). */
  private updateButtonVisibility(): void {
    if (!this.isExtension) return;
    const t = this.activeTab;
    this.clearChatBtn.style.display = t === 'chat' ? '' : 'none';
    this.copyChatBtn.style.display = t === 'chat' ? '' : 'none';
    this.clearTermBtn.style.display = t === 'terminal' ? '' : 'none';
    this.clearFsBtn.style.display = t === 'files' ? '' : 'none';
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

    this.extensionZone = new TabZone(tabBar, content, 'primary', {
      onTabActivate: (id) => {
        this.activeTab = id;
        this.updateButtonVisibility();
        if (id === 'terminal') this.panels?.terminal?.refit?.();
        if (id === 'memory') this.panels?.memory?.refresh();
      },
      onTabClose: (id) => {
        const name = id.startsWith('sprinkle-') ? id.slice(9) : id;
        this.onSprinkleClose?.(name);
      },
      onAddClick: () => this.showExtensionPicker(tabBar),
    }, { classPrefix: 'tab-bar' });

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
      const container = id === 'chat' ? chatContainer
        : id === 'terminal' ? terminalContainer
        : id === 'files' ? filesContainer
        : memoryContainer;
      this.extensionZone.addTab({
        id,
        label,
        closable: false,
        element: container,
        onActivate: id === 'terminal' ? () => this.panels?.terminal?.refit?.()
          : id === 'memory' ? () => this.panels?.memory?.refresh()
          : undefined,
      });
      // Keep tabContainers in sync for backward compat
      this.tabContainers.set(id, container);
    }

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
      terminal: new TerminalPanel(terminalContainer),
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

    this.updateButtonVisibility();
  }

  /** Show the [+] picker in extension mode. */
  private showExtensionPicker(anchor: HTMLElement): void {
    const availableSprinkles = (this.getAvailableSprinkles?.() ?? []);
    // In extension mode, all panels are in one zone — filter already-open ones
    const openIds = new Set(this.extensionZone.getTabIds());
    const available = availableSprinkles.filter(p => !openIds.has(`sprinkle-${p.name}`));

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

    // Scoops panel (leftmost)
    this.scoopsEl = document.createElement('div');
    this.scoopsEl.className = 'layout__scoops';
    layout.appendChild(this.scoopsEl);

    // Scoops divider
    this.scoopsDivider = document.createElement('div');
    this.scoopsDivider.className = 'layout__divider';
    layout.appendChild(this.scoopsDivider);

    // Left panel (chat)
    this.leftEl = document.createElement('div');
    this.leftEl.className = 'layout__left';
    layout.appendChild(this.leftEl);

    // Vertical divider
    this.verticalDivider = document.createElement('div');
    this.verticalDivider.className = 'layout__divider';
    layout.appendChild(this.verticalDivider);

    // Right panel
    this.rightEl = document.createElement('div');
    this.rightEl.className = 'layout__right';

    // ── Primary zone (Terminal + sprinkle tabs) ──
    this.primaryZoneEl = document.createElement('div');
    this.primaryZoneEl.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: none;';

    const primaryTabBar = document.createElement('div');
    primaryTabBar.className = 'mini-tabs';
    this.primaryZoneEl.appendChild(primaryTabBar);

    const primaryContentArea = document.createElement('div');
    primaryContentArea.style.cssText = 'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;';
    this.primaryZoneEl.appendChild(primaryContentArea);

    this.primaryZone = new TabZone(primaryTabBar, primaryContentArea, 'primary', {
      onTabActivate: (id) => {
        if (id === 'terminal') this.panels?.terminal?.refit();
      },
      onTabClose: (id) => {
        const name = id.startsWith('sprinkle-') ? id.slice(9) : id;
        this.onSprinkleClose?.(name);
      },
      onAddClick: () => this.showPickerForZone('primary', primaryTabBar),
    });
    this.primaryZone.enableAddButton();

    this.rightEl.appendChild(this.primaryZoneEl);

    // ── Horizontal divider ──
    this.horizontalDivider = document.createElement('div');
    this.horizontalDivider.className = 'layout__right-divider';
    this.rightEl.appendChild(this.horizontalDivider);

    // ── Drawer zone (Files + Memory) ──
    this.drawerZoneEl = document.createElement('div');
    this.drawerZoneEl.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden;';

    const drawerTabBar = document.createElement('div');
    drawerTabBar.className = 'mini-tabs';
    this.drawerZoneEl.appendChild(drawerTabBar);

    const drawerContentArea = document.createElement('div');
    drawerContentArea.style.cssText = 'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;';
    this.drawerZoneEl.appendChild(drawerContentArea);

    this.drawerZone = new TabZone(drawerTabBar, drawerContentArea, 'drawer', {
      onTabActivate: (id) => {
        if (id === 'terminal') this.panels?.terminal?.refit();
        if (id === 'memory') this.panels?.memory?.refresh();
        // Update URL param for drawer tab
        const url = new URL(window.location.href);
        url.searchParams.set('bottomTab', id);
        history.replaceState(null, '', url.toString());
      },
      onTabClose: (id) => {
        const name = id.startsWith('sprinkle-') ? id.slice(9) : id;
        this.onSprinkleClose?.(name);
      },
      onAddClick: () => this.showPickerForZone('drawer', drawerTabBar),
    });
    this.drawerZone.enableAddButton();

    // Terminal tab
    this.terminalContainer = document.createElement('div');
    this.terminalContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';
    this.drawerZone.addTab({
      id: 'terminal',
      label: 'Terminal',
      closable: false,
      element: this.terminalContainer,
      onActivate: () => this.panels?.terminal?.refit(),
    });

    // Files tab
    const fileBrowserContainer = document.createElement('div');
    fileBrowserContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';
    this.drawerZone.addTab({
      id: 'files',
      label: 'Files',
      closable: false,
      element: fileBrowserContainer,
    });

    // Memory tab
    const memoryContainer = document.createElement('div');
    memoryContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; flex: 1;';
    this.drawerZone.addTab({
      id: 'memory',
      label: 'Memory',
      closable: false,
      element: memoryContainer,
      onActivate: () => this.panels?.memory?.refresh(),
    });

    // Restore persisted drawer height
    const savedDrawerHeight = localStorage.getItem('slicc-drawer-height');
    if (savedDrawerHeight) this.drawerHeightFraction = parseFloat(savedDrawerHeight) || 0.35;

    // Restore persisted primary tab
    this.primaryZone.restoreActiveTab();

    // Restore persisted drawer tab (also check URL param)
    const urlDrawerTab = new URL(window.location.href).searchParams.get('bottomTab');
    if (urlDrawerTab && this.drawerZone.hasTab(urlDrawerTab)) {
      this.drawerZone.activateTab(urlDrawerTab);
    } else {
      this.drawerZone.restoreActiveTab();
    }

    this.rightEl.appendChild(this.drawerZoneEl);
    layout.appendChild(this.rightEl);

    // Hidden container for scoop iframes
    this.iframeContainer = document.createElement('div');
    this.iframeContainer.id = 'scoop-iframes';
    this.iframeContainer.style.display = 'none';
    layout.appendChild(this.iframeContainer);

    this.root.appendChild(layout);

    // Create panels
    this.panels = {
      chat: new ChatPanel(this.leftEl),
      terminal: new TerminalPanel(this.terminalContainer),
      fileBrowser: new FileBrowserPanel(fileBrowserContainer, {
        onRunCommand: (command) => {
          void this.runFileBrowserCommand(command);
        },
      }),
      memory: new MemoryPanel(memoryContainer),
      scoops: new ScoopsPanel(this.scoopsEl, {
        onScoopSelect: (scoop) => this.onScoopSelect?.(scoop),
        onSendMessage: () => {},
        onScoopsChanged: (scoops) => this.updateLogoScoops(scoops),
      }),
    };

    this.applySizes();

    this.setupScoopsDrag();
    this.setupVerticalDrag();
    this.setupHorizontalDrag();
    window.addEventListener('resize', () => this.applySizes());
  }

  private applySizes(): void {
    const totalWidth = this.root.clientWidth;
    const dividerW = 4;

    const scoopsW = Math.round(totalWidth * this.scoopsWidth);
    const leftW = Math.round(totalWidth * this.leftWidth);
    const rightW = Math.max(0, totalWidth - scoopsW - leftW - (dividerW * 2));

    this.scoopsEl.style.width = scoopsW + 'px';
    this.leftEl.style.width = leftW + 'px';
    this.rightEl.style.width = rightW + 'px';

    const rightH = this.rightEl.clientHeight;
    const hDividerH = 4;
    const drawerH = Math.max(28, Math.round(rightH * this.drawerHeightFraction));
    const primaryH = Math.max(100, rightH - drawerH - hDividerH);

    this.primaryZoneEl.style.height = primaryH + 'px';
    this.drawerZoneEl.style.height = drawerH + 'px';
  }

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

  private setupScoopsDrag(): void {
    let dragging = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = this.root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.scoopsWidth = Math.max(0.1, Math.min(0.3, x / rect.width));
      this.applySizes();
    };

    const onMouseUp = () => {
      dragging = false;
      this.scoopsDivider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    this.scoopsDivider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      this.scoopsDivider.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  private setupVerticalDrag(): void {
    let dragging = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = this.root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const xFraction = x / rect.width;
      const minLeft = 0.2;
      const minRight = 0.2;
      const maxLeft = Math.max(minLeft, 1 - this.scoopsWidth - minRight);
      const rawLeft = xFraction - this.scoopsWidth;
      this.leftWidth = Math.max(minLeft, Math.min(maxLeft, rawLeft));
      this.applySizes();
    };

    const onMouseUp = () => {
      dragging = false;
      this.verticalDivider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
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

  private setupHorizontalDrag(): void {
    let dragging = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = this.rightEl.getBoundingClientRect();
      const rightH = rect.height;
      const y = e.clientY - rect.top;
      // drawerHeightFraction = fraction from bottom
      const primaryFraction = y / rightH;
      this.drawerHeightFraction = Math.max(28 / rightH, Math.min(1 - 100 / rightH, 1 - primaryFraction));
      this.applySizes();
    };

    const onMouseUp = () => {
      dragging = false;
      this.horizontalDivider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem('slicc-drawer-height', String(this.drawerHeightFraction));
      this.panels?.terminal?.refit();
    };

    this.horizontalDivider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      this.horizontalDivider.classList.add('active');
      document.body.style.cursor = 'row-resize';
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
    const unopenedSprinkles = availableSprinkles.filter(p => !openSprinkles.has(p.name)).length;
    const hasAvailable = closedCount + unopenedSprinkles > 0;
    this.primaryZone?.setAddButtonEnabled(hasAvailable);
    this.drawerZone?.setAddButtonEnabled(hasAvailable);
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
    const availableSprinkles = (this.getAvailableSprinkles?.() ?? [])
      .filter(p => !openSprinkles.has(p.name));

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

    const tabZone = zone === 'primary' ? this.primaryZone : this.drawerZone;
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
      // Standalone mode: add to the requested zone (default: primary)
      const zone = targetZone ?? 'primary';
      const tabZone = zone === 'primary' ? this.primaryZone : this.drawerZone;
      const tabId = `sprinkle-${name}`;

      const container = document.createElement('div');
      container.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: auto; flex: 1;';
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
      const entry = this.registry.get(tabId);
      const zone = entry?.descriptor.zone;
      const tabZone = zone === 'drawer' ? this.drawerZone : this.primaryZone;
      tabZone.removeTab(tabId);
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
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }
}
