import { define } from '../internal/define.js';

const STYLE = `
slicc-surface {
  position: absolute;
  inset: 0;
  display: none;
  box-sizing: border-box;
  font-family: var(--ui);
}
/* Active reveal — the prototype's \`.surface.on\`. Default (and \`layout="flex"\`)
   reveals as a flex row (Files / Terminal / Hero studio). */
slicc-surface[active] {
  display: flex;
}
/* \`.surface.mem.on,.surface.pal.on\` — the Memory / Palette scroll lists reveal as
   a plain block. */
slicc-surface[active][layout="block"] {
  display: block;
}
/* \`.surface.browser.on\` — the Browser/CDP surface stacks its bar over the compare
   grid and paints the prototype's literal paper backdrop. */
slicc-surface[active][layout="column"] {
  display: flex;
  flex-direction: column;
  background: #fafafa;
}
/* Browser-fullscreen (Fullscreen API): the surface normally inherits the pane's
   backdrop; standalone over the UA's black fullscreen backdrop it needs its own
   opaque canvas, and the absolute inset anchors to the viewport. */
slicc-surface:fullscreen {
  background: var(--canvas, #fff);
  position: fixed;
}
`;

const STYLE_ID = 'slicc-surface-style';

function ensureSurfaceStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

type SurfaceLayout = 'flex' | 'block' | 'column';

function normalizeLayout(value: string | null): SurfaceLayout {
  return value === 'block' || value === 'column' ? value : 'flex';
}

export class SliccSurface extends HTMLElement {
  static readonly observedAttributes = ['surface-id', 'active', 'layout'];

  connectedCallback(): void {
    ensureSurfaceStyle(this.ownerDocument);

    this.#syncDataset();
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null): void {
    if (!this.isConnected) return;
    if (name === 'surface-id') {
      this.#syncDataset();
    } else if (name === 'active' && prev !== next) {
      this.dispatchEvent(
        new CustomEvent('surface-toggle', {
          bubbles: true,
          composed: true,
          detail: { surfaceId: this.surfaceId, active: this.active, layout: this.layout },
        })
      );
    }
  }

  get surfaceId(): string | null {
    return this.getAttribute('surface-id');
  }

  set surfaceId(value: string | null) {
    if (value == null) this.removeAttribute('surface-id');
    else this.setAttribute('surface-id', value);
  }

  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    this.toggleAttribute('active', value);
  }

  get layout(): SurfaceLayout {
    return normalizeLayout(this.getAttribute('layout'));
  }

  set layout(value: SurfaceLayout) {
    this.setAttribute('layout', normalizeLayout(value));
  }

  #syncDataset(): void {
    const id = this.surfaceId;
    if (id == null) delete this.dataset.s;
    else this.dataset.s = id;
  }
}

define('slicc-surface', SliccSurface);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-surface': SliccSurface;
  }
}
