import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const STYLE = `
slicc-tool-cluster {
  display: block;
  margin: -2px 0 16px;
  font-family: var(--ui);
  /* Re-derive the accent so it tracks the locally inherited --ctx. */
  --accent: color-mix(in srgb, var(--ctx) 55%, var(--ink));
}
slicc-tool-cluster .slicc-cluster__head {
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
slicc-tool-cluster .slicc-cluster__head:hover {
  background: var(--ghost);
}
slicc-tool-cluster .slicc-cluster__head:focus-visible {
  outline: 2px solid var(--ctx);
  outline-offset: 1px;
}
slicc-tool-cluster .slicc-cluster__ic {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--canvas);
  background: var(--accent);
  flex: 0 0 auto;
}
slicc-tool-cluster .slicc-cluster__label {
  color: var(--ink);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
slicc-tool-cluster .slicc-cluster__count {
  margin-left: auto;
  color: var(--txt-3);
  flex: 0 0 auto;
}
slicc-tool-cluster .slicc-cluster__chev {
  color: var(--txt-3);
  transition: transform 0.15s;
  flex: 0 0 auto;
}
slicc-tool-cluster[open] .slicc-cluster__chev {
  transform: rotate(90deg);
}
/* The collapsed body keeps its rows in the DOM (state survives) but hidden;
   expanded, the rows indent behind a context-accent rail. */
slicc-tool-cluster .slicc-cluster__body {
  display: none;
  margin: 2px 0 0 12px;
  padding-left: 12px;
  border-left: 2px solid color-mix(in srgb, var(--ctx) 35%, var(--line));
}
slicc-tool-cluster[open] .slicc-cluster__body {
  display: block;
}
/* Rows inside the cluster drop their own bottom gap — the cluster owns it. */
slicc-tool-cluster .slicc-cluster__body slicc-action-row {
  margin-bottom: 4px;
}
`;

const STYLE_ID = 'slicc-tool-cluster-style';

function ensureClusterStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const DEFAULT_LABEL = 'A few quick steps';

export class SliccToolCluster extends HTMLElement {
  static readonly observedAttributes = ['open', 'label', 'count'];

  #head!: HTMLButtonElement;
  #label!: HTMLElement;
  #count!: HTMLElement;
  #body!: HTMLElement;
  #built = false;
  #onClick = (): void => {
    this.open = !this.open;
  };

  connectedCallback(): void {
    ensureClusterStyle(this.ownerDocument);
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
        new CustomEvent('slicc-tool-cluster-toggle', {
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

  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get count(): number {
    const n = Number.parseInt(this.getAttribute('count') ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  set count(value: number) {
    if (value > 0) this.setAttribute('count', String(value));
    else this.removeAttribute('count');
  }

  get body(): HTMLElement {
    this.#build();
    return this.#body;
  }

  append(...nodes: (Node | string)[]): void {
    this.#build();
    this.#body.append(...nodes);
    this.#sync();
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const incoming = Array.from(this.childNodes).filter(
      (n) =>
        !(n instanceof HTMLElement && n.classList.contains('slicc-cluster__head')) &&
        !(n instanceof HTMLElement && n.classList.contains('slicc-cluster__body'))
    );

    this.#head = this.ownerDocument.createElement('button');
    this.#head.type = 'button';
    this.#head.className = 'slicc-cluster__head';
    this.#head.setAttribute('part', 'head');

    this.#label = h('span', { class: 'slicc-cluster__label', part: 'label' });
    this.#count = h('span', { class: 'slicc-cluster__count', part: 'count' });
    append(this.#head, [
      h('span', { class: 'slicc-cluster__ic', part: 'icon' }, iconEl('layers', { size: 12 })),
      this.#label,
      this.#count,
      h('span', { class: 'slicc-cluster__chev', part: 'chevron', 'aria-hidden': 'true' }, '▸'),
    ]);

    this.#body = this.ownerDocument.createElement('div');
    this.#body.className = 'slicc-cluster__body';
    this.#body.setAttribute('part', 'body');
    for (const node of incoming) this.#body.appendChild(node);

    this.replaceChildren(this.#head, this.#body);
    this.#head.addEventListener('click', this.#onClick);
  }

  #sync(): void {
    if (!this.#built) return;
    this.#label.textContent = this.label;
    const count = this.count || this.#body.children.length;
    this.#count.textContent = count > 0 ? `${count} steps` : '';
    this.#head.setAttribute('aria-expanded', String(this.open));
  }
}

define('slicc-tool-cluster', SliccToolCluster);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-tool-cluster': SliccToolCluster;
  }
}
