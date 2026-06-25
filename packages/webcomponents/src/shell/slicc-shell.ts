import { define } from '../internal/define.js';
import { readUrlState, writeUrlState } from '../internal/url-state.js';

/**
 * Scoped, document-level stylesheet for `<slicc-shell>`. The top-level split
 * that lays out chat pane | resize divider | workbench | dock and animates the
 * workbench in/out. Light-DOM hosts can't carry an inline `<style>` in a shadow
 * root, so the chrome is injected once and scoped by the `.slicc-shell` host
 * class.
 *
 * Collapsed (default): the chat pane fills the row minus the 48px dock rail and
 * the workbench is `width:0; opacity:0`. Open (`[open]`): the chat pane narrows
 * to `var(--slicc-chat-w, 34%)` and the workbench expands to fill the remaining
 * space. The `--slicc-chat-w` custom property is set by the resize divider's
 * drag logic and persisted in `localStorage` so the user's preferred split
 * survives reloads. Both transition over `.38s cubic-bezier(.4,0,.2,1)`.
 * Children are matched by tag (`slicc-chatpane` / `slicc-workbench-pane` /
 * `slicc-dock`) and by the prototype class names (`.chatpane` / `.workbench` /
 * `.dock`) for plain-markup hosts.
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
.slicc-shell[open] > .chatpane { width: var(--slicc-chat-w, 34%); }
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
  width: calc(100% - 48px - var(--slicc-chat-w, 34%) - 24px);
  margin: 12px;
  opacity: 1;
}
/* Pin the dock to its full 48px basis. This selector outranks the dock's own
   "flex: 0 0 48px" rule, so an "auto" basis here would collapse the rail to its
   ~35px icon-content width and leave a bare-shader strip down the right edge. */
.slicc-shell > slicc-dock,
.slicc-shell > .dock { flex: 0 0 48px; }

/* ── Resize divider ─────────────────────────────────────────────────── */
/* Fully invisible at rest -- the user sees only a col-resize cursor.
   On hover or active drag a 1px accent line fades in. */
.slicc-shell > .slicc-shell__divider {
  display: none;
  width: 0;
  position: relative;
  cursor: col-resize;
  z-index: 2;
  flex: 0 0 0;
  align-self: stretch;
}
.slicc-shell[open] > .slicc-shell__divider { display: block; }
/* Wider invisible hit area (9px) centered on the zero-width divider. */
.slicc-shell > .slicc-shell__divider::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0; left: -4px;
  width: 9px;
}
/* Thin accent line — appears only on hover or active drag. */
.slicc-shell > .slicc-shell__divider::before {
  content: '';
  position: absolute;
  top: 0; bottom: 0; left: 0;
  width: 1px;
  background: var(--line, rgba(128,128,128,0.25));
  opacity: 0;
  transition: opacity .15s ease;
  pointer-events: none;
}
.slicc-shell > .slicc-shell__divider:hover::before { opacity: 1; }
.slicc-shell[dragging] > .slicc-shell__divider::before {
  opacity: 1;
  background: var(--accent, #6366f1);
}
/* Disable transitions during drag for an immediate, responsive feel. */
.slicc-shell[dragging] > slicc-chatpane,
.slicc-shell[dragging] > .chatpane,
.slicc-shell[dragging] > slicc-workbench-pane,
.slicc-shell[dragging] > .workbench { transition: none; }

/* Narrow / extension-sidebar layout: a viewport this thin can't host a
   chat | workbench side-by-side split, so when the workbench opens it becomes a
   full-bleed overlay ON TOP of the (full-width) chat, leaving only the 48px dock
   rail exposed so its icons stay tappable to toggle the workbench closed again. */
@media (max-width: 560px) {
  .slicc-shell { position: relative; }
  .slicc-shell > slicc-chatpane,
  .slicc-shell > .chatpane,
  .slicc-shell[open] > slicc-chatpane,
  .slicc-shell[open] > .chatpane { width: calc(100% - 48px); }
  .slicc-shell[open] > slicc-workbench-pane,
  .slicc-shell[open] > .workbench {
    position: absolute; top: 0; right: 48px; bottom: 0; left: 0;
    width: auto; margin: 0; border-radius: 0; opacity: 1;
    z-index: 5;
    background: var(--bg);
  }
  /* Hide the resize divider on narrow viewports (overlay mode). */
  .slicc-shell > .slicc-shell__divider { display: none !important; }
}
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
 * `<slicc-shell>` — the top-level split shell: a flex row laying out the chat
 * pane, a resize divider, the floating workbench pane, and the right dock rail
 * (composed BY TAG as `<slicc-chatpane>`, `<slicc-workbench-pane>`,
 * `<slicc-dock>`). It orchestrates the open/collapse split: `select(id)` opens
 * the workbench and activates the matching dock item + workbench surface;
 * `collapse()` closes it. It also listens for the dock's bubbling `dock-select`
 * / `dock-collapse` events so clicking a dock icon drives the layout.
 *
 * **Resize**: a draggable divider between the chat and workbench lets the user
 * adjust the split. The position is stored in `localStorage` as the
 * `slicc-shell-chat-w` key and restored on connect. Double-clicking the divider
 * resets to the default 34%/66% split. The divider is hidden on narrow viewports
 * (≤560px) where the workbench is a full-bleed overlay.
 *
 * Light DOM (no shadow root): the host IS the flex row; its children lay out in
 * DOM order. The `open` boolean attribute drives the CSS split and is forwarded
 * as `narrow` to the chat pane and `open` to the workbench pane.
 *
 * @attr open - boolean; expands the workbench (chat narrows to 34%)
 * @attr url-state - boolean; the shell persists the workspace state in the
 *   `ws` URL param (the active surface id while open, cleared on collapse)
 *   and restores it on connect / popstate by driving the dock's selection
 * @csspart shell - the host row (also styleable via the element itself)
 * @slot - default; `<slicc-chatpane>`, `<slicc-workbench-pane>`, `<slicc-dock>` by tag
 * @fires slicc-shell-select - `{ id }`, composed + bubbling, on select()
 * @fires slicc-shell-collapse - composed + bubbling, on collapse()
 */
export class SliccShell extends HTMLElement {
  static readonly observedAttributes = ['open', 'url-state'];

  #onDockSelect: ((e: Event) => void) | null = null;
  #onDockCollapse: (() => void) | null = null;
  #built = false;
  #divider: HTMLElement | null = null;
  /** Persist the workspace state on the canonical dock events (they bubble
   *  through the shell regardless of which layer drives the layout). */
  #onCanonicalSelect = (e: Event): void => {
    if (!this.urlState) return;
    const id = (e as CustomEvent<{ id?: string }>).detail?.id;
    if (typeof id === 'string') writeUrlState('ws', id);
  };
  #onCanonicalCollapse = (): void => {
    if (this.urlState) writeUrlState('ws', null);
  };
  #onPopState = (): void => {
    if (!this.urlState) return;
    const ws = readUrlState('ws');
    if (ws) this.#restoreWorkspace(ws);
    // collapse() (not a bare attribute removal) so the dock unlights too.
    else if (this.open) this.collapse();
  };

  connectedCallback(): void {
    ensureShellStyle(this.ownerDocument);
    this.classList.add('slicc-shell');
    this.setAttribute('part', 'shell');
    this.#built = true;
    this.#insertDivider();
    this.#restoreSavedWidth();
    this.#sync();
    this.#onDockSelect = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id === 'string') this.select(id);
    };
    this.#onDockCollapse = () => this.collapse();
    this.addEventListener('dock-select', this.#onDockSelect);
    this.addEventListener('dock-collapse', this.#onDockCollapse);
    this.addEventListener('slicc-dock-select', this.#onCanonicalSelect);
    this.addEventListener('slicc-dock-collapse', this.#onCanonicalCollapse);
    if (this.urlState) {
      window.addEventListener('popstate', this.#onPopState);
      const ws = readUrlState('ws');
      // Defer one microtask so sibling children (the dock) finish upgrading.
      if (ws) queueMicrotask(() => this.#restoreWorkspace(ws));
    }
  }

  disconnectedCallback(): void {
    if (this.#onDockSelect) this.removeEventListener('dock-select', this.#onDockSelect);
    if (this.#onDockCollapse) this.removeEventListener('dock-collapse', this.#onDockCollapse);
    this.#onDockSelect = null;
    this.#onDockCollapse = null;
    this.removeEventListener('slicc-dock-select', this.#onCanonicalSelect);
    this.removeEventListener('slicc-dock-collapse', this.#onCanonicalCollapse);
    window.removeEventListener('popstate', this.#onPopState);
    this.#divider?.remove();
    this.#divider = null;
  }

  /** Whether this shell persists the workspace state in the `ws` URL param. */
  get urlState(): boolean {
    return this.hasAttribute('url-state');
  }

  set urlState(value: boolean) {
    this.toggleAttribute('url-state', value);
  }

  /**
   * Re-open a URL-restored workspace surface by driving the DOCK's selection
   * — its canonical `slicc-dock-select` is what every host wires, so the
   * surface activation (lazy mounts included) runs exactly like a click.
   */
  #restoreWorkspace(id: string): void {
    const dock = this.dock as (HTMLElement & { selectItem?: (id: string) => void }) | null;
    dock?.selectItem?.(id);
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

  // ── Resize divider ──────────────────────────────────────────────────

  static readonly #STORAGE_KEY = 'slicc-shell-chat-w';
  static readonly #MIN_FRAC = 0.2;
  static readonly #MAX_FRAC = 0.8;
  static readonly #DOCK_PX = 48;

  /**
   * Insert the draggable resize divider between the chatpane and workbench.
   * Idempotent — safe across reconnects.
   */
  #insertDivider(): void {
    if (this.#divider) return;
    const wb = this.workbench;
    if (!wb) return;
    const div = this.ownerDocument.createElement('div');
    div.className = 'slicc-shell__divider';
    div.setAttribute('role', 'separator');
    div.setAttribute('aria-orientation', 'vertical');
    this.insertBefore(div, wb);
    this.#divider = div;
    this.#wireDrag(div);
  }

  /** Restore a previously-persisted chat width from localStorage. */
  #restoreSavedWidth(): void {
    try {
      const saved = localStorage.getItem(SliccShell.#STORAGE_KEY);
      if (saved) this.style.setProperty('--slicc-chat-w', saved);
    } catch {
      // localStorage unavailable (e.g. sandboxed iframe) — use defaults.
    }
  }

  /** Wire pointer-event-based drag-to-resize on the divider element. */
  #wireDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      this.toggleAttribute('dragging', true);

      const onMove = (ev: PointerEvent): void => {
        const rect = this.getBoundingClientRect();
        const available = rect.width - SliccShell.#DOCK_PX;
        if (available <= 0) return;
        const x = ev.clientX - rect.left;
        const frac = Math.max(SliccShell.#MIN_FRAC, Math.min(SliccShell.#MAX_FRAC, x / available));
        this.style.setProperty('--slicc-chat-w', `${(frac * 100).toFixed(1)}%`);
      };

      const onUp = (): void => {
        this.removeAttribute('dragging');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        // Persist the width for next session.
        try {
          const w = this.style.getPropertyValue('--slicc-chat-w');
          if (w) localStorage.setItem(SliccShell.#STORAGE_KEY, w);
        } catch {
          // localStorage unavailable — no persistence, degrade silently.
        }
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    // Double-click resets to the default 34%/66% split.
    handle.addEventListener('dblclick', () => {
      this.style.removeProperty('--slicc-chat-w');
      try {
        localStorage.removeItem(SliccShell.#STORAGE_KEY);
      } catch {
        // best-effort
      }
    });
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
