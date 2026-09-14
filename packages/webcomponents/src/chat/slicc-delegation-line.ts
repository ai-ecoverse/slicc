import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const STYLE = `
:host {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--ui);
  font-size: 12px;
  color: var(--txt-2);
  margin: -4px 0 18px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  transition: background .25s, border-color .25s;
}
:host([source]) {
  /* Mix the source tint over the inherited --canvas (which flips #fff -> dark
     with the theme), so the highlight tracks light/dark automatically without a
     fragile, Chromium-only :host-context() override. */
  background: color-mix(in srgb, var(--c, var(--violet)) 8%, var(--canvas));
  border-color: color-mix(in srgb, var(--c, var(--violet)) 28%, var(--line));
}
/* Slots disappear from layout so their content are direct flex children of the
   host — preserving the prototype's per-chip 8px gap + wrap. */
slot { display: contents; }
.darrow { color: var(--txt-3); flex: 0 0 auto; }
.label { display: contents; }
b { font-weight: 600; }
.scoop { font-weight: 600; }
code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--ghost);
  border-radius: 5px;
  padding: 1px 5px;
  overflow-wrap: anywhere;
  word-break: break-word;
}
`;

const SHEET = sheet(STYLE);

const KINDS = ['feed', 'scoop', 'drop', 'sprinkle'] as const;

export type DelegationKind = (typeof KINDS)[number];

const GLYPH: Record<DelegationKind, string> = {
  feed: 'arrow-right',
  scoop: 'circle-plus',
  drop: 'circle-check',
  sprinkle: 'sparkles',
};

const KIND_VERB: Record<DelegationKind, string> = {
  feed: 'Delegated to',
  scoop: 'Spun up',
  drop: 'Wrapped up',
  sprinkle: '',
};

const ACTION_LABELS: Record<string, string> = {
  feed_scoop: 'Delegated to',
  scoop_scoop: 'Spun up',
  drop_scoop: 'Wrapped up',
  'sprinkle-opened': 'Opened',
};

function humanizeVerb(verb: string): string {
  return ACTION_LABELS[verb] ?? verb;
}

function normalizeKind(value: string | null): DelegationKind {
  return (KINDS as readonly string[]).includes(value ?? '') ? (value as DelegationKind) : 'feed';
}

function parseArgs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class SliccDelegationLine extends HTMLElement {
  static readonly observedAttributes = ['kind', 'hue', 'verb', 'scoop', 'label', 'args', 'source'];

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

  get kind(): DelegationKind {
    return normalizeKind(this.getAttribute('kind'));
  }

  set kind(value: DelegationKind) {
    this.setAttribute('kind', normalizeKind(value));
  }

  get hue(): string | null {
    return this.getAttribute('hue');
  }

  set hue(value: string | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  get verb(): string | null {
    return this.getAttribute('verb');
  }

  set verb(value: string | null) {
    if (value == null) this.removeAttribute('verb');
    else this.setAttribute('verb', value);
  }

  get scoop(): string | null {
    return this.getAttribute('scoop');
  }

  set scoop(value: string | null) {
    if (value == null) this.removeAttribute('scoop');
    else this.setAttribute('scoop', value);
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get args(): string | null {
    return this.getAttribute('args');
  }

  set args(value: string | null) {
    if (value == null) this.removeAttribute('args');
    else this.setAttribute('args', value);
  }

  get source(): boolean {
    return this.hasAttribute('source');
  }

  set source(value: boolean) {
    this.toggleAttribute('source', value);
  }

  #render(): void {
    const kind = this.kind;
    const hue = this.hue;
    const rawVerb = this.verb;
    const verb = rawVerb != null ? humanizeVerb(rawVerb) : KIND_VERB[kind];
    const scoop = this.scoop;
    const label = this.label;
    const args = this.args ? parseArgs(this.args) : [];

    if (hue) this.style.setProperty('--c', hue);
    else this.style.removeProperty('--c');

    const arrowSlot = h('slot', { name: 'arrow' }, iconEl(GLYPH[kind], { size: 13 }));
    const arrowSpan = h('span', { class: 'darrow', part: 'arrow' }, arrowSlot);

    const labelSlot = h('slot', { name: 'label' });
    if (verb) labelSlot.append(h('span', { class: 'verb' }, verb));
    if (scoop) {
      labelSlot.append(
        h('b', { class: 'scoop', part: 'scoop', style: hue ? `color:${hue}` : undefined }, scoop)
      );
    }
    if (label) labelSlot.append(h('span', { class: 'prose' }, label));
    const labelSpan = h('span', { class: 'label', part: 'label' }, labelSlot);

    const argsSlot = h('slot', { name: 'args' });
    for (const a of args) argsSlot.append(h('code', { part: 'code' }, a));

    this.#root.replaceChildren(arrowSpan, labelSpan, argsSlot);
  }
}

define('slicc-delegation-line', SliccDelegationLine);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-delegation-line': SliccDelegationLine;
  }
}
