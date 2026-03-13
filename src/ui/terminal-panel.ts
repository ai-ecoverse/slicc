/**
 * Terminal Panel — embedded xterm.js terminal connected to the WasmShell.
 *
 * Wraps the WasmShell's mount/dispose lifecycle and provides
 * a header with a preview toggle button + body container.
 */

import type { WasmShell } from '../shell/index.js';

type TerminalViewId = 'terminal' | 'preview';

export class TerminalPanel {
  private container: HTMLElement;
  private terminalViewEl!: HTMLElement;
  private previewViewEl!: HTMLElement;
  private previewEmptyEl!: HTMLElement;
  private previewBtn!: HTMLButtonElement;
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
    return this.container;
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('terminal-panel');

    // Header bar with preview toggle
    const header = document.createElement('div');
    header.className = 'terminal-panel__header';
    this.container.appendChild(header);

    // Preview icon button (eye icon, S2 outline style)
    this.previewBtn = document.createElement('button');
    this.previewBtn.className = 'terminal-panel__preview-btn';
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
    header.appendChild(this.previewBtn);

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
    this.previewBtn.classList.toggle('terminal-panel__preview-btn--active', view === 'preview');
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
