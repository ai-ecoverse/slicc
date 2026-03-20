/**
 * Terminal Panel — embedded xterm.js terminal connected to the WasmShell.
 *
 * Wraps the WasmShell's mount/dispose lifecycle and provides
 * a header with a preview toggle button + body container.
 */

import type { WasmShell } from '../shell/index.js';

type TerminalViewId = 'terminal' | 'preview';

export interface TerminalPanelOptions {
  onClearTerminal?: () => void;
}

export class TerminalPanel {
  private container: HTMLElement;
  private terminalViewEl!: HTMLElement;
  private previewViewEl!: HTMLElement;
  private previewEmptyEl!: HTMLElement;
  private previewBtn!: HTMLButtonElement;
  private shell: WasmShell | null = null;
  private activeView: TerminalViewId = 'terminal';
  private onClearTerminal: (() => void) | null;

  constructor(container: HTMLElement, options: TerminalPanelOptions = {}) {
    this.container = container;
    this.onClearTerminal = options.onClearTerminal ?? null;
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
    return this.container;
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('terminal-panel');

    // Panel header — "Terminal" title + actions (clear + preview toggle)
    const panelHeader = document.createElement('div');
    panelHeader.className = 'file-browser__header';
    const headerTitle = document.createElement('span');
    headerTitle.className = 'file-browser__header-title';
    headerTitle.textContent = 'Terminal';
    panelHeader.appendChild(headerTitle);

    if (this.onClearTerminal) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'file-browser__header-btn';
      clearBtn.dataset.tooltip = 'Clear Terminal';
      clearBtn.setAttribute('aria-label', 'Clear Terminal');
      clearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="m8.249,15.021c-.4,0-.733-.317-.748-.72l-.25-6.5c-.017-.414.307-.763.72-.778.01-.001.021-.001.03-.001.4,0,.733.317.748.72l.25,6.5c.017.414-.307.763-.72.778-.01.001-.021.001-.03.001Z" fill="currentColor"/><path d="m11.751,15.021c-.01,0-.02,0-.03-.001-.413-.016-.736-.364-.72-.778l.25-6.5c.015-.403.348-.72.748-.72.01,0,.02,0,.03.001.413.016.736.364.72.778l-.25,6.5c-.015.403-.348.72-.748.72Z" fill="currentColor"/><path d="m17,4h-3.5v-.75c0-1.24-1.01-2.25-2.25-2.25h-2.5c-1.24,0-2.25,1.01-2.25,2.25v.75h-3.5c-.414,0-.75.336-.75.75s.336.75.75.75h.52l.422,10.342c.048,1.21,1.036,2.158,2.248,2.158h7.619c1.212,0,2.2-.948,2.248-2.158l.422-10.342h.52c.414,0,.75-.336.75-.75s-.336-.75-.75-.75Zm-9-.75c0-.413.337-.75.75-.75h2.5c.413,0,.75.337.75.75v.75h-4v-.75Zm6.56,12.531c-.017.403-.346.719-.75.719h-7.619c-.404,0-.733-.316-.75-.719l-.42-10.281h9.959l-.42,10.281Z" fill="currentColor"/></svg>';
      clearBtn.addEventListener('click', () => this.onClearTerminal!());
      panelHeader.appendChild(clearBtn);
    }

    // Preview icon button (eye icon, S2 outline style)
    this.previewBtn = document.createElement('button');
    this.previewBtn.className = 'file-browser__header-btn';
    this.previewBtn.setAttribute('aria-label', 'Toggle preview');
    this.previewBtn.dataset.tooltip = 'Preview';
    this.previewBtn.disabled = true;
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    // Eye icon paths
    const path1 = document.createElementNS(svgNs, 'path');
    path1.setAttribute('d', 'M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z');
    svg.appendChild(path1);
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('cx', '10');
    circle.setAttribute('cy', '10');
    circle.setAttribute('r', '2.5');
    svg.appendChild(circle);
    this.previewBtn.appendChild(svg);

    this.previewBtn.addEventListener('click', () => {
      if (this.previewBtn.disabled) return;
      this.setActiveView(this.activeView === 'preview' ? 'terminal' : 'preview');
    });
    panelHeader.appendChild(this.previewBtn);
    this.container.appendChild(panelHeader);

    // Terminal view — direct container, no extra nesting
    this.terminalViewEl = document.createElement('div');
    this.terminalViewEl.className = 'terminal-panel__view';
    this.container.appendChild(this.terminalViewEl);

    // Preview view
    this.previewViewEl = document.createElement('div');
    this.previewViewEl.className = 'terminal-panel__view';
    this.container.appendChild(this.previewViewEl);

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
    this.previewBtn.classList.toggle('file-browser__header-btn--active', view === 'preview');
    this.terminalViewEl.style.display = view === 'terminal' ? 'flex' : 'none';
    this.previewViewEl.style.display = view === 'preview' ? 'flex' : 'none';
    if (view === 'terminal') {
      this.refit();
    }
  }

  private handlePreviewStateChange(hasPreview: boolean): void {
    this.previewBtn.disabled = !hasPreview;
    this.previewEmptyEl.style.display = hasPreview ? 'none' : 'flex';
    if (hasPreview) {
      this.setActiveView('preview');
    } else if (this.activeView === 'preview') {
      this.setActiveView('terminal');
    }
  }
}
