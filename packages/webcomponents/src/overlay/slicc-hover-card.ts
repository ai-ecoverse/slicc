import { define } from '../internal/define.js';
import { sheet } from '../internal/dom.js';

/** Which side of the anchor the card ended up on. */
export type HoverCardPlacement = 'below' | 'above';

/** A rectangle in viewport coordinates — the subset of `DOMRect` placement reads. */
export interface HoverCardRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/** Where the card goes, in viewport pixels. */
export interface HoverCardPosition {
  top: number;
  left: number;
  placement: HoverCardPlacement;
}

/** Gap between the anchor and the card, and the card and the viewport edge. */
const GAP = 6;
const EDGE = 8;

/**
 * Place a card of `card` size next to `anchor` inside `viewport`.
 *
 * Below is preferred because it is where the eye is already moving when it
 * reads a line of prose; the card flips above only when below would clip AND
 * above has more room. Horizontally it starts at the anchor's left edge (a
 * hover card for a word should sit under that word, not centred on it) and is
 * clamped so it never leaves the viewport.
 */
export function placeHoverCard(
  anchor: HoverCardRect,
  card: { width: number; height: number },
  viewport: { width: number; height: number }
): HoverCardPosition {
  const spaceBelow = viewport.height - anchor.bottom - GAP - EDGE;
  const spaceAbove = anchor.top - GAP - EDGE;
  const placement: HoverCardPlacement =
    card.height > spaceBelow && spaceAbove > spaceBelow ? 'above' : 'below';
  const rawTop = placement === 'below' ? anchor.bottom + GAP : anchor.top - GAP - card.height;
  const maxTop = Math.max(EDGE, viewport.height - card.height - EDGE);
  const top = Math.min(Math.max(EDGE, rawTop), maxTop);
  const maxLeft = Math.max(EDGE, viewport.width - card.width - EDGE);
  const left = Math.min(Math.max(EDGE, anchor.left), maxLeft);
  return { top, left, placement };
}

const STYLE = `
:host{
  position:fixed;top:0;left:0;z-index:70;
  display:none;
  max-width:min(360px,calc(100vw - 16px));
  box-sizing:border-box;
  background:var(--canvas,#fff);color:var(--ink,#111);
  border:1px solid color-mix(in srgb,var(--ink,#111) 12%,transparent);
  border-radius:12px;
  box-shadow:0 12px 32px -12px rgba(10,10,10,.35),0 2px 6px -2px rgba(10,10,10,.12);
  font:13px/1.4 var(--ui,ui-sans-serif,system-ui,sans-serif);
  overflow:hidden;
  opacity:0;transform:translateY(-2px);
  transition:opacity .12s ease,transform .12s ease;
}
:host([open]){display:block;}
:host([data-shown]){opacity:1;transform:none;}
:host([data-placement="above"]){transform:translateY(2px);}
:host([data-placement="above"][data-shown]){transform:none;}
@media (prefers-reduced-motion: reduce){:host{transition:none;}}
`;
const SHEET = sheet(STYLE);

/** How long the pointer may be away from anchor AND card before it closes. */
const DEFAULT_HIDE_DELAY_MS = 180;

/**
 * `<slicc-hover-card>` — a floating card anchored to an element, for previews
 * that appear on hover (a link's `og:image`, a date's calendar, a question's
 * answer controls).
 *
 * One instance serves a whole surface: callers ask for {@link SliccHoverCard.shared}
 * and hand it an anchor plus the content to show. Owning the singleton here
 * rather than per-anchor means only one card is ever open, and moving from one
 * anchor to the next swaps content instead of stacking cards.
 *
 * The card stays open while the pointer is over it, so its content can be
 * interactive (buttons, an input). Leaving both the anchor and the card starts
 * a short close timer; re-entering either cancels it. `Escape` closes it.
 *
 * Content is slotted light DOM, so each content element brings its own shadow
 * styles; the card supplies only the chrome and the placement.
 *
 * @attr open - the card is visible
 * @fires hover-card-close - after the card closes (composed, bubbling)
 */
export class SliccHoverCard extends HTMLElement {
  static #shared: SliccHoverCard | null = null;

  /**
   * The document-wide card, created and attached to `<body>` on first use.
   * Recreated when a previous one was removed from the DOM.
   */
  static shared(doc: Document = document): SliccHoverCard {
    const existing = SliccHoverCard.#shared;
    if (existing?.isConnected && existing.ownerDocument === doc) return existing;
    const card = doc.createElement('slicc-hover-card') as SliccHoverCard;
    doc.body.append(card);
    SliccHoverCard.#shared = card;
    return card;
  }

  #anchor: Element | null = null;
  #hideTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hide();
  };
  readonly #onReflow = (): void => {
    if (this.#anchor?.isConnected) this.#position();
    else this.hide();
  };

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [SHEET];
    root.append(document.createElement('slot'));
    this.addEventListener('pointerenter', () => this.cancelHide());
    this.addEventListener('pointerleave', () => this.scheduleHide());
    this.addEventListener('focusin', () => this.cancelHide());
  }

  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'dialog');
  }

  disconnectedCallback(): void {
    this.#detachGlobal();
    this.#clearTimer();
  }

  /** The element the card is currently anchored to. */
  get anchor(): Element | null {
    return this.#anchor;
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }

  /**
   * Show `content` next to `anchor`. Passing the anchor that is already shown
   * with `content === null` just keeps the card open.
   */
  showFor(anchor: Element, content: Node | null): void {
    this.cancelHide();
    if (content) this.replaceChildren(content);
    this.#anchor = anchor;
    const wasOpen = this.open;
    this.setAttribute('open', '');
    this.#position();
    if (!wasOpen) {
      this.#attachGlobal();
      // A frame later, so the entry transition runs from the hidden state.
      requestAnimationFrame(() => {
        if (this.open) this.setAttribute('data-shown', '');
      });
    }
  }

  /** Re-measure after the content changed size (an image loaded, data arrived). */
  reposition(): void {
    if (this.open) this.#position();
  }

  /** Close after `delay` ms unless something cancels it first. */
  scheduleHide(delay: number = DEFAULT_HIDE_DELAY_MS): void {
    this.#clearTimer();
    this.#hideTimer = setTimeout(() => this.hide(), delay);
  }

  cancelHide(): void {
    this.#clearTimer();
  }

  hide(): void {
    this.#clearTimer();
    if (!this.open) return;
    this.removeAttribute('open');
    this.removeAttribute('data-shown');
    this.#anchor = null;
    this.replaceChildren();
    this.#detachGlobal();
    this.dispatchEvent(new CustomEvent('hover-card-close', { bubbles: true, composed: true }));
  }

  #position(): void {
    const anchor = this.#anchor;
    if (!anchor) return;
    const view = this.ownerDocument.defaultView;
    const pos = placeHoverCard(
      anchor.getBoundingClientRect(),
      { width: this.offsetWidth, height: this.offsetHeight },
      { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 }
    );
    this.style.top = `${pos.top}px`;
    this.style.left = `${pos.left}px`;
    this.setAttribute('data-placement', pos.placement);
  }

  #clearTimer(): void {
    if (this.#hideTimer !== null) clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }

  #attachGlobal(): void {
    const view = this.ownerDocument.defaultView;
    this.ownerDocument.addEventListener('keydown', this.#onKey);
    // Capture: the transcript scrolls inside its own container, not the window.
    view?.addEventListener('scroll', this.#onReflow, true);
    view?.addEventListener('resize', this.#onReflow);
  }

  #detachGlobal(): void {
    const view = this.ownerDocument.defaultView;
    this.ownerDocument.removeEventListener('keydown', this.#onKey);
    view?.removeEventListener('scroll', this.#onReflow, true);
    view?.removeEventListener('resize', this.#onReflow);
  }
}

define('slicc-hover-card', SliccHoverCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-hover-card': SliccHoverCard;
  }
}
