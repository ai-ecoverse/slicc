import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { ITheme, Terminal as TerminalType } from '@xterm/xterm';

import XTERM_CSS from '@xterm/xterm/css/xterm.css?raw';
import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const TERMINAL_THEME: ITheme = {
  background: '#0c0c0e',
  foreground: '#e7e7ea',
  cursor: '#e7e7ea',
  cursorAccent: '#0c0c0e',
  selectionBackground: '#8b5cf64d',
  selectionForeground: '#ffffff',
  black: '#0c0c0e',
  red: '#f43f5e',
  green: '#5bd17b',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#8b5cf6',
  cyan: '#06b6d4',
  white: '#e7e7ea',
  brightBlack: '#8a8a93',
  brightRed: '#fb7185',
  brightGreen: '#86efac',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#a78bfa',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

const STYLE = `
:host {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: 0;
  min-width: 0;
  height: 320px;
  font-family: var(--ui);
  background: #0c0c0e;
  border-radius: 12px;
  overflow: hidden;
}
:host([hide-header]) .hd { display: none; }
* { box-sizing: border-box; }
.hd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 12px;
  color: #c9c9d2;
  background: #141418;
  border-bottom: 1px solid #232329;
  font: 500 12px var(--ui, ui-sans-serif, system-ui, sans-serif);
  user-select: none;
}
.hd svg { display: block; color: #8a8a93; }
.hd .title { letter-spacing: -0.01em; }
.hd .spacer { flex: 1 1 auto; }
/* The xterm mount host fills the remaining height; xterm paints into it. */
.host {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  padding: 8px 0 8px 10px;
  background: #0c0c0e;
}
/* xterm.js wants its container to size the canvas; let it fill. */
.host .xterm { height: 100%; }
.host .xterm-viewport { overflow-y: auto; }
`;

let SHEETS: CSSStyleSheet[] | null = null;
function chromeSheets(): CSSStyleSheet[] {
  if (!SHEETS) SHEETS = [sheet(XTERM_CSS), sheet(STYLE)];
  return SHEETS;
}

export class SliccTerminal extends HTMLElement {
  static readonly observedAttributes = ['label', 'hide-header'];

  readonly #root: ShadowRoot;
  #hostEl: HTMLElement | null = null;
  #term: TerminalType | null = null;
  #fit: FitAddonType | null = null;
  #ro: ResizeObserver | null = null;

  #pending: string[] = [];

  #disposed = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#disposed = false;
    this.#renderChrome();
    void this.#ensureTerminal();
  }

  disconnectedCallback(): void {
    this.#teardown();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === 'label') {
      const title = this.#root.querySelector('.title');
      if (title) title.textContent = this.label;
    }
  }

  get label(): string {
    return this.getAttribute('label') ?? 'Terminal';
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get hideHeader(): boolean {
    return this.hasAttribute('hide-header');
  }

  set hideHeader(value: boolean) {
    this.toggleAttribute('hide-header', value);
  }

  get terminal(): TerminalType | null {
    return this.#term;
  }

  write(data: string): void {
    if (this.#term) this.#term.write(data);
    else this.#pending.push(data);
  }

  writeln(line: string): void {
    if (this.#term) this.#term.writeln(line);
    else this.#pending.push(`${line}\r\n`);
  }

  clear(): void {
    if (this.#term) this.#term.clear();
    else this.#pending.length = 0;
  }

  focus(): void {
    this.#term?.focus();
  }

  fit(): void {
    this.#fit?.fit();
  }

  #renderChrome(): void {
    if (this.#hostEl) return;
    this.#root.adoptedStyleSheets = chromeSheets();
    const header = h(
      'div',
      { class: 'hd', part: 'header' },
      iconEl('terminal', { size: 14 }),
      h('span', { class: 'title' }, this.label),
      h('span', { class: 'spacer' })
    );
    const host = h('div', { class: 'host', part: 'host' });
    this.#root.replaceChildren(header, host);
    this.#hostEl = host;
  }

  async #ensureTerminal(): Promise<void> {
    if (this.#term || this.#disposed) return;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);

    if (this.#disposed || !this.#hostEl) return;

    const term = new Terminal({
      cursorBlink: !prefersReducedMotion(),
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: "'IBM Plex Mono', 'Source Code Pro', 'JetBrains Mono', ui-monospace, monospace",
      theme: TERMINAL_THEME,
      convertEol: true,
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.#hostEl);

    term.onData((data) => {
      this.dispatchEvent(
        new CustomEvent('terminal-data', { detail: data, bubbles: true, composed: true })
      );
    });

    this.#term = term;
    this.#fit = fit;

    fit.fit();
    if (this.#pending.length) {
      for (const chunk of this.#pending) term.write(chunk);
      this.#pending.length = 0;
    }

    if (typeof ResizeObserver === 'function') {
      this.#ro = new ResizeObserver(() => this.#fit?.fit());
      this.#ro.observe(this.#hostEl);
    }
  }

  #teardown(): void {
    this.#disposed = true;
    this.#ro?.disconnect();
    this.#ro = null;
    this.#term?.dispose();
    this.#term = null;
    this.#fit = null;
    this.#pending.length = 0;
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

define('slicc-terminal', SliccTerminal);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-terminal': SliccTerminal;
  }
}
