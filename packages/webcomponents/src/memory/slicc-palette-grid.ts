import { define } from '../internal/define.js';

import './slicc-palette-cell.js';

const STYLE = `
slicc-palette-grid {
  display: block;
  flex: 1;
  overflow: auto;
  padding: 18px;
  font-family: var(--ui);
  color: var(--ink);
}
slicc-palette-grid h4 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}
slicc-palette-grid .palgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
}
`;

const STYLE_ID = 'slicc-palette-grid-style';

function ensurePaletteGridStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export interface PaletteToken {
  label: string;

  color: string;
}

export const DEFAULT_TOKENS: readonly PaletteToken[] = [
  { label: 'canvas #faf6f1', color: '#faf6f1' },
  { label: 'cone #ef7000', color: '#ef7000' },
  { label: 'scoop #8b5cf6', color: '#8b5cf6' },
  { label: 'scoop #06b6d4', color: '#06b6d4' },
  { label: 'scoop #f43f5e', color: '#f43f5e' },
  { label: 'ink #0a0a0a', color: '#0a0a0a' },
];

const DEFAULT_HEADING = 'brand palette · tokens';

export class SliccPaletteGrid extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['heading'];
  }

  #initialized = false;
  #heading: HTMLHeadingElement | null = null;
  #grid: HTMLDivElement | null = null;

  #slotted: Node[] = [];

  #tokens: PaletteToken[] | null = null;
  #onSelect: ((e: Event) => void) | null = null;

  connectedCallback(): void {
    ensurePaletteGridStyle(this.ownerDocument);
    if (!this.#initialized) this.#initialize();
    this.#sync();
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(): void {
    if (!this.#initialized) return;
    this.#sync();
  }

  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }

  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  get tokens(): PaletteToken[] {
    const source = this.#tokens ?? DEFAULT_TOKENS;
    return source.map((t) => ({ ...t }));
  }

  set tokens(value: PaletteToken[] | null) {
    this.#tokens = Array.isArray(value)
      ? value.map((t) => ({ label: String(t.label ?? ''), color: String(t.color ?? '') }))
      : null;
    if (this.#initialized) this.#renderCells();
  }

  #initialize(): void {
    this.#initialized = true;

    this.#slotted = [];
    while (this.firstChild) {
      this.#slotted.push(this.firstChild);
      this.removeChild(this.firstChild);
    }

    const heading = this.ownerDocument.createElement('h4');
    const grid = this.ownerDocument.createElement('div');
    grid.className = 'palgrid';

    this.append(heading, grid);
    this.#heading = heading;
    this.#grid = grid;

    this.#renderCells();
  }

  #sync(): void {
    if (this.#heading) this.#heading.textContent = this.heading;
  }

  #renderCells(): void {
    const grid = this.#grid;
    if (!grid) return;

    grid.replaceChildren();

    for (const node of this.#slotted) grid.appendChild(node);

    for (const token of this.tokens) {
      const cell = this.ownerDocument.createElement('slicc-palette-cell');
      cell.setAttribute('color', token.color);
      cell.setAttribute('label', token.label);
      grid.appendChild(cell);
    }
  }

  #bind(): void {
    if (this.#onSelect) return;

    this.#onSelect = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      this.dispatchEvent(
        new CustomEvent('select', {
          bubbles: true,
          composed: true,
          detail: { label: detail.label ?? '', color: detail.color ?? '', sourceEvent: e },
        })
      );
    };
    this.addEventListener('palette-select', this.#onSelect);
  }

  #unbind(): void {
    if (this.#onSelect) {
      this.removeEventListener('palette-select', this.#onSelect);
      this.#onSelect = null;
    }
  }
}

define('slicc-palette-grid', SliccPaletteGrid);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-palette-grid': SliccPaletteGrid;
  }
}
