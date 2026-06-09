import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/**
 * Shared constructable stylesheet, lifted verbatim from the prototype's chat rules:
 *
 * - `.msg` — the message row metrics (`margin-bottom`, `line-height`).
 * - `.msg.user` — flex row, right-aligned (`justify-content:flex-end`).
 * - `.msg.user .b` — the inverted iMessage bubble: `--deep` ground, white text,
 *   asymmetric `16px 16px 4px 16px` radius, capped at 80% of the column.
 *
 * Dark mode: the prototype flips `--deep` to a near-white in `body.dark`, so the
 * bubble text is overridden to `#0a0a0a` to stay readable. Shadow DOM does not
 * see the ancestor `body.dark` selector, so we re-express that override with
 * `:host-context()` plus the package's `.dark` / `[data-theme="dark"]` scopes.
 */
const STYLE = `
:host{display:block;margin-bottom:18px;font-family:var(--ui);font-size:15px;line-height:1.5;}
:host([hidden]){display:none;}
.msg{display:flex;justify-content:flex-end;}
.b{background:var(--deep);color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;max-width:80%;}
:host-context(body.dark) .b,
:host-context(.dark) .b,
:host-context([data-theme="dark"]) .b{color:#0a0a0a;}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-user-message>` — the user's chat bubble from the prototype
 * (`.msg.user > .b`). An inverted iMessage-style bubble: a `--deep` ground with
 * white text, an asymmetric `16px 16px 4px 16px` radius, capped at 80% of the
 * column and right-aligned by the host's flex row. Static presentation — the
 * message text comes from the `text` attribute, or from slotted content when the
 * attribute is absent.
 *
 * Self-contained shadow DOM; themes via inherited tokens (`--deep`, `--ui`). In
 * dark mode the prototype flips `--deep` toward white, so the bubble text is
 * overridden to `#0a0a0a` to keep the inverted look readable.
 *
 * @attr text - the bubble message text (escaped); falls back to slotted content
 * @csspart message - the flex row wrapper (`.msg.user`)
 * @csspart bubble - the bubble (`.b`)
 * @slot - bubble content, used when the `text` attribute is absent
 */
export class SliccUserMessage extends HTMLElement {
  static readonly observedAttributes = ['text'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Bubble message text; when absent, slotted content is rendered instead. */
  get text(): string | null {
    return this.getAttribute('text');
  }

  set text(value: string | null) {
    if (value == null) this.removeAttribute('text');
    else this.setAttribute('text', value);
  }

  #render(): void {
    const text = this.text;
    const body: Node | string = text != null ? text : h('slot');
    const bubble = h('div', { class: 'b', part: 'bubble' }, body);
    const row = h('div', { class: 'msg user', part: 'message' }, bubble);
    this.#root.replaceChildren(row);
  }
}

define('slicc-user-message', SliccUserMessage);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-user-message': SliccUserMessage;
  }
}
