import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

import '../primitives/slicc-googly-eyes.js';
import { iconEl } from '../internal/icons.js';

const STYLE = `
:host{display:block;font-family:var(--ui);}
:host([hidden]){display:none;}
.handoff{border:1px solid var(--line);border-radius:13px;padding:13px 15px;margin:2px 0 18px;}
.handoff .top{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
.handoff .av{width:26px;height:26px;border-radius:9999px;border:1px solid color-mix(in srgb,var(--violet) 40%,var(--line));display:grid;place-items:center;background:color-mix(in srgb,var(--violet) 14%,#fff);}
.handoff .av .eyes{display:inline-flex;gap:3px;}
.handoff .lbl2{font-family:var(--ui);font-size:11px;color:var(--txt-2);}
.handoff .lbl2 .hand{display:inline-flex;vertical-align:-2px;margin-right:5px;color:var(--violet);}
.handoff .lbl2 .hand svg{display:block;}
.handoff .lbl2 .pre{color:var(--txt-3);}
.handoff .lbl2 b{color:var(--violet);font-weight:600;}
.handoff p{margin:0;font-size:14px;color:var(--ink);}
:host-context(body.dark) .handoff .av,
:host-context(.dark) .handoff .av,
:host-context([data-theme="dark"]) .handoff .av{background:color-mix(in srgb,var(--violet) 24%,var(--canvas));}
.opened{display:flex;align-items:center;gap:9px;border:1px solid var(--line);background:var(--ghost);border-radius:11px;padding:9px 11px;margin:2px 0 18px;font-size:13px;color:var(--txt-2);}
.opened .sg{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;color:#fff;background:var(--rainbow);flex:0 0 auto;}
.opened .sg svg{display:block;}
.opened b{color:var(--ink);font-weight:600;}
`;

const SHEET = sheet(STYLE);

const DEFAULT_PRE = 'Handoff request from';

export class SliccHandoffCard extends HTMLElement {
  static readonly observedAttributes = ['variant', 'name', 'pre', 'text', 'eyes'];

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

  get variant(): 'handoff' | 'opened' {
    return this.getAttribute('variant') === 'opened' ? 'opened' : 'handoff';
  }

  set variant(value: 'handoff' | 'opened') {
    this.setAttribute('variant', value === 'opened' ? 'opened' : 'handoff');
  }

  get name(): string | null {
    return this.getAttribute('name');
  }

  set name(value: string | null) {
    if (value == null) this.removeAttribute('name');
    else this.setAttribute('name', value);
  }

  get pre(): string | null {
    return this.getAttribute('pre');
  }

  set pre(value: string | null) {
    if (value == null) this.removeAttribute('pre');
    else this.setAttribute('pre', value);
  }

  get text(): string | null {
    return this.getAttribute('text');
  }

  set text(value: string | null) {
    if (value == null) this.removeAttribute('text');
    else this.setAttribute('text', value);
  }

  get eyes(): 'open' | 'dead' {
    return this.getAttribute('eyes') === 'dead' ? 'dead' : 'open';
  }

  set eyes(value: 'open' | 'dead') {
    this.setAttribute('eyes', value === 'dead' ? 'dead' : 'open');
  }

  #render(): void {
    if (this.variant === 'opened') this.#renderOpened();
    else this.#renderHandoff();
  }

  #bodyChild(): Node {
    const text = this.text;
    return text != null ? document.createTextNode(text) : h('slot');
  }

  #renderHandoff(): void {
    const pre = this.pre ?? DEFAULT_PRE;
    const name = this.name;

    const eyes = h('slicc-googly-eyes', { class: 'eyes' });
    if (this.eyes === 'dead') eyes.setAttribute('eyes', 'dead');
    const avatar = h('span', { class: 'av', part: 'avatar' }, eyes);

    const hand = h(
      'span',
      { class: 'hand', part: 'hand', 'aria-hidden': 'true' },
      iconEl('hand', { size: 13 })
    );
    const label = h(
      'span',
      { class: 'lbl2', part: 'label' },
      hand,
      h('span', { class: 'pre' }, pre),
      ' ',
      name != null ? h('b', { part: 'name' }, name) : null
    );

    const top = h('div', { class: 'top', part: 'top' }, avatar, label);
    const body = h('p', { part: 'text' }, this.#bodyChild());

    this.#root.replaceChildren(h('div', { class: 'handoff', part: 'card' }, top, body));
  }

  #renderOpened(): void {
    const name = this.name;

    const glyph = h(
      'span',
      { class: 'sg', part: 'glyph', 'aria-hidden': 'true' },
      iconEl('sparkles', { size: 12 })
    );

    const text = h(
      'span',
      { part: 'text' },
      name != null ? h('b', { part: 'name' }, name) : null,
      name != null ? ' ' : null,
      this.#bodyChild()
    );

    this.#root.replaceChildren(h('div', { class: 'opened', part: 'card' }, glyph, text));
  }
}

define('slicc-handoff-card', SliccHandoffCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-handoff-card': SliccHandoffCard;
  }
}
