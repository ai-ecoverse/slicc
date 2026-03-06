/**
 * Terminal Panel — embedded xterm.js terminal connected to the WasmShell.
 *
 * Wraps the WasmShell's mount/dispose lifecycle and provides
 * a panel header + body container.
 */

import type { WasmShell } from '../shell/index.js';

type TerminalViewId = 'terminal' | 'preview';

export class TerminalPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private terminalViewEl!: HTMLElement;
  private previewViewEl!: HTMLElement;
  private previewEmptyEl!: HTMLElement;
  private terminalTabBtn!: HTMLButtonElement;
  private previewTabBtn!: HTMLButtonElement;
  private shell: WasmShell | null = null;
  private activeView: TerminalViewId = 'terminal';

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  /** Connect a WasmShell and mount the terminal into this panel. */
  async mountShell(shell: WasmShell): Promise<void> {
    this.shell?.setPreviewStateListener(null);
    this.shell = shell;

    const mountEl = document.createElement('div');
    mountEl.className = 'terminal-panel__mount';
    this.terminalViewEl.appendChild(mountEl);

    await shell.mount(mountEl);

    const terminalHost = mountEl.querySelector<HTMLElement>('.terminal-panel__terminal-host');
    const previewHost = mountEl.querySelector<HTMLElement>('.terminal-panel__preview');
    if (!terminalHost || !previewHost) {
      throw new Error('terminal mount did not create expected hosts');
    }

    this.terminalViewEl.replaceChildren(terminalHost);
    this.previewViewEl.appendChild(previewHost);

    shell.setPreviewStateListener((hasPreview) => this.handlePreviewStateChange(hasPreview));
  }

  /** Clear the terminal screen. */
  clearTerminal(): void {
    this.shell?.clearTerminal();
  }

  /** Execute a command and render it in the terminal. */
  async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.shell) {
      return {
        stdout: '',
        stderr: 'terminal is unavailable\n',
        exitCode: 1,
      };
    }
    if (!/^\s*imgcat(?:\s|$)/.test(command)) {
      this.setActiveView('terminal');
    }
    return this.shell.executeCommandInTerminal(command);
  }

  /** Re-fit the terminal to its container (needed after tab switch). */
  refit(): void {
    this.shell?.refit();
  }

  /** Get the body element (for direct terminal mounting). */
  getBodyElement(): HTMLElement {
    return this.bodyEl;
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('terminal-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.textContent = 'Terminal';
    this.container.appendChild(header);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'terminal-panel__body';
    this.container.appendChild(this.bodyEl);

    const tabs = document.createElement('div');
    tabs.className = 'mini-tabs';
    this.bodyEl.appendChild(tabs);

    this.terminalTabBtn = document.createElement('button');
    this.terminalTabBtn.className = 'mini-tabs__tab mini-tabs__tab--active';
    this.terminalTabBtn.textContent = 'Terminal';
    this.terminalTabBtn.addEventListener('click', () => this.setActiveView('terminal'));
    tabs.appendChild(this.terminalTabBtn);

    this.previewTabBtn = document.createElement('button');
    this.previewTabBtn.className = 'mini-tabs__tab';
    this.previewTabBtn.textContent = 'Preview';
    this.previewTabBtn.disabled = true;
    this.previewTabBtn.addEventListener('click', () => {
      if (!this.previewTabBtn.disabled) this.setActiveView('preview');
    });
    tabs.appendChild(this.previewTabBtn);

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'terminal-panel__content';
    this.bodyEl.appendChild(this.contentEl);

    this.terminalViewEl = document.createElement('div');
    this.terminalViewEl.className = 'terminal-panel__view';
    this.contentEl.appendChild(this.terminalViewEl);

    this.previewViewEl = document.createElement('div');
    this.previewViewEl.className = 'terminal-panel__view';
    this.contentEl.appendChild(this.previewViewEl);

    this.previewEmptyEl = document.createElement('div');
    this.previewEmptyEl.className = 'terminal-panel__empty-state';
    this.previewEmptyEl.textContent = 'Run imgcat to preview media here.';
    this.previewViewEl.appendChild(this.previewEmptyEl);

    this.setActiveView('terminal');
  }

  /** Dispose the panel and shell. */
  dispose(): void {
    this.shell?.setPreviewStateListener(null);
    this.shell?.dispose();
    this.container.innerHTML = '';
  }

  private setActiveView(view: TerminalViewId): void {
    this.activeView = view;
    this.terminalTabBtn.classList.toggle('mini-tabs__tab--active', view === 'terminal');
    this.previewTabBtn.classList.toggle('mini-tabs__tab--active', view === 'preview');
    this.terminalViewEl.style.display = view === 'terminal' ? 'flex' : 'none';
    this.previewViewEl.style.display = view === 'preview' ? 'flex' : 'none';
    if (view === 'terminal') {
      this.refit();
    }
  }

  private handlePreviewStateChange(hasPreview: boolean): void {
    this.previewTabBtn.disabled = !hasPreview;
    this.previewEmptyEl.style.display = hasPreview ? 'none' : 'flex';
    if (hasPreview) {
      this.setActiveView('preview');
    } else if (this.activeView === 'preview') {
      this.setActiveView('terminal');
    }
  }
}
