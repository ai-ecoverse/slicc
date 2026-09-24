import type { WTerm } from '@wterm/dom';
import WTERM_CSS from '@wterm/dom/css?raw';
import type { GhosttyCore } from '@wterm/ghostty';
import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { resolveTerminalTheme, watchTerminalThemeScope } from './terminal-theme.js';

/**
 * Dark terminal theme resolved from theme CSS variables on `scope`. Background /
 * foreground stay locked to the dark terminal surface in BOTH page themes;
 * ANSI / cursor colors follow `--rose` / `--cyan` / `--ctx` etc. so active
 * theme preferences (including scoop/freezer `--ctx` on `.wcui-frame`)
 * propagate. See `terminal-theme.ts`.
 */
function currentTerminalTheme(scope: Element) {
  const { border: _border, ...theme } = resolveTerminalTheme(scope);
  return theme;
}

/** Component chrome (shadow root) — frame + header + the wterm mount host. */
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

/**
 * The wterm chrome (third-party CSS) + component CSS as shared constructable
 * stylesheets, built LAZILY on first connect. Constructing them at module scope
 * would call `new CSSStyleSheet()` at import time and break this module's
 * non-DOM importability (the package barrel / kernel-worker typecheck); building
 * them on the first `#renderChrome` keeps the import side-effect-free while still
 * sharing one pair of sheets across every instance.
 */
let SHEETS: CSSStyleSheet[] | null = null;
function chromeSheets(): CSSStyleSheet[] {
  if (!SHEETS) SHEETS = [sheet(WTERM_CSS), sheet(STYLE)];
  return SHEETS;
}

/**
 * `<slicc-terminal>` — a self-contained wterm terminal panel, the reusable
 * extraction of the prototype's one dark shell surface (`proto/.term`) and the
 * webapp's `TerminalPanel` / `AlmostBashShell.mount` setup. It owns the
 * Ghostty-backed wterm lifecycle. Its stylesheet is injected into the shadow
 * root, and wterm's ResizeObserver fits the buffer to the host.
 *
 * It is a presentation surface, not a shell — there is no command execution.
 * Hosts drive it with the imperative API (`write` / `writeln` / `clear` /
 * `focus`) and observe user keystrokes via the `terminal-data` event, wiring
 * those to whatever backend (a real shell, a websocket, a fixture) they own.
 *
 * The wterm modules are dynamically imported on connect so the module stays
 * importable in non-DOM contexts (the package barrel, kernel-worker typecheck).
 *
 * @attr hide-header - boolean; hides the title bar (terminal fills the frame)
 * @attr label - the header title text (default `Terminal`)
 * @csspart header - the title bar
 * @csspart host - the wterm mount container
 * @fires terminal-data - composed + bubbling `CustomEvent<string>` for each
 *   chunk of user input (wterm `onData`); `detail` is the raw keystroke data
 * @fires terminal-ready - emitted after the WASM core initializes and queued writes flush
 * @fires terminal-error - emitted if the WASM core cannot initialize
 */
export class SliccTerminal extends HTMLElement {
  static readonly observedAttributes = ['label', 'hide-header'];

  readonly #root: ShadowRoot;
  #hostEl: HTMLElement | null = null;
  #term: WTerm | null = null;
  #core: GhosttyCore | null = null;
  /** Disconnects theme-scope observers (html / body / `.wcui-frame`). */
  #unwatchTheme: (() => void) | null = null;
  /** Buffered writes issued before wterm finished loading (async import/WASM). */
  #pending: string[] = [];
  /** Guards against a late async open after the element has disconnected. */
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
   * The live wterm instance, or `null` before load / after disconnect.
   */
  get terminal(): WTerm | null {
    return this.#term;
  }

  /** Write raw data (ANSI escapes included) to the terminal. */
  write(data: string): void {
    if (this.#term) this.#term.write(data);
    else this.#pending.push(data);
  }

  /** Write a line with CRLF. */
  writeln(line: string): void {
    if (this.#term) this.#term.write(`${line}\r\n`);
    else this.#pending.push(`${line}\r\n`);
  }

  /** Clear the viewport and move the cursor home. */
  clear(): void {
    if (this.#term) this.#term.write('\x1b[2J\x1b[H');
    else this.#pending.length = 0;
  }

  /** Focus the terminal so it receives keystrokes. */
  focus(): void {
    this.#term?.focus();
  }

  /** Re-fit the terminal buffer to its current host size. */
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

  /** Load wterm + Ghostty, construct the terminal, and open it. */
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

  /** Dispose the terminal and WASM core (idempotent). */
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

  /**
   * Re-resolve ANSI accents when the page theme flips or the shell frame's
   * scoped `--ctx` changes (`applyShellContext`). Background stays dark.
   */
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
