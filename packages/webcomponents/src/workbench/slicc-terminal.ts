import type { WTerm } from '@wterm/dom';
import WTERM_CSS from '@wterm/dom/css?raw';
import type { GhosttyCore } from '@wterm/ghostty';
import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { resolveTerminalTheme, watchTerminalThemeScope } from './terminal-theme.js';

function currentTerminalTheme(scope: Element) {
  const { border: _border, ...theme } = resolveTerminalTheme(scope);
  return theme;
}

const STYLE = `
:host {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: 0;
  min-width: 0;
  height: 320px;
  font-family: var(--ui);
  background: var(--term-bg, #0c0c0e);
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
  background: color-mix(in srgb, var(--term-bg, #0c0c0e) 88%, #ffffff);
  border-bottom: 1px solid var(--term-border, #232329);
  font: 500 12px var(--ui, ui-sans-serif, system-ui, sans-serif);
  user-select: none;
}
.hd svg { display: block; color: #8a8a93; }
.hd .title { letter-spacing: -0.01em; }
.hd .spacer { flex: 1 1 auto; }
/* The wterm mount host fills the remaining height. */
.host {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  padding: 8px 0 8px 10px;
  background: var(--term-bg, #0c0c0e);
}
.host.wterm {
  border-radius: 0;
  box-shadow: none;
  outline: none;
  font-family: 'IBM Plex Mono', 'Source Code Pro', 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.25;
}
`;

let SHEETS: CSSStyleSheet[] | null = null;
function chromeSheets(): CSSStyleSheet[] {
  if (!SHEETS) SHEETS = [sheet(WTERM_CSS), sheet(STYLE)];
  return SHEETS;
}

export class SliccTerminal extends HTMLElement {
  static readonly observedAttributes = ['label', 'hide-header'];

  readonly #root: ShadowRoot;
  #hostEl: HTMLElement | null = null;
  #term: WTerm | null = null;
  #core: GhosttyCore | null = null;

  #unwatchTheme: (() => void) | null = null;

  #pending: string[] = [];

  #disposed = false;
  #loadGeneration = 0;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#disposed = false;
    this.#loadGeneration++;
    this.#renderChrome();
    void this.#ensureTerminal().catch((error: unknown) => {
      this.dispatchEvent(
        new CustomEvent('terminal-error', { detail: error, bubbles: true, composed: true })
      );
    });
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

  get terminal(): WTerm | null {
    return this.#term;
  }

  write(data: string): void {
    if (this.#term) this.#term.write(data);
    else this.#pending.push(data);
  }

  writeln(line: string): void {
    if (this.#term) this.#term.write(`${line}\r\n`);
    else this.#pending.push(`${line}\r\n`);
  }

  clear(): void {
    if (this.#term) this.#term.write('\x1b[2J\x1b[H');
    else this.#pending.length = 0;
  }

  focus(): void {
    this.#term?.focus();
  }

  fit(): void {
    if (!this.#term || !this.#hostEl) return;
    const probe = document.createElement('span');
    probe.textContent = 'M';
    this.#hostEl.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    const rowHeight = parseFloat(getComputedStyle(this.#hostEl).fontSize) * 1.25;
    probe.remove();
    if (width > 0 && rowHeight > 0) {
      this.#term.resize(
        Math.max(1, Math.floor(this.#hostEl.clientWidth / width)),
        Math.max(1, Math.floor(this.#hostEl.clientHeight / rowHeight))
      );
    }
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
    const generation = this.#loadGeneration;
    const [{ WTerm }, { GhosttyCore }] = await Promise.all([
      import('@wterm/dom'),
      import('@wterm/ghostty'),
    ]);
    if (this.#disposed || generation !== this.#loadGeneration || !this.#hostEl) return;
    const theme = currentTerminalTheme(this);
    const core = await GhosttyCore.load({
      foregroundColor: theme.foreground,
      backgroundColor: theme.background,
    });
    if (this.#disposed || generation !== this.#loadGeneration || !this.#hostEl) {
      core.dispose();
      return;
    }
    this.#core = core;
    this.#applyTheme();
    const term = new WTerm(this.#hostEl, {
      core,
      cursorBlink: !prefersReducedMotion(),
      onData: (data) =>
        this.dispatchEvent(
          new CustomEvent('terminal-data', { detail: data, bubbles: true, composed: true })
        ),
    });
    try {
      await term.init();
    } catch (error) {
      core.dispose();
      if (this.#core === core) this.#core = null;
      if (this.#disposed || generation !== this.#loadGeneration) return;
      throw error;
    }
    if (this.#disposed || generation !== this.#loadGeneration) {
      term.destroy();
      core.dispose();
      if (this.#core === core) this.#core = null;
      return;
    }
    this.#term = term;
    this.#watchTheme();
    this.fit();
    if (this.#pending.length) {
      for (const chunk of this.#pending) term.write(chunk);
      this.#pending.length = 0;
    }
    this.dispatchEvent(new CustomEvent('terminal-ready', { bubbles: true, composed: true }));
  }

  #teardown(): void {
    this.#disposed = true;
    this.#loadGeneration++;
    this.#unwatchTheme?.();
    this.#unwatchTheme = null;
    this.#term?.destroy();
    this.#core?.dispose();
    this.#term = null;
    this.#core = null;
    this.#pending.length = 0;
  }

  #watchTheme(): void {
    this.#unwatchTheme?.();
    this.#unwatchTheme = watchTerminalThemeScope(this, () => {
      this.#applyTheme();
    });
  }

  #applyTheme(): void {
    if (!this.#hostEl) return;
    const theme = currentTerminalTheme(this);
    const colors = [
      theme.black,
      theme.red,
      theme.green,
      theme.yellow,
      theme.blue,
      theme.magenta,
      theme.cyan,
      theme.white,
      theme.brightBlack,
      theme.brightRed,
      theme.brightGreen,
      theme.brightYellow,
      theme.brightBlue,
      theme.brightMagenta,
      theme.brightCyan,
      theme.brightWhite,
    ];
    this.#hostEl.style.setProperty('--term-bg', theme.background);
    this.#hostEl.style.setProperty('--term-fg', theme.foreground);
    this.#hostEl.style.setProperty('--term-cursor', theme.cursor);
    colors.forEach((color, index) => {
      this.#hostEl?.style.setProperty(`--term-color-${index}`, color);
    });
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
