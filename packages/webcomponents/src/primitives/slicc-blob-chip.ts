import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * Inline chip standing in for a payload that was pasted into a message —
 * a base64 blob, a `data:` URL — rather than shown in full.
 *
 * It exists because the alternative is a wall of characters. A pasted PNG is
 * thousands of unbroken glyphs; wrapping it stops the transcript scrolling
 * sideways but still buries the sentence around it. The chip says what the
 * thing IS and how big it is, and opening it is one click.
 *
 * Deliberately a component rather than a class the two message surfaces both
 * style: user bubbles render into a shadow root and agent messages into the
 * light DOM, so a shared CSS class would have to be written out twice, in two
 * stylesheets, and kept in step by hand.
 *
 * Purely presentational — it renders a label and reports that it was
 * activated. What the payload is, and what opening it does, belong to the
 * caller that decoded the bytes (webapp `ui/base64-preview-linker.ts`).
 *
 * The interactive element inside is a real `<button>`, so keyboard activation,
 * focus ring and the a11y role come from the platform. A `click` from inside a
 * shadow root retargets to the host, so a listener on the element itself sees
 * both mouse and keyboard activation with nothing to wire up.
 */
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

/** Fallback icon for a payload whose type suggests nothing better. */
const DEFAULT_ICON = 'file';

/**
 * `<slicc-blob-chip>` — a compact, clickable stand-in for an inline payload.
 *
 * Renders a lucide icon and a short label (`png · 12 KB`) inside a pill-shaped
 * button. The full description belongs in `title`, which the host element
 * carries and the browser surfaces as a tooltip.
 *
 * Self-contained shadow DOM. The chrome is mixed from `currentColor`, so the
 * chip adopts whatever surface it lands on — an agent message, a user bubble,
 * either theme — with no per-surface overrides.
 *
 * @attr label - the chip text (required to be useful; empty renders icon-only)
 * @attr icon - lucide icon name (default `file`)
 * @csspart chip - the button
 * @csspart icon - the leading `<svg>`
 * @csspart label - the label span
 */
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

  /** The chip text. */
  get label(): string {
    return this.getAttribute('label') ?? '';
  }

  set label(value: string) {
    this.setAttribute('label', value);
  }

  /** Lucide icon name shown before the label. */
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
