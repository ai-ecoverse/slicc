import { define } from '../internal/define.js';
import {
  ensureGlobalTokens,
  getTheme,
  type SliccTheme as SliccThemeName,
  setTheme,
} from './tokens.js';

/**
 * `<slicc-theme>` — the foundational design-token / theming provider lifted from
 * the prototype's `:root` (light default) and `body.dark` scopes.
 *
 * Light DOM by design: it renders no markup of its own and adds no shadow root,
 * so it slots its children directly and applies the theme **to itself** via
 * `setTheme(theme, this)`. Because the prototype tokens are CSS custom
 * properties, they inherit through every descendant — including shadow-DOM
 * components nested inside — so wrapping a subtree in `<slicc-theme theme="dark">`
 * re-themes the whole subtree without re-declaring a single token. The hue tokens
 * (`--rose`, `--cyan`, `--violet`, `--amber`, …) and `--rainbow` stay fixed; only
 * the neutral surface tokens (`--canvas`, `--bg`, `--ink`, `--line`, …) flip.
 *
 * On connect it calls `ensureGlobalTokens()` so the `:root` / `.dark` token
 * definitions exist in the document, then applies its `theme` attribute. Changing
 * the attribute (or the `theme` property) re-applies and emits a composed,
 * bubbling `slicc-theme-change` CustomEvent carrying `{ detail: { theme } }`.
 *
 * @attr theme - `light` (default) | `dark`; reflected to the `theme` property
 * @fires slicc-theme-change - `CustomEvent<{ theme: 'light' | 'dark' }>` (composed, bubbling)
 */
export class SliccTheme extends HTMLElement {
  static readonly observedAttributes = ['theme'];

  connectedCallback(): void {
    ensureGlobalTokens(this.ownerDocument);
    // Establish a scoped host class so host apps can target the provider.
    this.classList.add('slicc-theme');
    this.#apply();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'theme' && oldValue !== newValue && this.isConnected) {
      this.#apply();
    }
  }

  /** The active theme — `light` (default) or `dark`. */
  get theme(): SliccThemeName {
    return this.getAttribute('theme') === 'dark' ? 'dark' : 'light';
  }

  set theme(value: SliccThemeName) {
    this.setAttribute('theme', value === 'dark' ? 'dark' : 'light');
  }

  /** Apply the resolved theme to this element and announce the change. */
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

// Re-export the helper-derived theme name type for ergonomic consumers.
export type { SliccThemeName };
export { getTheme };
