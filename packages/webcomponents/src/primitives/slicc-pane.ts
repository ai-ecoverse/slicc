import { define } from '../internal/define.js';

const STYLE = `
slicc-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
slicc-pane > .slicc-pane__surface {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-pane);
  overflow: hidden;
}
slicc-pane[elevated] > .slicc-pane__surface {
  box-shadow:
    rgba(10, 10, 10, 0.1) 0 14px 36px -12px,
    rgba(10, 10, 10, 0.05) 0 4px 10px -4px;
}
.dark slicc-pane[elevated] > .slicc-pane__surface,
[data-theme="dark"] slicc-pane[elevated] > .slicc-pane__surface {
  box-shadow:
    rgba(0, 0, 0, 0.45) 0 14px 36px -12px,
    rgba(0, 0, 0, 0.3) 0 4px 10px -4px;
}
slicc-pane .slicc-pane__header {
  flex: 0 0 auto;
}
slicc-pane .slicc-pane__header:empty {
  display: none;
}
slicc-pane .slicc-pane__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
`;

const STYLE_ID = 'slicc-pane-style';

function ensurePaneStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export class SliccPane extends HTMLElement {
  static readonly observedAttributes = ['elevated'];

  #header!: HTMLElement;
  #body!: HTMLElement;
  #built = false;

  connectedCallback(): void {
    ensurePaneStyle(this.ownerDocument);
    this.#build();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'elevated' && oldValue !== newValue && this.isConnected) {
      this.dispatchEvent(
        new CustomEvent('slicc-pane-change', {
          bubbles: true,
          composed: true,
          detail: { elevated: newValue !== null },
        })
      );
    }
  }

  get elevated(): boolean {
    return this.hasAttribute('elevated');
  }

  set elevated(value: boolean) {
    if (value) this.setAttribute('elevated', '');
    else this.removeAttribute('elevated');
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const incoming = Array.from(this.childNodes).filter(
      (n) => !(n instanceof HTMLElement && n.classList.contains('slicc-pane__surface'))
    );

    const surface = this.ownerDocument.createElement('div');
    surface.className = 'slicc-pane__surface';
    surface.setAttribute('part', 'surface');

    this.#header = this.ownerDocument.createElement('div');
    this.#header.className = 'slicc-pane__header';
    this.#header.setAttribute('part', 'header');

    this.#body = this.ownerDocument.createElement('div');
    this.#body.className = 'slicc-pane__body';
    this.#body.setAttribute('part', 'body');

    surface.append(this.#header, this.#body);

    for (const node of incoming) {
      if (node instanceof HTMLElement && node.getAttribute('slot') === 'header') {
        this.#header.appendChild(node);
      } else {
        this.#body.appendChild(node);
      }
    }

    this.appendChild(surface);
  }
}

define('slicc-pane', SliccPane);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-pane': SliccPane;
  }
}
