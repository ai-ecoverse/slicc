/**
 * Layout — resizable split-pane layout for chat, terminal, and file browser.
 *
 * Structure:
 *   ┌─────────────┬───┬───────────────┐
 *   │  Header (full width)            │
 *   ├─────────────┬───┬───────────────┤
 *   │             │ ║ │  Terminal      │
 *   │  Chat       │ ║ ├───────────────┤
 *   │  Panel      │ ║ │  Files        │
 *   │             │ ║ │               │
 *   ├─────────────┴───┴───────────────┤
 *   └─────────────────────────────────┘
 *
 * The vertical divider (║) between left/right is draggable.
 * The horizontal divider between terminal/files is draggable.
 */

import { ChatPanel } from './chat-panel.js';
import { TerminalPanel } from './terminal-panel.js';
import { FileBrowserPanel } from './file-browser-panel.js';
import { getApiKey, clearApiKey, clearAzureResource, clearProvider } from './api-key-dialog.js';
import type { ChatMessage } from './types.js';

export interface LayoutPanels {
  chat: ChatPanel;
  terminal: TerminalPanel;
  fileBrowser: FileBrowserPanel;
}

export class Layout {
  private root: HTMLElement;
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private verticalDivider!: HTMLElement;
  private horizontalDivider!: HTMLElement;
  private terminalContainer!: HTMLElement;
  private fileBrowserContainer!: HTMLElement;

  public panels!: LayoutPanels;
  public onModelChange?: (model: string) => void;

  private leftWidth = 0.55; // fraction of total width
  private topHeight = 0.65; // fraction of right panel height

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
  }

  private build(): void {
    this.root.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'header';

    const title = document.createElement('div');
    title.className = 'header__title';
    title.textContent = 'slicc';
    header.appendChild(title);

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
      'padding: 4px 8px; font-size: 13px; cursor: pointer; outline: none; margin: 0 12px;';
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
    header.appendChild(modelSelect);

    const actions = document.createElement('div');
    actions.className = 'header__actions';

    const clearChatBtn = document.createElement('button');
    clearChatBtn.className = 'header__btn';
    clearChatBtn.textContent = 'Clear Chat';
    clearChatBtn.addEventListener('click', async () => {
      await this.panels.chat.clearSession();
      location.reload();
    });
    actions.appendChild(clearChatBtn);

    const clearTermBtn = document.createElement('button');
    clearTermBtn.className = 'header__btn';
    clearTermBtn.textContent = 'Clear Terminal';
    clearTermBtn.addEventListener('click', () => {
      this.panels.terminal.clearTerminal();
    });
    actions.appendChild(clearTermBtn);

    if (__DEV__) {
      const clearFsBtn = document.createElement('button');
      clearFsBtn.className = 'header__btn';
      clearFsBtn.textContent = 'Clear FS';
      clearFsBtn.addEventListener('click', async () => {
        indexedDB.deleteDatabase('virtual-fs');
        try {
          const root = await navigator.storage.getDirectory();
          for await (const name of (root as any).keys()) {
            await (root as any).removeEntry(name, { recursive: true });
          }
        } catch { /* OPFS not available or already empty */ }
        location.reload();
      });
      actions.appendChild(clearFsBtn);

      const copyChatBtn = document.createElement('button');
      copyChatBtn.className = 'header__btn';
      copyChatBtn.textContent = 'Copy Chat';
      copyChatBtn.addEventListener('click', async () => {
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
        copyChatBtn.textContent = 'Copied!';
        setTimeout(() => { copyChatBtn.textContent = 'Copy Chat'; }, 2000);
      });
      actions.appendChild(copyChatBtn);
    }

    const apiKeyBtn = document.createElement('button');
    apiKeyBtn.className = 'header__btn';
    apiKeyBtn.textContent = getApiKey() ? 'API Key ✓' : 'API Key';
    apiKeyBtn.addEventListener('click', () => {
      if (getApiKey()) {
        clearApiKey();
        clearAzureResource();
        clearProvider();
        location.reload();
      }
    });
    actions.appendChild(apiKeyBtn);

    header.appendChild(actions);
    this.root.appendChild(header);

    // Main layout
    const layout = document.createElement('div');
    layout.className = 'layout';

    // Left panel (chat)
    this.leftEl = document.createElement('div');
    this.leftEl.className = 'layout__left';
    layout.appendChild(this.leftEl);

    // Vertical divider
    this.verticalDivider = document.createElement('div');
    this.verticalDivider.className = 'layout__divider';
    layout.appendChild(this.verticalDivider);

    // Right panel (terminal)
    this.rightEl = document.createElement('div');
    this.rightEl.className = 'layout__right';

    this.terminalContainer = document.createElement('div');
    this.terminalContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: none;';
    this.rightEl.appendChild(this.terminalContainer);

    // Horizontal divider (between terminal and file browser)
    this.horizontalDivider = document.createElement('div');
    this.horizontalDivider.className = 'layout__right-divider';
    this.rightEl.appendChild(this.horizontalDivider);

    // File browser container
    this.fileBrowserContainer = document.createElement('div');
    this.fileBrowserContainer.style.cssText = 'display: flex; flex-direction: column; min-height: 0; overflow: hidden; flex: none;';
    this.rightEl.appendChild(this.fileBrowserContainer);

    layout.appendChild(this.rightEl);
    this.root.appendChild(layout);

    // Create panels
    this.panels = {
      chat: new ChatPanel(this.leftEl),
      terminal: new TerminalPanel(this.terminalContainer),
      fileBrowser: new FileBrowserPanel(this.fileBrowserContainer),
    };

    // Apply initial sizes
    this.applySizes();

    // Setup drag handlers
    this.setupVerticalDrag();
    this.setupHorizontalDrag();

    // Handle window resize
    window.addEventListener('resize', () => this.applySizes());
  }

  private applySizes(): void {
    const totalWidth = this.root.clientWidth;
    const dividerW = 4;
    const leftW = Math.round(totalWidth * this.leftWidth);
    const rightW = totalWidth - leftW - dividerW;

    this.leftEl.style.width = leftW + 'px';
    this.rightEl.style.width = rightW + 'px';

    // Horizontal split within right panel
    const rightH = this.rightEl.clientHeight;
    const hDividerH = 4;
    const topH = Math.round(rightH * this.topHeight);
    const bottomH = rightH - topH - hDividerH;

    this.terminalContainer.style.height = topH + 'px';
    this.fileBrowserContainer.style.height = bottomH + 'px';
  }

  private setupVerticalDrag(): void {
    let dragging = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = this.root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.leftWidth = Math.max(0.2, Math.min(0.8, x / rect.width));
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

  /** Dispose the entire layout and its panels. */
  dispose(): void {
    this.panels.chat.dispose();
    this.panels.terminal.dispose();
    this.panels.fileBrowser.dispose();
    // Safe: clearing own root element, not untrusted content
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }
}
