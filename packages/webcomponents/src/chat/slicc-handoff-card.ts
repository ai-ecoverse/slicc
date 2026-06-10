import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
// Renders these child custom elements internally — owns their registration.
import '../primitives/slicc-googly-eyes.js';
import { iconEl } from '../internal/icons.js';

/**
 * Stylesheet body for `<slicc-handoff-card>` (adopted as a shared constructable
 * sheet — see `SHEET` below), lifted verbatim from the prototype's handoff rules
 * (StellarRubySwift.html `.handoff` / `.opened`):
 *
 * - `.handoff` — bordered approval card (`--line` border, `13px` radius).
 * - `.handoff .top` — the flex header row holding the avatar + label.
 * - `.handoff .av` — round violet avatar well (violet-over-`#fff` tint, violet
 *   border) housing the googly eyes; `.av .eyes` lays them out inline.
 * - `.handoff .lbl2` — the `--ui` micro-label; `.pre` is the muted prefix and
 *   `b` the violet bold name.
 * - `.handoff p` — the body paragraph.
 * - `.opened` — the compact ghost-bg pill-card (`--ghost` ground, `11px` radius)
 *   with a rainbow `.sg` glyph chip (a lucide `sparkles` `<svg>`, never an emoji
 *   or unicode symbol) and `--ink` bold target text.
 *
 * Dark mode: the prototype routes the avatar's violet-over-`#fff` tint to
 * violet-over-`var(--canvas)` (`body.dark .handoff .av`). Shadow DOM does not
 * see the ancestor `body.dark` selector, so we re-express that override with
 * `:host-context()` plus the package's `.dark` / `[data-theme="dark"]` scopes.
 * The `.opened` ground is `var(--ghost)`, which the token set already flips in
 * dark mode — no per-element override needed there.
 */
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

/** Shared constructable stylesheet adopted by every instance's shadow root. */
const SHEET = sheet(STYLE);

/** Default micro-label prefix for the handoff approval card. */
const DEFAULT_PRE = 'Handoff request from';

/**
 * `<slicc-handoff-card>` — the SLICC handoff cards from the prototype chat
 * stream. Two presentational variants share one element:
 *
 * - `variant="handoff"` (default) renders `.handoff`: a bordered approval card
 *   with a `.top` header row — a round violet `.av` avatar holding the googly
 *   eyes (`<slicc-googly-eyes>`, composed by tag) beside a `.lbl2` label
 *   (muted `.pre` prefix + violet bold `name`) — over a body paragraph.
 * - `variant="opened"` renders `.opened`: a compact ghost-bg pill-card with a
 *   rainbow `.sg` glyph chip and bold target text — the "X opened Y" receipt.
 *
 * Self-contained shadow DOM; themes via inherited tokens (`--line`, `--violet`,
 * `--ghost`, `--ink`, `--rainbow`, `--ui`, `--txt-2`, `--txt-3`). The avatar's
 * violet tint is routed to `var(--canvas)` in dark mode via `:host-context()`.
 *
 * @attr variant - `handoff` (default) | `opened`; selects which card to render
 * @attr name - the violet bold name (`handoff`) / bold target (`opened`)
 * @attr pre - the muted label prefix (`handoff` only; default "Handoff request from")
 * @attr text - the body paragraph (`handoff`) / receipt suffix after the bold
 *   name (`opened`); falls back to slotted content when absent
 * @attr eyes - `open` (default) | `dead`; forwarded to the avatar's googly eyes
 * @csspart card - the outer card (`.handoff` or `.opened`)
 * @csspart top - the handoff header row (`.handoff .top`)
 * @csspart avatar - the round violet avatar well (`.handoff .av`)
 * @csspart hand - the leading violet hand glyph in the label (`.handoff .lbl2 .hand`)
 * @csspart label - the micro-label (`.handoff .lbl2`)
 * @csspart name - the violet bold name (`handoff`) / bold target (`opened`)
 * @csspart text - the body paragraph (`handoff`) / receipt text (`opened`)
 * @csspart glyph - the rainbow glyph chip (`.opened .sg`)
 * @slot - body content, used when the `text` attribute is absent
 */
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

  /** Which card to render — `opened` selects the receipt pill, else `handoff`. */
  get variant(): 'handoff' | 'opened' {
    return this.getAttribute('variant') === 'opened' ? 'opened' : 'handoff';
  }

  set variant(value: 'handoff' | 'opened') {
    this.setAttribute('variant', value === 'opened' ? 'opened' : 'handoff');
  }

  /** The violet bold name (handoff) / bold target (opened). */
  get name(): string | null {
    return this.getAttribute('name');
  }

  set name(value: string | null) {
    if (value == null) this.removeAttribute('name');
    else this.setAttribute('name', value);
  }

  /** The muted label prefix (handoff variant). */
  get pre(): string | null {
    return this.getAttribute('pre');
  }

  set pre(value: string | null) {
    if (value == null) this.removeAttribute('pre');
    else this.setAttribute('pre', value);
  }

  /** Body text; when absent, slotted content is rendered instead. */
  get text(): string | null {
    return this.getAttribute('text');
  }

  set text(value: string | null) {
    if (value == null) this.removeAttribute('text');
    else this.setAttribute('text', value);
  }

  /** Eye state forwarded to the avatar's `<slicc-googly-eyes>`. */
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

  /** Body node: the `text` attribute as an escaped text node, else a `<slot>`. */
  #bodyChild(): Node {
    const text = this.text;
    return text != null ? document.createTextNode(text) : h('slot');
  }

  #renderHandoff(): void {
    const pre = this.pre ?? DEFAULT_PRE;
    const name = this.name;

    // The round violet avatar well housing the googly eyes (composed by tag).
    const eyes = h('slicc-googly-eyes', { class: 'eyes' });
    if (this.eyes === 'dead') eyes.setAttribute('eyes', 'dead');
    const avatar = h('span', { class: 'av', part: 'avatar' }, eyes);

    // The micro-label: a leading violet hand glyph (the handoff mark), the muted
    // prefix, and the (optional) violet bold name. The glyph is a live lucide
    // `<svg>`, never an emoji or unicode symbol.
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

    // The rainbow glyph chip — a live lucide `sparkles` <svg> (never an emoji).
    const glyph = h(
      'span',
      { class: 'sg', part: 'glyph', 'aria-hidden': 'true' },
      iconEl('sparkles', { size: 12 })
    );

    // Bold target text (when present) followed by the body/slot.
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
