import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const STYLE = `
:host{display:inline-flex;vertical-align:baseline;max-width:100%;}
:host([hidden]){display:none;}
button{
  display:inline-flex;align-items:center;gap:5px;
  box-sizing:border-box;max-width:100%;
  margin:0;padding:1px 8px 1px 6px;
  font-family:var(--ui);font-size:.86em;line-height:1.5;
  color:inherit;
  /* Tinted off the CURRENT text color, not a fixed token: the chip has to sit
     legibly in an agent message (ink on canvas) and in a user bubble (white on
     --deep, and near-black on the dark-mode flip) without either surface
     having to override it. */
  background:color-mix(in srgb,currentColor 12%,transparent);
  border:1px solid color-mix(in srgb,currentColor 26%,transparent);
  border-radius:26px;
  cursor:pointer;
  text-align:left;
  -webkit-appearance:none;appearance:none;
}
button:hover{background:color-mix(in srgb,currentColor 20%,transparent);}
button:active{background:color-mix(in srgb,currentColor 26%,transparent);}
.icon{flex:0 0 auto;opacity:.8;}
.label{
  min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums;
}
`;
const SHEET = sheet(STYLE);

const DEFAULT_ICON = 'file';

export class SliccBlobChip extends HTMLElement {
  static readonly observedAttributes = ['label', 'icon'];

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

  get label(): string {
    return this.getAttribute('label') ?? '';
  }

  set label(value: string) {
    this.setAttribute('label', value);
  }

  get icon(): string {
    return this.getAttribute('icon') ?? DEFAULT_ICON;
  }

  set icon(value: string) {
    this.setAttribute('icon', value);
  }

  #render(): void {
    const button = h('button', { class: 'chip', part: 'chip' }) as HTMLButtonElement;
    button.type = 'button';
    button.append(
      iconEl(this.icon, { size: 13, class: 'icon', part: 'icon' }),
      h('span', { class: 'label', part: 'label' }, this.label)
    );
    this.#root.replaceChildren(button);
  }
}

define('slicc-blob-chip', SliccBlobChip);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-blob-chip': SliccBlobChip;
  }
}
