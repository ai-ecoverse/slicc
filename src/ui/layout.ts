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
} from './provider-settings.js';
import type { ChatMessage } from './types.js';
import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';

export interface LayoutPanels {
  chat: ChatPanel;
  terminal: TerminalPanel;
  fileBrowser: FileBrowserPanel;
  memory: MemoryPanel;
  scoops: ScoopsPanel;
}

type TabId = 'chat' | 'terminal' | 'files' | 'memory';

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
  private bottomSection!: HTMLElement;
  private terminalContainer!: HTMLElement;
  private fileBrowserContainer!: HTMLElement;
  private iframeContainer!: HTMLElement;

  // Tabbed-layout elements (extension only)
  private tabContainers = new Map<TabId, HTMLElement>();
  private tabButtons = new Map<TabId, HTMLElement>();
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
  public onModelChange?: (model: string) => void;
  public onScoopSelect?: (scoop: RegisteredScoop) => void;
  public onClearChat?: () => Promise<void>;

  private scoopsWidth = 0.15;
  private leftWidth = 0.45;
  private topHeight = 0.65;

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

    const populateModels = () => {
      const providerId = getSelectedProvider();
      const models = getProviderModels(providerId);
      const currentModelId = getSelectedModelId();
      providerIndicator.textContent = providerId;
      while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
      if (models.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models';
        modelSelect.appendChild(opt);
        return;
      }
      const sorted = [...models].sort((a, b) => {
        if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const model of sorted) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.name;
        if (model.id === currentModelId) opt.selected = true;
        modelSelect.appendChild(opt);
      }
      if (!currentModelId || !models.find(m => m.id === currentModelId)) {
        modelSelect.selectedIndex = 0;
        if (modelSelect.value) setSelectedModelId(modelSelect.value);
      }
    };
    populateModels();
    modelSelect.addEventListener('change', () => {
      setSelectedModelId(modelSelect.value);
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

        const providerId = getSelectedProvider();
        const models = getProviderModels(providerId);
        const currentModelId = getSelectedModelId();

        const sorted = [...models].sort((a, b) => {
          if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        for (const model of sorted) {
          const item = document.createElement('div');
          item.style.cssText =
            'padding: 6px 12px; cursor: pointer; font-size: 12px; color: var(--s2-content-default); ' +
            'display: flex; align-items: center; gap: 6px; border-radius: var(--s2-radius-s); ' +
            'margin: 0 4px; transition: background 130ms ease;';
          if (model.id === currentModelId) {
            item.style.color = 'var(--slicc-cone)';
            item.style.fontWeight = '700';
          }
          item.addEventListener('mouseenter', () => { item.style.background = 'var(--s2-bg-elevated)'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });

          const check = document.createElement('span');
          check.style.cssText = 'width: 14px; text-align: center; font-size: 10px;';
          check.textContent = model.id === currentModelId ? '\u2713' : '';
          item.appendChild(check);

          const label = document.createElement('span');
          label.textContent = model.name;
          item.appendChild(label);

          item.addEventListener('click', () => {
            setSelectedModelId(model.id);
            this.onModelChange?.(model.id);
            modelMenuOpen = false;
            renderModelMenu();
          });
          menu.appendChild(item);
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
        void (cone as SVGElement).getBBox();
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

    // Clear Terminal
    this.clearTermBtn = this.iconBtn(this.svgIcon(icons.terminal), 'Clear Terminal');
    this.clearTermBtn.addEventListener('click', () => {
      this.panels.terminal.clearTerminal();
    });
    this.actionsEl.appendChild(this.clearTermBtn);

    // Clear FS
    this.clearFsBtn = this.iconBtn(this.svgIcon(icons.database), 'Clear Filesystem');
    this.clearFsBtn.addEventListener('click', async () => {
      indexedDB.deleteDatabase('virtual-fs');
      indexedDB.deleteDatabase('slicc-fs');
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of (root as any).keys()) {
          await (root as any).removeEntry(name, { recursive: true });
        }
      } catch { /* OPFS not available or already empty */ }
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

  private buildTabbedLayout(): void {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    this.buildHeader(this.root);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';

    const tabs: [TabId, string][] = [
      ['chat', 'Chat'],
      ['terminal', 'Terminal'],
      ['files', 'Files'],
      ['memory', 'Memory'],
    ];

    for (const [id, label] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab-bar__tab';
      btn.textContent = label;
      btn.dataset.tab = id;
      if (id === this.activeTab) btn.classList.add('tab-bar__tab--active');
      btn.addEventListener('click', () => this.switchTab(id));
      tabBar.appendChild(btn);
      this.tabButtons.set(id, btn);
    }

    this.root.appendChild(tabBar);

    // Tab content area
    const content = document.createElement('div');
    content.className = 'tab-content';

    for (const [id] of tabs) {
      const container = document.createElement('div');
      container.className = 'tab-content__panel';
      container.dataset.tab = id;
      if (id !== this.activeTab) container.style.display = 'none';
      content.appendChild(container);
      this.tabContainers.set(id, container);
    }

    this.root.appendChild(content);

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
      chat: new ChatPanel(this.tabContainers.get('chat')!),
      terminal: new TerminalPanel(this.tabContainers.get('terminal')!),
      fileBrowser: new FileBrowserPanel(this.tabContainers.get('files')!, {
        onRunCommand: async (command) => {
          await this.runFileBrowserCommand(command);
          this.switchTab('terminal');
        },
      }),
      memory: new MemoryPanel(this.tabContainers.get('memory')!),
      scoops: new ScoopsPanel(this.scoopsEl, {
        onScoopSelect: (scoop) => this.onScoopSelect?.(scoop),
        onSendMessage: () => {},
        onScoopsChanged: (scoops) => this.updateLogoScoops(scoops),
      }),
    };

    this.updateButtonVisibility();
  }

  private switchTab(id: TabId): void {
    if (id === this.activeTab) return;
    this.activeTab = id;

    for (const [tabId, btn] of this.tabButtons) {
      btn.classList.toggle('tab-bar__tab--active', tabId === id);
    }

    for (const [tabId, container] of this.tabContainers) {
      container.style.display = tabId === id ? '' : 'none';
    }

    this.updateButtonVisibility();

    if (id === 'terminal') {
      this.panels.terminal.refit?.();
    }

    if (id === 'memory') {
      this.panels.memory.refresh();
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

    this.terminalContainer = document.createElement('div');
    this.terminalContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: none;';
    this.rightEl.appendChild(this.terminalContainer);

    this.horizontalDivider = document.createElement('div');
    this.horizontalDivider.className = 'layout__right-divider';
    this.rightEl.appendChild(this.horizontalDivider);

    // Bottom section with tabs for Files/Memory
    this.bottomSection = document.createElement('div');
    this.bottomSection.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden;';

    const miniTabs = document.createElement('div');
    miniTabs.className = 'mini-tabs';

    const filesTab = document.createElement('button');
    filesTab.className = 'mini-tabs__tab mini-tabs__tab--active';
    filesTab.textContent = 'Files';
    filesTab.dataset.tab = 'files';
    miniTabs.appendChild(filesTab);

    const memoryTab = document.createElement('button');
    memoryTab.className = 'mini-tabs__tab';
    memoryTab.textContent = 'Memory';
    memoryTab.dataset.tab = 'memory';
    miniTabs.appendChild(memoryTab);

    this.bottomSection.appendChild(miniTabs);

    this.fileBrowserContainer = document.createElement('div');
    this.fileBrowserContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: 1;';
    this.bottomSection.appendChild(this.fileBrowserContainer);

    const memoryContainer = document.createElement('div');
    memoryContainer.style.cssText = 'display: none; flex-direction: column; min-height: 0; flex: 1;';
    this.bottomSection.appendChild(memoryContainer);

    const setBottomTab = (tab: 'files' | 'memory') => {
      if (tab === 'memory') {
        memoryTab.classList.add('mini-tabs__tab--active');
        filesTab.classList.remove('mini-tabs__tab--active');
        memoryContainer.style.display = 'flex';
        this.fileBrowserContainer.style.display = 'none';
        this.panels?.memory?.refresh();
      } else {
        filesTab.classList.add('mini-tabs__tab--active');
        memoryTab.classList.remove('mini-tabs__tab--active');
        this.fileBrowserContainer.style.display = 'flex';
        memoryContainer.style.display = 'none';
      }
      const url = new URL(window.location.href);
      url.searchParams.set('bottomTab', tab);
      history.replaceState(null, '', url.toString());
    };

    filesTab.addEventListener('click', () => setBottomTab('files'));
    memoryTab.addEventListener('click', () => setBottomTab('memory'));

    const initialTab = new URL(window.location.href).searchParams.get('bottomTab');
    if (initialTab === 'memory') {
      setBottomTab('memory');
    }

    this.rightEl.appendChild(this.bottomSection);
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
      fileBrowser: new FileBrowserPanel(this.fileBrowserContainer, {
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
    const topH = Math.round(rightH * this.topHeight);
    const bottomH = rightH - topH - hDividerH;

    this.terminalContainer.style.height = topH + 'px';
    if (this.bottomSection) {
      this.bottomSection.style.height = bottomH + 'px';
    }
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
      const y = e.clientY - rect.top;
      this.topHeight = Math.max(0.2, Math.min(0.8, y / rect.height));
      this.applySizes();
    };

    const onMouseUp = () => {
      dragging = false;
      this.horizontalDivider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
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

  // ── Cleanup ─────────────────────────────────────────────────────────

  dispose(): void {
    this.panels.chat.dispose();
    this.panels.terminal.dispose();
    this.panels.fileBrowser.dispose();
    this.panels.memory.dispose();
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }
}
