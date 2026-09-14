import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';

const STYLE = `
slicc-action-card { display: block; }

/* in-chat tool / terminal / git card (.tcard) */
slicc-action-card .tcard {
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin: 2px 0 18px;
  background: var(--canvas);
}
slicc-action-card .tcard .th {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-family: var(--ui);
  font-size: 11px;
  color: var(--txt-2);
}
slicc-action-card .tcard .th .ic {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  font-size: 10px;
  /* --canvas, not #fff: --ink flips near-white in dark mode. */
  color: var(--canvas, #fff);
  background: var(--ink);
  flex: 0 0 auto;
}
slicc-action-card .tcard .th .ic.cy { background: var(--cyan); }
slicc-action-card .tcard .th .ic.vi { background: var(--violet); }
slicc-action-card .tcard .th .ic.am { background: var(--amber); }
slicc-action-card .tcard .th .ic.gh { background: #1f2328; }
slicc-action-card .tcard .th .nm { color: var(--ink); font-weight: 500; }
slicc-action-card .tcard .th .badge {
  margin-left: auto;
  font-size: 9px;
  border-radius: 26px;
  padding: 1px 8px;
  background: var(--ghost);
  color: var(--txt-2);
}
/* .tb is the whole tool-card terminal body and is meant to wrap slotted output,
   so it intentionally omits the fenced-code "overflow-wrap: normal; word-break:
   normal" reset that slicc-agent-message/slicc-user-message apply to nested
   pre>code. It does not host markdown-rendered fenced code. */
slicc-action-card .tcard .tb {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
  padding: 10px 12px;
  background: #0c0c0e;
  color: #d6d6da;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
}
slicc-action-card .tcard .tb .p { color: #7dd3fc; }
slicc-action-card .tcard .tb .ok { color: #22c55e; }
slicc-action-card .tcard .tb .mut { color: #8a8a92; }
slicc-action-card .tcard .tb .add { color: #22c55e; }
slicc-action-card .tcard .tb .del { color: #f87171; }
slicc-action-card .tcard .tb .warn { color: #fbbf24; }
slicc-action-card .tcard.light .tb { background: var(--canvas); color: var(--ink); }

/* PR card (.prcard) */
slicc-action-card .prcard {
  border: 1px solid var(--line);
  border-radius: 12px;
  margin: 2px 0 18px;
  background: var(--canvas);
  overflow: hidden;
}
slicc-action-card .prcard .ph {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 13px;
  font-family: var(--ui);
}
slicc-action-card .prcard .ph .gi {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: #1f2328;
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 12px;
  flex: 0 0 auto;
}
slicc-action-card .prcard .ph .pt { font-weight: 600; font-size: 13.5px; color: var(--ink); }
slicc-action-card .prcard .ph .pn { font-family: var(--ui); color: var(--txt-3); font-size: 12px; }
slicc-action-card .prcard .ph .open {
  margin-left: auto;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: #1a7f37;
  border-radius: 26px;
  padding: 3px 10px;
}
slicc-action-card .prcard .pmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 0 13px 12px;
  font-family: var(--ui);
  font-size: 11px;
  color: var(--txt-2);
}
slicc-action-card .prcard .pmeta b { color: var(--ink); }
slicc-action-card .prcard .pmeta .add { color: #1a7f37; }
slicc-action-card .prcard .pmeta .del { color: #cf222e; }
`;

const STYLE_ID = 'slicc-action-card-style';

function ensureActionCardStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export type ActionCardVariant = 'tool' | 'light' | 'pr';

export type ActionCardTone = 'ink' | 'cy' | 'vi' | 'am' | 'gh';

const VARIANTS: ReadonlySet<string> = new Set(['tool', 'light', 'pr']);
const TONES: ReadonlySet<string> = new Set(['ink', 'cy', 'vi', 'am', 'gh']);

export class SliccActionCard extends HTMLElement {
  static readonly observedAttributes = [
    'variant',
    'glyph',
    'tone',
    'title',
    'badge',
    'number',
    'status',
    'branch',
    'files',
    'add',
    'del',
    'checks',
  ];

  #slotted: ChildNode[] = [];
  #built = false;

  connectedCallback(): void {
    ensureActionCardStyle(this.ownerDocument);
    this.classList.add('slicc-action-card');
    this.#capture();
    this.#render();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue) return;
    this.#render();
    if (name === 'variant') {
      this.dispatchEvent(
        new CustomEvent('slicc-action-card-change', {
          bubbles: true,
          composed: true,
          detail: { variant: this.variant },
        })
      );
    }
  }

  get variant(): ActionCardVariant {
    const v = this.getAttribute('variant');
    return v && VARIANTS.has(v) ? (v as ActionCardVariant) : 'tool';
  }

  set variant(value: ActionCardVariant) {
    this.setAttribute('variant', VARIANTS.has(value) ? value : 'tool');
  }

  get glyph(): string | null {
    return this.getAttribute('glyph');
  }

  set glyph(value: string | null) {
    if (value == null) this.removeAttribute('glyph');
    else this.setAttribute('glyph', value);
  }

  get tone(): ActionCardTone {
    const t = this.getAttribute('tone');
    return t && TONES.has(t) ? (t as ActionCardTone) : 'ink';
  }

  set tone(value: ActionCardTone) {
    this.setAttribute('tone', TONES.has(value) ? value : 'ink');
  }

  get title(): string {
    return this.getAttribute('title') ?? '';
  }

  set title(value: string | null) {
    if (value == null) this.removeAttribute('title');
    else this.setAttribute('title', value);
  }

  get badge(): string | null {
    return this.getAttribute('badge');
  }

  set badge(value: string | null) {
    if (value == null) this.removeAttribute('badge');
    else this.setAttribute('badge', value);
  }

  get number(): string | null {
    return this.getAttribute('number');
  }

  set number(value: string | null) {
    if (value == null) this.removeAttribute('number');
    else this.setAttribute('number', value);
  }

  get status(): string | null {
    return this.getAttribute('status');
  }

  set status(value: string | null) {
    if (value == null) this.removeAttribute('status');
    else this.setAttribute('status', value);
  }

  get branch(): string | null {
    return this.getAttribute('branch');
  }

  set branch(value: string | null) {
    if (value == null) this.removeAttribute('branch');
    else this.setAttribute('branch', value);
  }

  get files(): string | null {
    return this.getAttribute('files');
  }

  set files(value: string | null) {
    if (value == null) this.removeAttribute('files');
    else this.setAttribute('files', value);
  }

  get add(): string | null {
    return this.getAttribute('add');
  }

  set add(value: string | null) {
    if (value == null) this.removeAttribute('add');
    else this.setAttribute('add', value);
  }

  get del(): string | null {
    return this.getAttribute('del');
  }

  set del(value: string | null) {
    if (value == null) this.removeAttribute('del');
    else this.setAttribute('del', value);
  }

  get checks(): string | null {
    return this.getAttribute('checks');
  }

  set checks(value: string | null) {
    if (value == null) this.removeAttribute('checks');
    else this.setAttribute('checks', value);
  }

  #render(): void {
    const variant = this.variant;
    if (variant === 'pr') this.#renderPr();
    else this.#renderTool(variant === 'light');
  }

  #renderTool(light: boolean): void {
    const glyph = this.glyph;
    const tone = this.tone;
    const title = this.title;
    const badge = this.badge;
    const iconClass = tone === 'ink' ? 'ic' : `ic ${tone}`;

    const header = h('div', { class: 'th', part: 'header' });
    append(header, [
      h('span', { class: iconClass, part: 'icon' }, glyph != null ? glyph : null),

      ' ',
      h('span', { class: 'nm', part: 'title' }, title),
      badge != null ? h('span', { class: 'badge', part: 'badge' }, badge) : null,
    ]);

    const body = h('div', { class: 'tb', part: 'body' });
    body.append(...this.#slotted);

    const cardClass = light ? 'tcard light' : 'tcard';
    const card = h('div', { class: cardClass, part: 'card' }, header, body);

    this.replaceChildren(card);
  }

  #renderPr(): void {
    const title = this.title;
    const number = this.number;
    const status = this.status ?? 'Open';
    const branch = this.branch;
    const files = this.files;
    const add = this.add;
    const del = this.del;
    const checks = this.checks;

    const header = h('div', { class: 'ph', part: 'header' });
    append(header, [
      h('span', { class: 'gi', part: 'icon' }, '⎇'),
      h('span', { class: 'pt', part: 'title' }, title),
      number != null ? h('span', { class: 'pn', part: 'number' }, number) : null,
      h('span', { class: 'open', part: 'status' }, status),
    ]);

    const meta = h('div', { class: 'pmeta', part: 'meta' });

    const metaSlot = this.#slotted.filter(
      (n) => n instanceof HTMLElement && n.getAttribute('slot') === 'meta'
    );

    if (metaSlot.length > 0) {
      meta.append(...metaSlot);
    } else {
      append(meta, [
        branch != null ? h('span', null, branch) : null,
        files != null ? h('span', null, h('b', null, files), ' files') : null,
        add != null ? h('span', { class: 'add' }, `+${add}`) : null,
        del != null ? h('span', { class: 'del' }, `−${del}`) : null,
        checks != null
          ? h('span', null, 'checks ', h('b', { style: 'color:#1a7f37' }, checks))
          : null,
      ]);
    }

    const card = h('div', { class: 'prcard', part: 'card' }, header, meta);
    this.replaceChildren(card);
  }

  #capture(): void {
    if (this.#built) return;
    this.#built = true;
    this.#slotted = Array.from(this.childNodes);
  }
}

define('slicc-action-card', SliccActionCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-action-card': SliccActionCard;
  }
  interface HTMLElementEventMap {
    'slicc-action-card-change': CustomEvent<{ variant: ActionCardVariant }>;
  }
}
