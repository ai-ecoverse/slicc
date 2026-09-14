import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

export type MemtagType = 'user' | 'feedback' | 'project';

const TYPES = new Set<string>(['user', 'feedback', 'project']);

const TYPE_HUE: Record<MemtagType, { hue: string; label: string }> = {
  user: { hue: '--rose', label: 'user' },
  feedback: { hue: '--cyan', label: 'feedback' },
  project: { hue: '--violet', label: 'project' },
};

function normalizeType(value: string | null): MemtagType {
  return value === 'feedback' || value === 'project' ? value : 'user';
}

const STYLE = `
:host {
  display: inline-flex;
  vertical-align: middle;
  --mtag-fill: 12%;
  --mtag-border: 28%;
}
:host([hidden]) { display: none; }
.mtag {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  font-family: var(--ui);
  font-size: 10px;
  line-height: 1.4;
  border-radius: 26px;
  padding: 1px 8px;
  white-space: nowrap;
  color: var(--mtag-hue, var(--rose));
  background: color-mix(in srgb, var(--mtag-hue, var(--rose)) var(--mtag-fill), var(--canvas));
  border: 1px solid color-mix(in srgb, var(--mtag-hue, var(--rose)) var(--mtag-border), var(--line));
}
`;
const SHEET = sheet(STYLE);

const STYLE_ID = 'slicc-memtag-dark';

const DARK_STYLE = `
.dark slicc-memtag,
[data-theme="dark"] slicc-memtag {
  --mtag-fill: 22%;
  --mtag-border: 38%;
}
`;

function ensureDarkStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DARK_STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export class SliccMemtag extends HTMLElement {
  static readonly observedAttributes = ['type', 'label'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    ensureDarkStyle(this.ownerDocument);
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  get type(): MemtagType {
    return normalizeType(this.getAttribute('type'));
  }

  set type(value: MemtagType) {
    this.setAttribute('type', TYPES.has(value) ? value : 'user');
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const { hue, label: defaultLabel } = TYPE_HUE[this.type];
    const label = this.label;

    const inner = label != null ? label : h('slot', null, defaultLabel);
    const tag = h('span', { class: 'mtag', part: 'tag', style: `--mtag-hue:var(${hue})` }, inner);
    this.#root.replaceChildren(tag);
  }
}

define('slicc-memtag', SliccMemtag);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-memtag': SliccMemtag;
  }
}
