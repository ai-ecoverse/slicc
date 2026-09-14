import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export interface QueuedMessage {
  id: string;
  text: string;

  attachments?: number;
}

const STYLE = `
:host{display:block;font-family:var(--ui);}
:host(:not([count])),:host([count="0"]),:host([count="-0"]){display:none;}
.wrap{display:flex;flex-direction:column;align-items:stretch;gap:6px;}
.badge{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;font-size:10.5px;color:var(--txt-3);}
.badge svg{display:block;}
.stack{position:relative;display:grid;grid-template-areas:"card";align-self:stretch;justify-items:end;isolation:isolate;}
.card{grid-area:card;display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;max-width:80%;background:var(--deep);color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;line-height:1.5;transform-origin:center;will-change:transform;}
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

const TILT: ReadonlyArray<{ rot: number; x: number; y: number }> = [
  { rot: 0, x: 0, y: 0 },
  { rot: -2, x: -3, y: -2 },
  { rot: 2, x: 3, y: -4 },
  { rot: -3, x: -5, y: -6 },
  { rot: 3, x: 5, y: -8 },
  { rot: -1, x: -2, y: -10 },
  { rot: 1, x: 2, y: -12 },
];

function tiltFor(depth: number): { rot: number; x: number; y: number } {
  return TILT[Math.min(depth, TILT.length - 1)] ?? TILT[0];
}

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

  get count(): number {
    return this.#items.length;
  }

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
    const wrap = h('div', { class: 'wrap' }, badge, stack);
    this.#root.replaceChildren(wrap);
  }
}

define('slicc-queued-stack', SliccQueuedStack);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-queued-stack': SliccQueuedStack;
  }
}
