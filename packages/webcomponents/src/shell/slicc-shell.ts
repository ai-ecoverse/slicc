import { define } from '../internal/define.js';

const STYLE = `
.slicc-shell { display: flex; flex: 1; min-height: 0; }
.slicc-shell > slicc-dock-tree,
.slicc-shell > .dock-tree {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
/* Pin the dock to its full 48px basis. This selector outranks the dock's own
   "flex: 0 0 48px" rule, so an "auto" basis here would collapse the rail to its
   ~35px icon-content width and leave a bare-shader strip down the right edge.
   z-index 3 lifts the rail above the composer's full-bleed band (z-index 2,
   extending -100vw rightward — slicc-composer.ts), which would otherwise tint
   and blur the rail's own opaque strip. */
.slicc-shell > slicc-dock,
.slicc-shell > .dock { flex: 0 0 48px; position: relative; z-index: 3; }
`;

const STYLE_ID = 'slicc-shell-style';

function ensureShellStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const CHAT_SURFACE_ID = 'chat';

export class SliccShell extends HTMLElement {
  readonly #onDockTreeRender = (event: Event): void => {
    const placed = (event as CustomEvent<{ placed?: string[] }>).detail?.placed;
    if (!Array.isArray(placed)) return;
    const narrow = placed.some((id) => id !== CHAT_SURFACE_ID);
    this.querySelector('slicc-chatpane')?.toggleAttribute('narrow', narrow);
  };

  connectedCallback(): void {
    ensureShellStyle(this.ownerDocument);
    this.classList.add('slicc-shell');
    this.setAttribute('part', 'shell');

    this.addEventListener('dock-tree-render', this.#onDockTreeRender);
  }

  disconnectedCallback(): void {
    this.removeEventListener('dock-tree-render', this.#onDockTreeRender);
  }

  get dockTree(): HTMLElement | null {
    return this.querySelector(':scope > slicc-dock-tree, :scope > .dock-tree');
  }

  get dock(): HTMLElement | null {
    return this.querySelector(':scope > slicc-dock, :scope > .dock');
  }
}

define('slicc-shell', SliccShell);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-shell': SliccShell;
  }
}
