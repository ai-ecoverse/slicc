import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { ITheme, Terminal as TerminalType } from '@xterm/xterm';
// `?raw` so the stylesheet text is injected into THIS component's shadow root —
// xterm's chrome (the `.xterm` rows / viewport / cursor layers) does not pierce
// the shadow boundary, so a global `<link>`/side-effect import would not style
// rows rendered inside the shadow tree. The `*.css?raw` module shape is declared
// in `src/css.d.ts`.
import XTERM_CSS from '@xterm/xterm/css/xterm.css?raw';
import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * Dark xterm theme matching the prototype's one dark terminal surface
 * (`proto/StellarRubySwift.html` `.term`): `#0c0c0e` canvas, light `#e7e7ea`
 * foreground, the prototype's rose prompt / green-ok / muted accents, and the
 * brand-ish ANSI palette (rose `--rose`, cyan `--cyan`, violet `--violet`,
 * amber `--amber`). Kept a literal `ITheme` (not token-driven) because the
 * terminal surface is dark by design in BOTH page themes, exactly like the
 * prototype's `.term`, and xterm needs concrete colors, not CSS vars.
 */
const TERMINAL_THEME: ITheme = {
  background: '#0c0c0e',
  foreground: '#e7e7ea',
  cursor: '#e7e7ea',
  cursorAccent: '#0c0c0e',
  selectionBackground: '#8b5cf64d',
  selectionForeground: '#ffffff',
  black: '#0c0c0e',
  red: '#f43f5e', // --rose
  green: '#5bd17b', // prototype `.term .ok`
  yellow: '#f59e0b', // --amber
  blue: '#3b82f6',
  magenta: '#8b5cf6', // --violet
  cyan: '#06b6d4', // --cyan
  white: '#e7e7ea',
  brightBlack: '#8a8a93', // prototype `.term .mut`
  brightRed: '#fb7185',
  brightGreen: '#86efac',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#a78bfa',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

/** Component chrome (shadow root) — frame + header + the xterm mount host. */
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

/**
 * The xterm chrome (third-party CSS) + component CSS as shared constructable
 * stylesheets, built LAZILY on first connect. Constructing them at module scope
 * would call `new CSSStyleSheet()` at import time and break this module's
 * non-DOM importability (the package barrel / kernel-worker typecheck); building
 * them on the first `#renderChrome` keeps the import side-effect-free while still
 * sharing one pair of sheets across every instance.
 */
let SHEETS: CSSStyleSheet[] | null = null;
function chromeSheets(): CSSStyleSheet[] {
  if (!SHEETS) SHEETS = [sheet(XTERM_CSS), sheet(STYLE)];
  return SHEETS;
}

/**
 * `<slicc-terminal>` — a self-contained xterm.js terminal panel, the reusable
 * extraction of the prototype's one dark shell surface (`proto/.term`) and the
 * webapp's `TerminalPanel` / `AlmostBashShell.mount` setup. It owns the
 * `@xterm/xterm` + `@xterm/addon-fit` lifecycle: the xterm stylesheet is
 * injected into the shadow root (xterm renders inside shadow DOM only if its
 * CSS lives there), the terminal is constructed with the dark prototype theme,
 * and a `ResizeObserver` keeps the buffer fit to the host on every size change.
 *
 * It is a presentation surface, not a shell — there is no command execution.
 * Hosts drive it with the imperative API (`write` / `writeln` / `clear` /
 * `focus`) and observe user keystrokes via the `terminal-data` event, wiring
 * those to whatever backend (a real shell, a websocket, a fixture) they own.
 *
 * The xterm modules are dynamically imported on connect so the module stays
 * importable in non-DOM contexts (the package barrel, kernel-worker typecheck).
 *
 * @attr hide-header - boolean; hides the title bar (terminal fills the frame)
 * @attr label - the header title text (default `Terminal`)
 * @csspart header - the title bar
 * @csspart host - the xterm mount container
 * @fires terminal-data - composed + bubbling `CustomEvent<string>` for each
 *   chunk of user input (xterm `onData`); `detail` is the raw keystroke data
 */
export class SliccTerminal extends HTMLElement {
  static readonly observedAttributes = ['label', 'hide-header'];

  readonly #root: ShadowRoot;
  #hostEl: HTMLElement | null = null;
  #term: TerminalType | null = null;
  #fit: FitAddonType | null = null;
  #ro: ResizeObserver | null = null;
  /** Buffered writes issued before xterm finished loading (async import). */
  #pending: string[] = [];
  /** Guards against a late async open after the element has disconnected. */
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
    // `hide-header` is handled purely by the `:host([hide-header])` CSS rule.
  }

  /** Header title text (default `Terminal`). */
  get label(): string {
    return this.getAttribute('label') ?? 'Terminal';
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Whether the title bar is hidden. */
  get hideHeader(): boolean {
    return this.hasAttribute('hide-header');
  }

  set hideHeader(value: boolean) {
    this.toggleAttribute('hide-header', value);
  }

  /**
   * The live xterm `Terminal`, or `null` before it has loaded / after
   * disconnect. Hosts that need direct xterm features (addons, selection) can
   * reach it, but the imperative methods below cover the common surface.
   */
  get terminal(): TerminalType | null {
    return this.#term;
  }

  /** Write raw data (ANSI escapes included) to the terminal. */
  write(data: string): void {
    if (this.#term) this.#term.write(data);
    else this.#pending.push(data);
  }

  /** Write a line (xterm appends CRLF). */
  writeln(line: string): void {
    if (this.#term) this.#term.writeln(line);
    else this.#pending.push(`${line}\r\n`);
  }

  /** Clear the viewport (keeps the prompt line, like xterm `clear`). */
  clear(): void {
    if (this.#term) this.#term.clear();
    else this.#pending.length = 0;
  }

  /** Focus the terminal so it receives keystrokes. */
  focus(): void {
    this.#term?.focus();
  }

  /** Re-fit the terminal buffer to its current host size. */
  fit(): void {
    this.#fit?.fit();
  }

  /** Render the shadow-root chrome (style + header + mount host). */
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

  /** Load xterm + addon-fit, construct the terminal, and open it. */
  async #ensureTerminal(): Promise<void> {
    if (this.#term || this.#disposed) return;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    // The element may have disconnected while the dynamic imports were in
    // flight — bail rather than open into a detached host.
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

    // Re-emit user keystrokes as a composed/bubbling DOM event so hosts can
    // wire the terminal to any backend without reaching into xterm.
    term.onData((data) => {
      this.dispatchEvent(
        new CustomEvent('terminal-data', { detail: data, bubbles: true, composed: true })
      );
    });

    this.#term = term;
    this.#fit = fit;

    // Initial fit, then flush any writes buffered before the async load.
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

  /** Dispose the terminal, addon, and observer (idempotent). */
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

/** `prefers-reduced-motion: reduce` honored for the (cosmetic) cursor blink. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

define('slicc-terminal', SliccTerminal);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-terminal': SliccTerminal;
  }
}
