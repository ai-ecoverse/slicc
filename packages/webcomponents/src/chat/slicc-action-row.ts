import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';
import { hasIcon, iconEl } from '../internal/icons.js';

const STYLE = `
slicc-action-row {
  display: block;
  margin: -2px 0 16px;
  font-family: var(--ui);
  /* Re-derive the accent here so it tracks the locally inherited --ctx
     (a :root-declared derivation bakes in :root's --ctx — see tokens.css). */
  --accent: color-mix(in srgb, var(--ctx) 55%, var(--ink));
}
slicc-action-row .slicc-act__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--txt-2);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}
slicc-action-row .slicc-act__head:hover {
  background: var(--ghost);
}
slicc-action-row .slicc-act__head:focus-visible {
  outline: 2px solid var(--violet);
  outline-offset: 1px;
}
slicc-action-row .slicc-act__ic {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  font-size: 10px;
  /* The chip ground is the derived context accent; --canvas ink on top keeps
     the glyph readable in BOTH themes (accent leans dark on light canvases,
     light on dark ones). */
  color: var(--canvas);
  background: var(--accent);
  flex: 0 0 auto;
}
slicc-action-row .slicc-act__ic.vi { background: var(--violet); }
slicc-action-row .slicc-act__ic.am { background: var(--amber); }
slicc-action-row .slicc-act__ic.cy { background: var(--cyan); }
slicc-action-row .slicc-act__ic.gh { background: #1f2328; }
slicc-action-row .slicc-act__label {
  color: var(--ink);
  font-weight: 500;
}
slicc-action-row .slicc-act__badge {
  margin-left: auto;
  color: var(--txt-3);
}
slicc-action-row .slicc-act__badge:empty {
  display: none;
}
slicc-action-row .slicc-act__chev {
  color: var(--txt-3);
  transition: transform 0.15s;
}
slicc-action-row[open] .slicc-act__chev {
  transform: rotate(90deg);
}
slicc-action-row .slicc-act__body {
  display: none;
  margin: 3px 0 0 28px;
  background: var(--ghost);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px 11px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--txt-2);
}
slicc-action-row[open] .slicc-act__body {
  display: block;
}
slicc-action-row .slicc-act__body .add { color: #1a7f37; }
slicc-action-row .slicc-act__body .del { color: #cf222e; }
slicc-action-row .slicc-act__body .ok  { color: #1a7f37; }
slicc-action-row .slicc-act__body .p   { color: #6b6b6b; }
slicc-action-row .slicc-act__body .mut { color: var(--txt-3); }
slicc-action-row .vlink {
  color: var(--violet);
  font-weight: 600;
  text-decoration: none;
  border-bottom: 1px dotted color-mix(in srgb, var(--violet) 55%, transparent);
  cursor: pointer;
}
slicc-action-row .vlink:hover {
  border-bottom-style: solid;
}
`;

const STYLE_ID = 'slicc-action-row-style';

function ensureActionRowStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const TONES = new Set(['ink', 'vi', 'am', 'cy', 'gh']);

export class SliccActionRow extends HTMLElement {
  static readonly observedAttributes = ['open', 'icon', 'tone', 'label', 'result'];

  #head!: HTMLButtonElement;
  #icon!: HTMLElement;
  #label!: HTMLElement;
  #badge!: HTMLElement;
  #body!: HTMLElement;
  #built = false;
  #onClick = (): void => this.#toggle();

  connectedCallback(): void {
    ensureActionRowStyle(this.ownerDocument);
    this.#build();
    this.#sync();
    this.#head?.addEventListener('click', this.#onClick);
  }

  disconnectedCallback(): void {
    this.#head?.removeEventListener('click', this.#onClick);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.#built) return;
    if (name === 'open') {
      this.#head.setAttribute('aria-expanded', String(newValue !== null));
      this.dispatchEvent(
        new CustomEvent('slicc-action-row-toggle', {
          bubbles: true,
          composed: true,
          detail: { open: newValue !== null },
        })
      );
    } else {
      this.#sync();
    }
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  get icon(): string | null {
    return this.getAttribute('icon');
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  get tone(): 'ink' | 'vi' | 'am' | 'cy' | 'gh' {
    const t = this.getAttribute('tone');
    return t && TONES.has(t) ? (t as 'ink' | 'vi' | 'am' | 'cy' | 'gh') : 'ink';
  }

  set tone(value: 'ink' | 'vi' | 'am' | 'cy' | 'gh') {
    this.setAttribute('tone', value);
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get result(): string | null {
    return this.getAttribute('result');
  }

  set result(value: string | null) {
    if (value == null) this.removeAttribute('result');
    else this.setAttribute('result', value);
  }

  #toggle(): void {
    this.open = !this.open;
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const incoming = Array.from(this.childNodes).filter(
      (n) =>
        !(n instanceof HTMLElement && n.classList.contains('slicc-act__head')) &&
        !(n instanceof HTMLElement && n.classList.contains('slicc-act__body'))
    );

    this.#head = this.ownerDocument.createElement('button');
    this.#head.type = 'button';
    this.#head.className = 'slicc-act__head';
    this.#head.setAttribute('part', 'head');

    this.#icon = h('span', { class: 'slicc-act__ic', part: 'icon' });
    this.#label = h('span', { class: 'slicc-act__label', part: 'label' });
    this.#badge = h('span', { class: 'slicc-act__badge', part: 'badge' });
    append(this.#head, [
      this.#icon,
      this.#label,
      this.#badge,
      h('span', { class: 'slicc-act__chev', part: 'chevron', 'aria-hidden': 'true' }, '▸'),
    ]);

    this.#body = this.ownerDocument.createElement('div');
    this.#body.className = 'slicc-act__body';
    this.#body.setAttribute('part', 'body');

    for (const node of incoming) {
      if (node instanceof HTMLElement && node.getAttribute('slot') === 'body') {
        this.#body.appendChild(node);
      } else {
        this.#label.appendChild(node);
      }
    }

    this.replaceChildren(this.#head, this.#body);
    this.#head.addEventListener('click', this.#onClick);
  }

  #sync(): void {
    if (!this.#built) return;

    const tone = this.tone;
    this.#icon.className = `slicc-act__ic${tone === 'ink' ? '' : ` ${tone}`}`;

    const icon = this.icon ?? '';
    if (icon && hasIcon(icon)) {
      this.#icon.replaceChildren(iconEl(icon, { size: 12 }));
    } else {
      this.#icon.textContent = icon;
    }

    const label = this.label;
    if (label != null) this.#label.textContent = label;

    this.#head.setAttribute('aria-expanded', String(this.open));
    this.#badge.textContent = this.result ?? '';
  }
}

define('slicc-action-row', SliccActionRow);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-action-row': SliccActionRow;
  }
}
