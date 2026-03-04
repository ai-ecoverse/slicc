/**
 * Layout — split-pane (standalone) or tabbed (extension) layout.
 *
 * Standalone mode (CLI):
 *   ┌───────┬─────────────┬───┬───────────────┐
 *   │  Header (full width)                    │
 *   ├───────┬─────────────┬───┬───────────────┤
 *   │Groups │             │ ║ │  Terminal      │
 *   │       │  Chat       │ ║ ├───────────────┤
 *   │       │  Panel      │ ║ │  Files        │
 *   │       │             │ ║ │               │
 *   └───────┴─────────────┴───┴───────────────┘
 *
 * Extension mode (side panel):
 *   ┌─ Header ──────────────────────┐
 *   ├─ Tabs: [Chat] [Term] [Files] ─┤
 *   │                                │
 *   │  Active panel (full size)      │
 *   │                                │
 *   └────────────────────────────────┘
 */

import { ChatPanel } from './chat-panel.js';
import { TerminalPanel } from './terminal-panel.js';
import { FileBrowserPanel } from './file-browser-panel.js';
import { GroupsPanel } from './groups-panel.js';
import { getApiKey, clearApiKey, clearAzureResource, clearProvider } from './api-key-dialog.js';
import type { ChatMessage } from './types.js';
import type { RegisteredGroup } from '../groups/types.js';

export interface LayoutPanels {
  chat: ChatPanel;
  terminal: TerminalPanel;
  fileBrowser: FileBrowserPanel;
  groups: GroupsPanel;
}

type TabId = 'chat' | 'terminal' | 'files';

export class Layout {
  private root: HTMLElement;
  private isExtension: boolean;

  // Split-layout elements (standalone only)
  private groupsEl!: HTMLElement;
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private groupsDivider!: HTMLElement;
  private verticalDivider!: HTMLElement;
  private horizontalDivider!: HTMLElement;
  private terminalContainer!: HTMLElement;
  private fileBrowserContainer!: HTMLElement;
  private iframeContainer!: HTMLElement;

  // Tabbed-layout elements (extension only)
  private tabContainers = new Map<TabId, HTMLElement>();
  private tabButtons = new Map<TabId, HTMLElement>();
  private activeTab: TabId = 'chat';
  private actionsEl!: HTMLElement;

  // Button references for tab-sensitive visibility
  private clearChatBtn!: HTMLButtonElement;
  private copyChatBtn!: HTMLButtonElement;
  private clearTermBtn!: HTMLButtonElement;
  private clearFsBtn!: HTMLButtonElement;

  public panels!: LayoutPanels;
  public onModelChange?: (model: string) => void;
  public onGroupSelect?: (group: RegisteredGroup) => void;

  private groupsWidth = 0.15; // fraction of total width for groups panel
  private leftWidth = 0.45; // fraction of total width for chat
  private topHeight = 0.65; // fraction of right panel height

  constructor(root: HTMLElement, isExtension = false) {
    this.root = root;
    this.isExtension = isExtension;
    if (isExtension) {
      this.buildTabbedLayout();
    } else {
      this.buildSplitLayout();
    }
  }

  // ── Shared: Header ──────────────────────────────────────────────────

  private buildHeader(parent: HTMLElement): void {
    const header = document.createElement('div');
    header.className = 'header';

    // Left group: title + model picker (anchored left so actions width changes don't shift it)
    const leftGroup = document.createElement('div');
    leftGroup.style.cssText = 'display: flex; align-items: center; gap: 0;';

    const title = document.createElement('div');
    title.className = 'header__title';
    title.textContent = 'slicc';
    leftGroup.appendChild(title);

    // Model picker
    const models: [string, string][] = [
      ['claude-opus-4-6', 'Opus 4.6'],
      ['claude-sonnet-4-6', 'Sonnet 4.6'],
      ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ];
    const modelSelect = document.createElement('select');
    modelSelect.style.cssText =
      'background: #2a2a3a; color: #e0e0f0; border: 1px solid #444; border-radius: 4px; ' +
      'padding: 4px 8px; font-size: 13px; cursor: pointer; outline: none; margin-left: 12px;';
    for (const [value, label] of models) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modelSelect.appendChild(opt);
    }
    const storedModel = localStorage.getItem('selected-model') || 'claude-opus-4-6';
    modelSelect.value = storedModel;
    modelSelect.addEventListener('change', () => {
      const value = modelSelect.value;
      localStorage.setItem('selected-model', value);
      this.onModelChange?.(value);
    });
    leftGroup.appendChild(modelSelect);

    header.appendChild(leftGroup);

    // Actions container
    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'header__actions';
    this.buildButtons();
    header.appendChild(this.actionsEl);

    parent.appendChild(header);
  }

  private buildButtons(): void {
    // Clear Chat
    this.clearChatBtn = document.createElement('button');
    this.clearChatBtn.className = 'header__btn';
    this.clearChatBtn.textContent = 'Clear Chat';
    this.clearChatBtn.addEventListener('click', async () => {
      await this.panels.chat.clearSession();
      location.reload();
    });
    this.actionsEl.appendChild(this.clearChatBtn);

    // Copy Chat
    this.copyChatBtn = document.createElement('button');
    this.copyChatBtn.className = 'header__btn';
    this.copyChatBtn.textContent = 'Copy Chat';
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
      this.copyChatBtn.textContent = 'Copied!';
      setTimeout(() => { this.copyChatBtn.textContent = 'Copy Chat'; }, 2000);
    });
    this.actionsEl.appendChild(this.copyChatBtn);

    // Clear Terminal
    this.clearTermBtn = document.createElement('button');
    this.clearTermBtn.className = 'header__btn';
    this.clearTermBtn.textContent = 'Clear Terminal';
    this.clearTermBtn.addEventListener('click', () => {
      this.panels.terminal.clearTerminal();
    });
    this.actionsEl.appendChild(this.clearTermBtn);

    // Clear FS
    this.clearFsBtn = document.createElement('button');
    this.clearFsBtn.className = 'header__btn';
    this.clearFsBtn.textContent = 'Clear FS';
    this.clearFsBtn.addEventListener('click', async () => {
      indexedDB.deleteDatabase('virtual-fs');
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of (root as any).keys()) {
          await (root as any).removeEntry(name, { recursive: true });
        }
      } catch { /* OPFS not available or already empty */ }
      location.reload();
    });
    this.actionsEl.appendChild(this.clearFsBtn);

    // API Key (always visible)
    const apiKeyBtn = document.createElement('button');
    apiKeyBtn.className = 'header__btn';
    apiKeyBtn.textContent = getApiKey() ? 'API Key \u2713' : 'API Key';
    apiKeyBtn.addEventListener('click', () => {
      if (getApiKey()) {
        clearApiKey();
        clearAzureResource();
        clearProvider();
        location.reload();
      }
    });
    this.actionsEl.appendChild(apiKeyBtn);
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
    // Safe: clearing own root element during initialization
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    this.buildHeader(this.root);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';

    const tabs: [TabId, string][] = [
      ['chat', 'Chat'],
      ['terminal', 'Terminal'],
      ['files', 'Files'],
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

    // Hidden container for group iframes (needed even in extension mode)
    this.iframeContainer = document.createElement('div');
    this.iframeContainer.id = 'group-iframes';
    this.iframeContainer.style.display = 'none';
    this.root.appendChild(this.iframeContainer);

    // Create a dummy groups element for extension mode
    this.groupsEl = document.createElement('div');
    this.groupsEl.style.display = 'none';
    this.root.appendChild(this.groupsEl);

    // Create panels in their tab containers
    this.panels = {
      chat: new ChatPanel(this.tabContainers.get('chat')!),
      terminal: new TerminalPanel(this.tabContainers.get('terminal')!),
      fileBrowser: new FileBrowserPanel(this.tabContainers.get('files')!),
      groups: new GroupsPanel(this.groupsEl, {
        onGroupSelect: (group) => this.onGroupSelect?.(group),
        onSendMessage: (jid, text) => {
          console.log('Send to group:', jid, text);
        },
      }),
    };

    this.updateButtonVisibility();
  }

  private switchTab(id: TabId): void {
    if (id === this.activeTab) return;
    this.activeTab = id;

    // Update tab buttons
    for (const [tabId, btn] of this.tabButtons) {
      btn.classList.toggle('tab-bar__tab--active', tabId === id);
    }

    // Show/hide panels
    for (const [tabId, container] of this.tabContainers) {
      container.style.display = tabId === id ? '' : 'none';
    }

    // Update context-sensitive buttons
    this.updateButtonVisibility();

    // Re-fit terminal when switching to it (xterm needs visible container)
    if (id === 'terminal') {
      this.panels.terminal.refit?.();
    }
  }

  // ── Standalone: Split Layout ────────────────────────────────────────

  private buildSplitLayout(): void {
    // Safe: clearing own root element during initialization
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    this.buildHeader(this.root);

    // Main layout
    const layout = document.createElement('div');
    layout.className = 'layout';

    // Groups panel (leftmost)
    this.groupsEl = document.createElement('div');
    this.groupsEl.className = 'layout__groups';
    layout.appendChild(this.groupsEl);

    // Groups divider
    this.groupsDivider = document.createElement('div');
    this.groupsDivider.className = 'layout__divider';
    layout.appendChild(this.groupsDivider);

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

    this.fileBrowserContainer = document.createElement('div');
    this.fileBrowserContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: none;';
    this.rightEl.appendChild(this.fileBrowserContainer);

    layout.appendChild(this.rightEl);

    // Hidden container for group iframes
    this.iframeContainer = document.createElement('div');
    this.iframeContainer.id = 'group-iframes';
    this.iframeContainer.style.display = 'none';
    layout.appendChild(this.iframeContainer);

    this.root.appendChild(layout);

    // Create panels
    this.panels = {
      chat: new ChatPanel(this.leftEl),
      terminal: new TerminalPanel(this.terminalContainer),
      fileBrowser: new FileBrowserPanel(this.fileBrowserContainer),
      groups: new GroupsPanel(this.groupsEl, {
        onGroupSelect: (group) => this.onGroupSelect?.(group),
        onSendMessage: (jid, text) => {
          // This will be wired to the orchestrator
          console.log('Send to group:', jid, text);
        },
      }),
    };

    this.applySizes();

    // Setup drag handlers
    this.setupGroupsDrag();
    this.setupVerticalDrag();
    this.setupHorizontalDrag();
    window.addEventListener('resize', () => this.applySizes());
  }

  private applySizes(): void {
    const totalWidth = this.root.clientWidth;
    const dividerW = 4;
    
    // Groups panel on the left
    const groupsW = Math.round(totalWidth * this.groupsWidth);
    // Chat panel in the middle
    const leftW = Math.round(totalWidth * this.leftWidth);
    // Right panel gets the rest
    const rightW = totalWidth - groupsW - leftW - (dividerW * 2);

    this.groupsEl.style.width = groupsW + 'px';
    this.leftEl.style.width = leftW + 'px';
    this.rightEl.style.width = rightW + 'px';

    const rightH = this.rightEl.clientHeight;
    const hDividerH = 4;
    const topH = Math.round(rightH * this.topHeight);
    const bottomH = rightH - topH - hDividerH;

    this.terminalContainer.style.height = topH + 'px';
    this.fileBrowserContainer.style.height = bottomH + 'px';
  }

  /** Get the iframe container for the orchestrator */
  getIframeContainer(): HTMLElement {
    return this.iframeContainer;
  }

  private setupGroupsDrag(): void {
    let dragging = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = this.root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.groupsWidth = Math.max(0.1, Math.min(0.3, x / rect.width));
      this.applySizes();
    };

    const onMouseUp = () => {
      dragging = false;
      this.groupsDivider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    this.groupsDivider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      this.groupsDivider.classList.add('active');
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
      // Clamp leftWidth to reasonable bounds considering groups panel
      this.leftWidth = Math.max(0.2, Math.min(0.5, x / rect.width));
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
    // Groups panel doesn't have dispose, but we clean up
    // Safe: clearing own root element, not untrusted content
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }
}
