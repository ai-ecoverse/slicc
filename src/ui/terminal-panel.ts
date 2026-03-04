/**
 * Terminal Panel — embedded xterm.js terminal connected to the WasmShell.
 *
 * Wraps the WasmShell's mount/dispose lifecycle and provides
 * a panel header + body container.
 */

import type { WasmShell } from '../shell/index.js';

export class TerminalPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private shell: WasmShell | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  /** Connect a WasmShell and mount the terminal into this panel. */
  async mountShell(shell: WasmShell): Promise<void> {
    this.shell = shell;
    await shell.mount(this.bodyEl);
  }

  /** Clear the terminal screen. */
  clearTerminal(): void {
    this.shell?.clearTerminal();
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
  }

  /** Dispose the panel and shell. */
  dispose(): void {
    this.shell?.dispose();
    this.container.innerHTML = '';
  }
}
