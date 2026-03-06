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
      'font-size: 11px; color: #888; cursor: pointer; padding: 2px 6px; ' +
      'background: #1a1a2e; border-radius: 4px; border: 1px solid #333;';
    providerIndicator.title = 'Click to change provider';
    providerIndicator.addEventListener('click', async () => {
      await showProviderSettings();
      location.reload();
    });

    // ── Model picker (shared, created once) ───────────────────────
    const modelSelect = document.createElement('select');
    modelSelect.style.cssText = this.isExtension
      ? 'background: #2a2a3a; color: #e0e0f0; border: 1px solid #444; border-radius: 4px; ' +
        'padding: 2px 4px; font-size: 11px; cursor: pointer; outline: none; max-width: 140px;'
      : 'background: #2a2a3a; color: #e0e0f0; border: 1px solid #444; border-radius: 4px; ' +
        'padding: 4px 8px; font-size: 13px; cursor: pointer; outline: none; margin-left: 8px;';

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
        'display: flex; align-items: center; gap: 4px; padding: 4px 8px; ' +
        'border: 1px solid #444; border-radius: 6px; background: #2a2a3a; color: #e0e0f0; ' +
        'font-size: 12px; cursor: pointer; white-space: nowrap;';
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
          'overflow-y: auto; background: #1e1e2e; border: 1px solid #444; border-radius: 8px; ' +
          'padding: 4px 0; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 1000;';

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
            'padding: 6px 12px; cursor: pointer; font-size: 12px; color: #c0c0d0; ' +
            'display: flex; align-items: center; gap: 6px;';
          if (model.id === currentModelId) {
            item.style.color = '#e94560';
            item.style.fontWeight = '600';
          }
          item.addEventListener('mouseenter', () => { item.style.background = '#2a2a4a'; });
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
      leftGroup.style.cssText = 'display: flex; align-items: center; gap: 0;';

      const title = document.createElement('div');
      title.className = 'header__title';
      title.textContent = 'slicc';
      leftGroup.appendChild(title);

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

  private buildButtons(): void {
    const ext = this.isExtension;

    // Clear Chat
    this.clearChatBtn = document.createElement('button');
    this.clearChatBtn.className = 'header__btn';
    this.clearChatBtn.textContent = ext ? '\u{1F5D1}' : 'Clear Chat';
    if (ext) this.clearChatBtn.title = 'Clear Chat';
    this.clearChatBtn.addEventListener('click', async () => {
      await this.panels.chat.clearSession();
      await this.onClearChat?.();
      location.reload();
    });
    this.actionsEl.appendChild(this.clearChatBtn);

    // Copy Chat
    this.copyChatBtn = document.createElement('button');
    this.copyChatBtn.className = 'header__btn';
    this.copyChatBtn.textContent = ext ? '\u{1F4CB}' : 'Copy Chat';
    if (ext) this.copyChatBtn.title = 'Copy Chat';
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
      this.copyChatBtn.textContent = ext ? '\u2713' : 'Copied!';
      setTimeout(() => { this.copyChatBtn.textContent = ext ? '\u{1F4CB}' : 'Copy Chat'; }, 2000);
    });
    this.actionsEl.appendChild(this.copyChatBtn);

    // Clear Terminal
    this.clearTermBtn = document.createElement('button');
    this.clearTermBtn.className = 'header__btn';
    this.clearTermBtn.textContent = ext ? '\u{1F5D1}' : 'Clear Terminal';
    if (ext) this.clearTermBtn.title = 'Clear Terminal';
    this.clearTermBtn.addEventListener('click', () => {
      this.panels.terminal.clearTerminal();
    });
    this.actionsEl.appendChild(this.clearTermBtn);

    // Clear FS (dev mode only)
    this.clearFsBtn = document.createElement('button');
    this.clearFsBtn.className = 'header__btn';
    this.clearFsBtn.textContent = ext ? '\u{1F5D1}' : 'Clear FS';
    if (ext) this.clearFsBtn.title = 'Clear FS';
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
    const clearScoopsBtn = document.createElement('button');
    clearScoopsBtn.className = 'header__btn';
    clearScoopsBtn.textContent = 'Clear Scoops';
    clearScoopsBtn.addEventListener('click', async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name?.startsWith('slicc-fs') || db.name === 'slicc-groups') {
          indexedDB.deleteDatabase(db.name);
        }
      }
      location.reload();
    });
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      this.actionsEl.appendChild(clearScoopsBtn);
    }

    // Settings button (shows provider settings dialog)
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'header__btn';
    settingsBtn.textContent = ext ? '\u2699' : (getApiKey() ? 'Settings' : 'Configure');
    if (ext) settingsBtn.title = 'Settings';
    settingsBtn.addEventListener('click', async () => {
      if (getApiKey()) {
        // Show settings to reconfigure
        await showProviderSettings();
        location.reload();
      } else {
        // Clear and show first-run dialog directly (avoid extra reload cycle)
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
