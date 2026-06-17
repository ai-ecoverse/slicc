import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * One queued message — host-supplied. The list is owned by the host; the
 * component only renders. The most-recently-enqueued item is the **last** in
 * the array (it becomes the front/top card).
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Optional attachment count — shown as a small "+N" hint on the front card. */
  attachments?: number;
}

/**
 * Visual lifted from `slicc-user-message`'s queued state: the `--deep` bubble
 * ground with white text (dark mode flips text to `#0a0a0a` via `:host-context`),
 * the lucide `clock` glyph for the count badge, and the 0.62 dim on dimmed
 * cards. Cards stack with CSS grid (`grid-template-areas: 'card'`) so they all
 * occupy the same cell and the front card defines the container's height;
 * layering is z-index only.
 */
const STYLE = `
:host{display:block;font-family:var(--ui);}
:host(:not([count])),:host([count="0"]),:host([count="-0"]){display:none;}
.wrap{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--txt-3);}
.badge svg{display:block;}
.stack{position:relative;display:grid;grid-template-areas:"card";align-self:stretch;justify-items:end;}
.card{grid-area:card;display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;max-width:80%;background:var(--deep);color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;line-height:1.5;transform-origin:bottom right;will-change:transform;}
.card.is-back{opacity:.62;}
.card.is-deep{opacity:.45;}
.bubble{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;text-overflow:ellipsis;word-break:break-word;}
.attach{flex:0 0 auto;font-size:11px;opacity:.78;align-self:center;font-family:var(--mono);}
.dismiss{flex:0 0 auto;align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;background:transparent;color:inherit;border-radius:50%;cursor:pointer;padding:0;margin:-2px -4px -2px 0;opacity:.78;}
.dismiss:hover,.dismiss:focus-visible{opacity:1;background:color-mix(in srgb,#fff 14%,transparent);outline:none;}
.dismiss svg{display:block;}
:host-context(body.dark) .card,
:host-context(.dark) .card,
:host-context([data-theme="dark"]) .card{color:#0a0a0a;}
:host-context(body.dark) .dismiss:hover,:host-context(body.dark) .dismiss:focus-visible,
:host-context(.dark) .dismiss:hover,:host-context(.dark) .dismiss:focus-visible,
:host-context([data-theme="dark"]) .dismiss:hover,:host-context([data-theme="dark"]) .dismiss:focus-visible{background:color-mix(in srgb,#0a0a0a 14%,transparent);}
`;
const SHEET = sheet(STYLE);

/**
 * Deterministic per-depth transform table for the rotated pile — depth 0 is
 * the front (no rotation/offset, fully legible); deeper cards alternate
 * ±1–3° with small x/y offsets so the pile fans out behind the front card.
 */
const TILT: ReadonlyArray<{ rot: number; x: number; y: number }> = [
  { rot: 0, x: 0, y: 0 },
  { rot: -2, x: -3, y: -2 },
  { rot: 2, x: 3, y: -4 },
  { rot: -3, x: -5, y: -6 },
  { rot: 3, x: 5, y: -8 },
  { rot: -1, x: -2, y: -10 },
  { rot: 1, x: 2, y: -12 },
];

/** Pick the depth-th tilt; deeper than the table simply reuses the deepest entry. */
function tiltFor(depth: number): { rot: number; x: number; y: number } {
  return TILT[Math.min(depth, TILT.length - 1)] ?? TILT[0];
}

/**
 * `<slicc-queued-stack>` — renders a host-owned list of queued messages as a
 * slightly-rotated pile of cards pinned above the composer's input card. The
 * most-recently-enqueued message (the **last** item in the list) is the front
 * card: upright, legible, and the only card with a `×` dismiss button. Older
 * cards fan behind it via z-index plus alternating ±1–3° rotations and small
 * offsets, and are dimmed. The cap is none — N items render N cards.
 *
 * The component is purely presentational: it does not mutate its own list. The
 * dismiss button fires a composed + bubbling `slicc-queued-remove` `CustomEvent`
 * carrying `detail.id` so the host can dequeue. The visual language (the
 * `clock` count badge, the `--deep` bubble, dark-mode `:host-context` flips) is
 * lifted from `slicc-user-message[queued]` so the stack feels native.
 *
 * @attr count - reflected message count (set by `setMessages`); when missing
 *   or `0` the host renders nothing (`display: none`).
 * @csspart stack - the grid container holding all cards.
 * @csspart card - any card (back or front).
 * @csspart front - the front-most card (highest z-index, upright, legible).
 * @csspart badge - the "N queued" count badge with the clock icon.
 * @csspart dismiss - the `×` button on the front card.
 * @fires slicc-queued-remove - `CustomEvent<{ id: string }>` (composed, bubbles)
 *   when the front card's `×` is activated; the component does not dequeue.
 */
export class SliccQueuedStack extends HTMLElement {
  readonly #root: ShadowRoot;
  #items: ReadonlyArray<QueuedMessage> = [];

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  /** Current message count (mirrors the reflected `count` attribute). */
  get count(): number {
    return this.#items.length;
  }

  /**
   * Replace the rendered list. The host owns the queue; this component only
   * renders. The newest item is the **last** in the array — it becomes the
   * front card. Reflects the length to the `count` attribute and re-renders.
   */
  setMessages(items: ReadonlyArray<QueuedMessage>): void {
    this.#items = items.slice();
    this.setAttribute('count', String(this.#items.length));
    this.#render();
  }

  #onDismiss(id: string): void {
    this.dispatchEvent(
      new CustomEvent<{ id: string }>('slicc-queued-remove', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
  }

  #renderCard(item: QueuedMessage, depth: number, isFront: boolean, zIndex: number): HTMLElement {
    const { rot, x, y } = tiltFor(depth);
    const transform = isFront ? 'none' : `translate(${x}px, ${y}px) rotate(${rot}deg)`;
    const dim = depth === 0 ? '' : depth === 1 ? ' is-back' : ' is-deep';
    const cls = `card${isFront ? ' is-front' : ''}${dim}`;
    const part = isFront ? 'card front' : 'card';
    const style = `transform:${transform};z-index:${zIndex};`;
    const children: Array<Node | string> = [h('span', { class: 'bubble' }, item.text)];
    if (item.attachments && item.attachments > 0) {
      children.push(h('span', { class: 'attach' }, `+${item.attachments}`));
    }
    if (isFront) {
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'dismiss',
          part: 'dismiss',
          'aria-label': 'Remove queued message',
        },
        iconEl('x', { size: 14 })
      ) as HTMLButtonElement;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#onDismiss(item.id);
      });
      children.push(btn);
    }
    return h('div', { class: cls, part, style }, ...children);
  }

  #render(): void {
    if (this.#items.length === 0) {
      this.#root.replaceChildren();
      return;
    }
    const total = this.#items.length;
    // Render order doesn't matter for stacking (z-index does), but iterate
    // newest-first so the front card is the first child — handy for `:first-child`
    // selectors and stable test assertions like `querySelector('.card.is-front')`.
    const cards: HTMLElement[] = [];
    for (let i = total - 1; i >= 0; i--) {
      const depth = total - 1 - i;
      const isFront = depth === 0;
      const zIndex = i + 1;
      const item = this.#items[i];
      if (!item) continue;
      cards.push(this.#renderCard(item, depth, isFront, zIndex));
    }
    const stack = h('div', { class: 'stack', part: 'stack' }, ...cards);
    const badge = h(
      'span',
      { class: 'badge', part: 'badge' },
      iconEl('clock', { size: 11 }),
      `${total} queued`
    );
    const wrap = h('div', { class: 'wrap' }, stack, badge);
    this.#root.replaceChildren(wrap);
  }
}

define('slicc-queued-stack', SliccQueuedStack);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-queued-stack': SliccQueuedStack;
  }
}
