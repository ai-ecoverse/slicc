import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-shell>`. Lifted from the
 * prototype (`proto/StellarRubySwift.html` `.shell` / `.shell.open`): the
 * top-level split that lays out chat pane | workbench | dock and animates the
 * workbench in/out. Light-DOM hosts can't carry a shadow `<style>`, so the chrome
 * is injected once and scoped by the `.slicc-shell` host class.
 *
 * Collapsed (default): the chat pane fills the row minus the 48px dock rail and
 * the workbench is `width:0; opacity:0`. Open (`[open]`): the chat pane narrows
 * to 34% and the workbench expands to `calc(66% - 72px)` with a 12px margin —
 * the 72px reserve covers the dock + margins. Both transition over the
 * prototype's `.38s cubic-bezier(.4,0,.2,1)`. Children are matched by tag
 * (`slicc-chatpane` / `slicc-workbench-pane` / `slicc-dock`) and by the prototype
 * class names (`.chatpane` / `.workbench` / `.dock`) for plain-markup hosts.
 */
const STYLE = `
.slicc-shell { display: flex; flex: 1; min-height: 0; }
.slicc-shell > slicc-chatpane,
.slicc-shell > .chatpane {
  flex: 0 0 auto;
  width: calc(100% - 48px);
  min-height: 0;
  transition: width .38s cubic-bezier(.4, 0, .2, 1);
}
.slicc-shell[open] > slicc-chatpane,
.slicc-shell[open] > .chatpane { width: 34%; }
.slicc-shell > slicc-workbench-pane,
.slicc-shell > .workbench {
  flex: 0 0 auto;
  width: 0;
  margin: 0;
  opacity: 0;
  overflow: hidden;
  transition: width .38s cubic-bezier(.4, 0, .2, 1), margin .38s cubic-bezier(.4, 0, .2, 1), opacity .28s ease;
}
.slicc-shell[open] > slicc-workbench-pane,
.slicc-shell[open] > .workbench {
  width: calc(66% - 72px);
  margin: 12px;
  opacity: 1;
}
.slicc-shell > slicc-dock,
.slicc-shell > .dock { flex: 0 0 auto; }
`;

const STYLE_ID = 'slicc-shell-style';

/** Inject the scoped shell stylesheet into a document once (idempotent). */
function ensureShellStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Detail for the shell's select/collapse events. */
export interface ShellSelectDetail {
  id: string;
}

/**
 * `<slicc-shell>` — the top-level split shell from the prototype (`.shell`):
 * a flex row laying out the chat pane, the floating workbench pane, and the right
 * dock rail (composed BY TAG as `<slicc-chatpane>`, `<slicc-workbench-pane>`,
 * `<slicc-dock>`). It orchestrates the open/collapse split: `select(id)` opens
 * the workbench and activates the matching dock item + workbench surface;
 * `collapse()` closes it. It also listens for the dock's bubbling `dock-select` /
 * `dock-collapse` events so clicking a dock icon drives the layout.
 *
 * Light DOM (no shadow root): the host IS the flex row; its children lay out in
 * DOM order. The `open` boolean attribute drives the CSS split and is forwarded
 * as `narrow` to the chat pane and `open` to the workbench pane.
 *
 * @attr open - boolean; expands the workbench (chat narrows to 34%)
 * @csspart shell - the host row (also styleable via the element itself)
 * @slot - default; `<slicc-chatpane>`, `<slicc-workbench-pane>`, `<slicc-dock>` by tag
 * @fires slicc-shell-select - `{ id }`, composed + bubbling, on select()
 * @fires slicc-shell-collapse - composed + bubbling, on collapse()
 */
export class SliccShell extends HTMLElement {
  static readonly observedAttributes = ['open'];

  #onDockSelect: ((e: Event) => void) | null = null;
  #onDockCollapse: (() => void) | null = null;
  #built = false;

  connectedCallback(): void {
    ensureShellStyle(this.ownerDocument);
    this.classList.add('slicc-shell');
    this.setAttribute('part', 'shell');
    this.#built = true;
    this.#sync();
    this.#onDockSelect = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id === 'string') this.select(id);
    };
    this.#onDockCollapse = () => this.collapse();
    this.addEventListener('dock-select', this.#onDockSelect);
    this.addEventListener('dock-collapse', this.#onDockCollapse);
  }

  disconnectedCallback(): void {
    if (this.#onDockSelect) this.removeEventListener('dock-select', this.#onDockSelect);
    if (this.#onDockCollapse) this.removeEventListener('dock-collapse', this.#onDockCollapse);
    this.#onDockSelect = null;
    this.#onDockCollapse = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'open' && oldValue !== newValue && this.isConnected) this.#sync();
  }

  /** Whether the workbench is expanded (chat narrowed to 34%). Reflected. */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  /** The composed chat pane, if present. */
  get chatpane(): HTMLElement | null {
    return this.querySelector(':scope > slicc-chatpane, :scope > .chatpane');
  }

  /** The composed workbench pane, if present. */
  get workbench(): HTMLElement | null {
    return this.querySelector(':scope > slicc-workbench-pane, :scope > .workbench');
  }

  /** The composed dock rail, if present. */
  get dock(): HTMLElement | null {
    return this.querySelector(':scope > slicc-dock, :scope > .dock');
  }

  /**
   * Open the workbench and activate the surface/dock item `id`. Forwards to the
   * dock (`selectItem`) and the workbench (`selectSurface`) when they expose the
   * API, then emits `slicc-shell-select`.
   */
  select(id: string): void {
    this.open = true;
    this.#forwardSelect(id);
    this.dispatchEvent(
      new CustomEvent<ShellSelectDetail>('slicc-shell-select', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Collapse the workbench and clear the dock's active state. */
  collapse(): void {
    this.open = false;
    const dock = this.dock as (HTMLElement & { clearActive?: () => void }) | null;
    dock?.clearActive?.();
    this.dispatchEvent(new CustomEvent('slicc-shell-collapse', { bubbles: true, composed: true }));
  }

  /** Forward the open state to the chat pane (`narrow`) + workbench (`open`). */
  #sync(): void {
    if (!this.#built) return;
    const open = this.open;
    this.chatpane?.toggleAttribute('narrow', open);
    this.workbench?.toggleAttribute('open', open);
  }

  #forwardSelect(id: string): void {
    const dock = this.dock as (HTMLElement & { selectItem?: (id: string) => void }) | null;
    dock?.selectItem?.(id);
    const wb = this.workbench as
      | (HTMLElement & { selectSurface?: (id: string) => void; active?: string })
      | null;
    if (wb?.selectSurface) wb.selectSurface(id);
    this.#sync();
  }
}

define('slicc-shell', SliccShell);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-shell': SliccShell;
  }
  interface HTMLElementEventMap {
    'slicc-shell-select': CustomEvent<ShellSelectDetail>;
  }
}
