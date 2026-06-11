import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-workbench-body>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html` `.wbbody`
 * / `.surface`): the body region of the workbench pane. A `flex: 1; min-height: 0`
 * flex child that becomes the positioning context (`position: relative`) for an
 * absolutely-positioned stack of surface panels — `<slicc-surface>` children, each
 * pinned to `inset: 0`. Only the active surface is shown (the prototype's
 * `.surface.on`); the rest stay `display: none`. `min-height: 0` lets each
 * absolute surface fill the body and scroll internally rather than growing the
 * pane.
 *
 * The show-one logic is owned here: the host stamps the active child with the
 * `active` host class (`.slicc-wbbody__active`) AND reflects an `active` attribute
 * onto that `<slicc-surface>` so the surface element can self-style (`[active]`).
 * The fallback display rules below mean the stack still reads correctly even
 * before the sibling `<slicc-surface>` is registered. Everything is var-driven
 * so dark mode flips via the inherited theme scope — each surface themes itself,
 * so the body needs no explicit dark override.
 */
const STYLE = `
slicc-workbench-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: block;
}
slicc-workbench-body[hidden] {
  display: none;
}
/* Surface stack: each child fills the body; only the active one shows. The
   sibling <slicc-surface> carries its own [active] display rule, but these
   fallbacks keep the show-one behavior correct before it is registered. */
slicc-workbench-body > * {
  position: absolute;
  inset: 0;
  display: none;
}
slicc-workbench-body > .slicc-wbbody__active {
  display: flex;
}
`;

const STYLE_ID = 'slicc-workbench-body-style';

/** Class stamped on the single active surface child (the prototype's `.on`). */
const ACTIVE_CLASS = 'slicc-wbbody__active';

/** Tag the host treats as a surface panel (the prototype's `.surface`). */
const SURFACE_TAG = 'slicc-surface';

/** Inject the scoped workbench-body stylesheet into a document once (idempotent). */
function ensureWorkbenchBodyStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * `<slicc-workbench-body>` — the workbench body / surface stack from the
 * prototype (`.wbbody` hosting `.surface` panels). A `flex: 1; min-height: 0`
 * positioning context for an absolutely-positioned stack of `<slicc-surface>`
 * children, of which exactly one is active at a time (the prototype's
 * `.surface.on`).
 *
 * Light DOM (no shadow root): the host owns no markup of its own — it relocates
 * nothing and simply hosts its `<slicc-surface>` children directly, so the host
 * app can style the body and slot arbitrary surfaces. The show-one logic lives
 * here: `selectSurface(id)` (and the reflected `active` attribute) stamps the
 * matching surface with the `active` host class and mirrors an `active` attribute
 * onto that `<slicc-surface>` element, clearing it from the rest — so the surface
 * can self-style (`slicc-surface[active]`) while the body fallback rules keep the
 * stack correct even before the sibling element is registered.
 *
 * Surfaces are matched by their `surface-id` (the sibling `<slicc-surface>`'s own
 * identity attribute, which it mirrors to `data-s`), falling back to `data-s` or a
 * plain `id`. The host composes `<slicc-surface>` strictly by tag; it never imports
 * the sibling and never reaches into its internals — it only toggles the public
 * `active` attribute (which the surface self-styles on) and a host fallback class.
 *
 * @attr active - the active surface id; reflected. Setting it selects that surface
 * @csspart - (none; the host carries no internal markup)
 * @slot - default; `<slicc-surface>` children, exactly one shown at a time
 * @fires slicc-surface-change - composed + bubbling; `detail.id` / `detail.previous` on a surface change
 */
export class SliccWorkbenchBody extends HTMLElement {
  static readonly observedAttributes = ['active'];

  #connected = false;
  /**
   * Surfaces can mount AFTER their id is already active — a lazy panel
   * (background session restore, a rail launcher clicked before its content
   * loads) would otherwise stay stuck at `display: none` even though it IS
   * the active id, because stamping only ran on `active` changes. Re-stamp
   * on every child-list change instead; `#sync` is idempotent.
   */
  readonly #childObserver = new MutationObserver(() => this.#sync());

  connectedCallback(): void {
    ensureWorkbenchBodyStyle(this.ownerDocument);
    this.#connected = true;
    this.#sync();
    this.#childObserver.observe(this, { childList: true });
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#childObserver.disconnect();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'active' && this.#connected) this.#sync();
  }

  /** The active surface id (reflected). Setting it selects that surface. */
  get active(): string | null {
    return this.getAttribute('active');
  }

  set active(value: string | null) {
    if (value == null) this.removeAttribute('active');
    else this.setAttribute('active', value);
  }

  /** The currently-active `<slicc-surface>` child, or `null` if none is shown. */
  get activeSurface(): HTMLElement | null {
    const id = this.active;
    if (id == null) return null;
    return this.#surfaces().find((s) => this.#surfaceId(s) === id) ?? null;
  }

  /** All `<slicc-surface>` children, in DOM order. */
  get surfaces(): HTMLElement[] {
    return this.#surfaces();
  }

  /**
   * Show the surface whose identity (`surface-id` / `data-s` / `id`) is `id`,
   * hiding the rest. No-ops when the id is already active. Reflects `active`,
   * restamps the active class / `active` attribute across the surfaces, and emits
   * `slicc-surface-change`.
   */
  selectSurface(id: string): void {
    const previous = this.active;
    if (id === previous) return;
    // Reflect first; the attribute change triggers `#sync()` while connected,
    // but call it explicitly so the API works before/while disconnected too.
    this.setAttribute('active', id);
    if (!this.#connected) this.#sync();
    this.dispatchEvent(
      new CustomEvent('slicc-surface-change', {
        bubbles: true,
        composed: true,
        detail: { id, previous },
      })
    );
  }

  /** Collect the `<slicc-surface>` children (by tag), in DOM order. */
  #surfaces(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const child of Array.from(this.children)) {
      if (child instanceof HTMLElement && child.localName === SURFACE_TAG) out.push(child);
    }
    return out;
  }

  /**
   * A surface's identity. Prefers the sibling `<slicc-surface>`'s own
   * `surface-id` attribute (which it mirrors to `data-s` when connected), then
   * `data-s` directly (the prototype key), then a plain `id` — so the host works
   * whether surfaces declare `surface-id`, `data-s`, or `id`.
   */
  #surfaceId(surface: HTMLElement): string | null {
    return surface.getAttribute('surface-id') || surface.getAttribute('data-s') || surface.id;
  }

  /**
   * Reconcile every surface child against the active id: stamp the active class
   * + `active` attribute on the match, clear them from the rest. Idempotent.
   */
  #sync(): void {
    const id = this.active;
    for (const surface of this.#surfaces()) {
      const on = id != null && this.#surfaceId(surface) === id;
      surface.classList.toggle(ACTIVE_CLASS, on);
      surface.toggleAttribute('active', on);
    }
  }
}

define('slicc-workbench-body', SliccWorkbenchBody);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-workbench-body': SliccWorkbenchBody;
  }
}
