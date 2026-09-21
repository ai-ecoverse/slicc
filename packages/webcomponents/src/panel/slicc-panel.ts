import { define } from '../internal/define.js';
import {
  isPanelAnchor,
  type PanelAnchor,
  type PanelMeta,
  type PanelPresentation,
  type PanelSize,
  panelMetaOf,
} from './panel-meta.js';

export {
  isPanelAnchor,
  type PanelAnchor,
  type PanelMeta,
  type PanelPresentation,
  type PanelSize,
  panelMetaOf,
};

const STYLE = `
[data-slicc-panel] {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  position: relative;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  font-family: var(--ui);
}
/* Author-set \`display\` on the host would otherwise outrank the UA's
   \`[hidden]{display:none}\`, so restate it. */
[data-slicc-panel][hidden] { display: none; }
/* A floating panel is lifted out of flow so the docked panels do NOT reflow
   around it. \`z-index\` here only orders it against its siblings inside the
   panel host's stacking context — it can never rise above the trusted layer
   (see \`trusted-layer.ts\`), which is the whole point of clamping panels in a
   context of their own. The layout engine sets the offsets; these are the
   fallbacks for a floating panel nobody placed. */
[data-slicc-panel][presentation="floating"] {
  position: absolute;
  z-index: 1;
  flex: 0 0 auto;
  max-width: 100%;
  max-height: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--canvas);
  box-shadow: var(--shadow-pane);
  overflow: hidden;
}
[data-slicc-panel][presentation="floating"][anchor="right"] { top: 0; right: 0; bottom: 0; }
[data-slicc-panel][presentation="floating"][anchor="left"] { top: 0; left: 0; bottom: 0; }
[data-slicc-panel][presentation="floating"][anchor="top"] { top: 0; left: 0; right: 0; }
[data-slicc-panel][presentation="floating"][anchor="bottom"] { bottom: 0; left: 0; right: 0; }
[data-slicc-panel][presentation="floating"][anchor="center"] {
  top: 50%; left: 50%; transform: translate(-50%, -50%);
}
/* Terminal tool panel: always-dark chrome (matches dock-tree --chrome-dark).
   panelizeShell reparents the term surface into a <slicc-panel>; floating
   panels otherwise paint var(--canvas)/var(--line) and recreate the cream
   frame under light themes. */
[data-slicc-panel][panel-id="term"][presentation="floating"] {
  background: var(--term-bg, #0c0c0e);
  border-color: var(--term-border, #232329);
  box-shadow:
    rgba(0, 0, 0, 0.35) 0 14px 36px -12px,
    rgba(0, 0, 0, 0.2) 0 4px 10px -4px;
}
`;

const STYLE_ID = 'slicc-panel-style';

function ensurePanelStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export const PANEL_MARKER_ATTR = 'data-slicc-panel';

export interface PanelVisibilityDetail {
  panelId: string | null;
  visible: boolean;
}

export class SliccPanel extends HTMLElement {
  static readonly observedAttributes = ['panel-id', 'hidden', 'locked', 'presentation', 'anchor'];

  static readonly panelMeta?: PanelMeta;

  #resizeObserver: ResizeObserver | null = null;

  connectedCallback(): void {
    ensurePanelStyle(this.ownerDocument);

    this.setAttribute(PANEL_MARKER_ATTR, '');
    this.setAttribute('part', 'panel');

    if (!this.hasAttribute('presentation')) this.setAttribute('presentation', this.presentation);
    if (!this.hasAttribute('anchor') && this.anchor) this.setAttribute('anchor', this.anchor);
    this.#observeResize();

    if (this.visible) this.onPanelShow?.();
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null): void {
    if (!this.isConnected || prev === next) return;
    if (name !== 'hidden') return;
    const visible = this.visible;

    if (visible) this.onPanelShow?.();
    else this.onPanelHide?.();
    this.dispatchEvent(
      new CustomEvent<PanelVisibilityDetail>('slicc-panel-visibility', {
        bubbles: true,
        composed: true,
        detail: { panelId: this.panelId, visible },
      })
    );
  }

  get panelId(): string | null {
    return this.getAttribute('panel-id') ?? panelMetaOf(this.constructor)?.id ?? null;
  }

  set panelId(value: string | null) {
    if (value == null) this.removeAttribute('panel-id');
    else this.setAttribute('panel-id', value);
  }

  get visible(): boolean {
    return !this.hasAttribute('hidden');
  }

  set visible(value: boolean) {
    this.toggleAttribute('hidden', !value);
  }

  get locked(): boolean {
    return this.hasAttribute('locked');
  }

  set locked(value: boolean) {
    this.toggleAttribute('locked', value);
  }

  get presentation(): PanelPresentation {
    const attr = this.getAttribute('presentation');
    if (attr === 'floating' || attr === 'docked') return attr;
    return panelMetaOf(this.constructor)?.presentation ?? 'docked';
  }

  set presentation(value: PanelPresentation) {
    this.setAttribute('presentation', value);
  }

  get anchor(): PanelAnchor | null {
    const attr = this.getAttribute('anchor');
    return isPanelAnchor(attr) ? attr : (panelMetaOf(this.constructor)?.anchor ?? null);
  }

  set anchor(value: PanelAnchor | null) {
    if (value == null) this.removeAttribute('anchor');
    else this.setAttribute('anchor', value);
  }

  get meta(): PanelMeta | undefined {
    return panelMetaOf(this.constructor);
  }

  onPanelShow?(): void;

  onPanelHide?(): void;

  onPanelResize?(rect: DOMRectReadOnly): void;

  #observeResize(): void {
    if (!this.onPanelResize || typeof ResizeObserver === 'undefined') return;
    this.#resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) this.onPanelResize?.(rect);
    });
    this.#resizeObserver.observe(this);
  }
}

define('slicc-panel', SliccPanel);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-panel': SliccPanel;
  }
  interface HTMLElementEventMap {
    'slicc-panel-visibility': CustomEvent<PanelVisibilityDetail>;
  }
}
