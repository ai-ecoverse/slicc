import { define } from '../internal/define.js';
import {
  ensureGlobalTokens,
  getTheme,
  type SliccTheme as SliccThemeName,
  setTheme,
} from './tokens.js';

export class SliccTheme extends HTMLElement {
  static readonly observedAttributes = ['theme'];

  connectedCallback(): void {
    ensureGlobalTokens(this.ownerDocument);

    this.classList.add('slicc-theme');
    this.#apply();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'theme' && oldValue !== newValue && this.isConnected) {
      this.#apply();
    }
  }

  get theme(): SliccThemeName {
    return this.getAttribute('theme') === 'dark' ? 'dark' : 'light';
  }

  set theme(value: SliccThemeName) {
    this.setAttribute('theme', value === 'dark' ? 'dark' : 'light');
  }

  #apply(): void {
    const theme = this.theme;
    setTheme(theme, this);
    this.dispatchEvent(
      new CustomEvent('slicc-theme-change', {
        detail: { theme },
        bubbles: true,
        composed: true,
      })
    );
  }
}

define('slicc-theme', SliccTheme);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-theme': SliccTheme;
  }
  interface HTMLElementEventMap {
    'slicc-theme-change': CustomEvent<{ theme: 'light' | 'dark' }>;
  }
}

export type { SliccThemeName };
export { getTheme };
