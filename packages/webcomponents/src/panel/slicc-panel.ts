import { define } from '../internal/define.js';
import {
  isPanelAnchor,
  type PanelAnchor,
  type PanelMeta,
  type PanelPresentation,
  type PanelSize,
  panelMetaOf,
} from './panel-meta.js';

// Re-exported so `slicc-panel.js` stays the one import site for panel authors,
// while `panel-meta.js` remains importable without a DOM.
export {
  isPanelAnchor,
  type PanelAnchor,
  type PanelMeta,
  type PanelPresentation,
  type PanelSize,
  panelMetaOf,
};

/**
 * Scoped, document-level stylesheet shared by EVERY panel. Panels are light-DOM
 * hosts (see the class doc), so the chrome is injected once into the host
 * document and selected by the `[data-slicc-panel]` marker attribute rather than
 * by tag — one rule set has to cover every subclass tag, including ones the
 * agent registers at runtime.
 *
 * A panel fills whatever slot the layout engine gives it (`flex:1 1 auto`,
 * `min-*:0` so it can shrink inside a flex/grid parent) and is VISIBLE by
 * default. That is the opposite polarity from the older `<slicc-surface>`
 * (hidden until `[active]`), and deliberately so: a surface was one of several
 * stacked panels in a show-one workbench, whereas a panel is placed by the
 * layout — if it is in the tree it should render. Hiding is explicit and uses
 * the native `hidden` attribute so it carries a11y semantics for free (a
 * `display` rule on the host would otherwise beat the UA's `[hidden]` rule,
 * hence the explicit override below).
 */
const STYLE = `
[data-slicc-panel] {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  position: relative;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  font-family: var(--ui);
}
/* Author-set \`display\` on the host would otherwise outrank the UA's
   \`[hidden]{display:none}\`, so restate it. */
[data-slicc-panel][hidden] { display: none; }
/* A floating panel is lifted out of flow so the docked panels do NOT reflow
   around it. \`z-index\` here only orders it against its siblings inside the
   panel host's stacking context — it can never rise above the trusted layer
   (see \`trusted-layer.ts\`), which is the whole point of clamping panels in a
   context of their own. The layout engine sets the offsets; these are the
   fallbacks for a floating panel nobody placed. */
[data-slicc-panel][presentation="floating"] {
  position: absolute;
  z-index: 1;
  flex: 0 0 auto;
  max-width: 100%;
  max-height: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--canvas);
  box-shadow: var(--shadow-pane);
  overflow: hidden;
}
[data-slicc-panel][presentation="floating"][anchor="right"] { top: 0; right: 0; bottom: 0; }
[data-slicc-panel][presentation="floating"][anchor="left"] { top: 0; left: 0; bottom: 0; }
[data-slicc-panel][presentation="floating"][anchor="top"] { top: 0; left: 0; right: 0; }
[data-slicc-panel][presentation="floating"][anchor="bottom"] { bottom: 0; left: 0; right: 0; }
[data-slicc-panel][presentation="floating"][anchor="center"] {
  top: 50%; left: 50%; transform: translate(-50%, -50%);
}
`;

const STYLE_ID = 'slicc-panel-style';

/** Inject the shared panel stylesheet into a document once (idempotent). */
function ensurePanelStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Marker attribute the shared stylesheet keys on (see `STYLE`). */
export const PANEL_MARKER_ATTR = 'data-slicc-panel';

/** Detail of the `slicc-panel-visibility` event. */
export interface PanelVisibilityDetail {
  panelId: string | null;
  visible: boolean;
}

/**
 * `<slicc-panel>` — the common base every SLICC UI panel extends.
 *
 * Chat, the session rail, the dock rail, the scoop switcher, the floatbar, each
 * tool panel and each sprinkle are all panels: movable, resizable, hideable, and
 * describable in a layout JSON document. This class owns only the contract the
 * layout engine drives — identity, visibility, lock state, and lifecycle —
 * leaving content entirely to subclasses.
 *
 * **Light DOM, no shadow root.** Panels are layout/slotting hosts, which the
 * repo convention puts in light DOM (like `slicc-nav`, `slicc-shell`,
 * `slicc-dock-tree`): the host app must be able to style panel regions, and a
 * panel's popovers/menus have to escape its box, which a shadow root plus
 * `overflow` would fight. Subclasses that want encapsulation can still attach
 * their own shadow root to an inner element.
 *
 * **Direct ancestor: `<slicc-surface>`.** A surface was an id plus a visibility
 * flag for the old show-one workbench. A panel is that plus static metadata, a
 * registry entry, lock state, and lifecycle callbacks — and it defaults to
 * visible rather than hidden, because the layout decides what is mounted.
 *
 * **Lifecycle.** The engine calls `onPanelShow` / `onPanelHide` when visibility
 * changes and `onPanelResize` when the slot's box changes, so a panel can start
 * and stop its own pollers instead of the host tracking them centrally. The base
 * class fires `onPanelShow`/`onPanelHide` off the attribute change itself, so a
 * subclass gets them whether visibility was toggled by the engine, by the
 * `visible` setter, or by a raw `hidden` attribute write.
 *
 * `locked` is the runtime lock a Cherry embedder pushes: a locked panel renders
 * no move/resize affordance at all. It restricts the USER, and is unrelated to
 * the sudo gating that restricts the AGENT — see the design doc's two-layer
 * locking model.
 *
 * @attr panel-id - stable id a layout references; falls back to the subclass's `panelMeta.id`
 * @attr hidden - native; hides the panel (prefer the `visible` property)
 * @attr locked - boolean; suppresses move/resize affordances for this panel
 * @attr presentation - `docked` (default) | `floating`; whether the panel takes layout space or paints above it
 * @attr anchor - edge a `floating` panel pins to (`top`/`right`/`bottom`/`left`/`center`)
 * @fires slicc-panel-visibility - composed + bubbling `CustomEvent<PanelVisibilityDetail>` when visibility changes
 * @slot - default; the panel's content, in DOM order
 */
export class SliccPanel extends HTMLElement {
  static readonly observedAttributes = ['panel-id', 'hidden', 'locked', 'presentation', 'anchor'];

  /**
   * Static description of this panel type. The base class leaves it undefined;
   * every registered subclass declares its own. Read through
   * `panelMetaOf(ctor)` rather than directly, so a subclass that forgets it
   * degrades instead of throwing.
   */
  static readonly panelMeta?: PanelMeta;

  #resizeObserver: ResizeObserver | null = null;

  connectedCallback(): void {
    ensurePanelStyle(this.ownerDocument);
    // The shared stylesheet keys on this marker, not on the tag — one rule set
    // must cover every subclass, including runtime-registered ones.
    this.setAttribute(PANEL_MARKER_ATTR, '');
    this.setAttribute('part', 'panel');
    // The floating rules are attribute selectors, so a presentation that came
    // from static `panelMeta` (rather than markup) has to be reflected or the
    // CSS never matches. Reflect only when the attribute is absent, so an
    // explicit layout override always wins.
    if (!this.hasAttribute('presentation')) this.setAttribute('presentation', this.presentation);
    if (!this.hasAttribute('anchor') && this.anchor) this.setAttribute('anchor', this.anchor);
    this.#observeResize();
    // A panel mounted already-visible still deserves its show callback: the
    // engine mounts and reveals in one step, so there is no attribute change to
    // hang it off.
    if (this.visible) this.onPanelShow?.();
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null): void {
    if (!this.isConnected || prev === next) return;
    if (name !== 'hidden') return;
    const visible = this.visible;
    // Visibility itself is CSS-driven (`[data-slicc-panel][hidden]`); the
    // callbacks and the event are the only side effects, so a subclass can
    // start/stop work and a host can react to either source of the change.
    if (visible) this.onPanelShow?.();
    else this.onPanelHide?.();
    this.dispatchEvent(
      new CustomEvent<PanelVisibilityDetail>('slicc-panel-visibility', {
        bubbles: true,
        composed: true,
        detail: { panelId: this.panelId, visible },
      })
    );
  }

  /**
   * This panel's stable id. Prefers the `panel-id` attribute (so one subclass
   * can back several ids — e.g. every sprinkle panel shares an implementation)
   * and falls back to the subclass's static `panelMeta.id`.
   */
  get panelId(): string | null {
    return this.getAttribute('panel-id') ?? panelMetaOf(this.constructor)?.id ?? null;
  }

  set panelId(value: string | null) {
    if (value == null) this.removeAttribute('panel-id');
    else this.setAttribute('panel-id', value);
  }

  /** Whether the panel renders. Inverse of the native `hidden` attribute. */
  get visible(): boolean {
    return !this.hasAttribute('hidden');
  }

  set visible(value: boolean) {
    this.toggleAttribute('hidden', !value);
  }

  /**
   * Whether the panel is locked against user rearrangement — no move handle, no
   * resize divider. Set from a layout document's `locked` flag (tree-wide or
   * per-panel); restricts the user, never the agent.
   */
  get locked(): boolean {
    return this.hasAttribute('locked');
  }

  set locked(value: boolean) {
    this.toggleAttribute('locked', value);
  }

  /**
   * Whether the panel takes layout space (`docked`) or paints above the docked
   * panels without reflowing them (`floating`). Falls back to the subclass's
   * `panelMeta.presentation`, then `docked` — so a panel type can default to
   * floating while a layout still overrides it per placement.
   */
  get presentation(): PanelPresentation {
    const attr = this.getAttribute('presentation');
    if (attr === 'floating' || attr === 'docked') return attr;
    return panelMetaOf(this.constructor)?.presentation ?? 'docked';
  }

  set presentation(value: PanelPresentation) {
    this.setAttribute('presentation', value);
  }

  /** Edge a floating panel pins to. Meaningless while docked. */
  get anchor(): PanelAnchor | null {
    const attr = this.getAttribute('anchor');
    return isPanelAnchor(attr) ? attr : (panelMetaOf(this.constructor)?.anchor ?? null);
  }

  set anchor(value: PanelAnchor | null) {
    if (value == null) this.removeAttribute('anchor');
    else this.setAttribute('anchor', value);
  }

  /** The static metadata of this panel's own type, if it declared any. */
  get meta(): PanelMeta | undefined {
    return panelMetaOf(this.constructor);
  }

  /** Called when the panel becomes visible (or mounts already-visible). */
  onPanelShow?(): void;

  /** Called when the panel becomes hidden. */
  onPanelHide?(): void;

  /** Called when the panel's box changes size. */
  onPanelResize?(rect: DOMRectReadOnly): void;

  /**
   * Wire `onPanelResize` off a `ResizeObserver`, but only when the subclass
   * actually implements it — an observer per panel is not free, and most panels
   * do not care. Guarded for realms without `ResizeObserver` (node tests).
   */
  #observeResize(): void {
    if (!this.onPanelResize || typeof ResizeObserver === 'undefined') return;
    this.#resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) this.onPanelResize?.(rect);
    });
    this.#resizeObserver.observe(this);
  }
}

// Registered so `<slicc-panel>` is usable directly as a plain container (an
// unstyled generic panel, and the fallback for a layout id with no registered
// implementation). Subclasses register their own tags.
define('slicc-panel', SliccPanel);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-panel': SliccPanel;
  }
  interface HTMLElementEventMap {
    'slicc-panel-visibility': CustomEvent<PanelVisibilityDetail>;
  }
}
