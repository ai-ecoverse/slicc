import { define } from '../internal/define.js';
import { iconSvg } from '../internal/icons.js';
import { type SliccTheme, setTheme } from './tokens.js';

// Lifted verbatim from the prototype `.themetgl` rule (proto/StellarRubySwift.html):
//   .themetgl{font:inherit;font-size:14px;line-height:1;width:var(--ctl-h,30px);
//     height:var(--ctl-h,30px);border-radius:9999px;background:var(--ghost);
//     color:var(--ink);border:1px solid var(--line);cursor:pointer;display:grid;
//     place-items:center;flex:0 0 auto;}
//   .themetgl:hover{background:color-mix(in srgb,var(--ink) 8%,var(--ghost));}
// Tokens (--ghost/--ink/--line/--ctl-h/--ui) are inherited, so they pierce the
// shadow boundary — they are referenced, never redeclared.
const STYLE = `
:host { display: inline-flex; flex: 0 0 auto; }
.themetgl {
  font: inherit; font-family: var(--ui); font-size: 14px; line-height: 1;
  width: var(--ctl-h, 30px); height: var(--ctl-h, 30px);
  border-radius: 9999px;
  background: var(--ghost); color: var(--ink); border: 1px solid var(--line);
  cursor: pointer; display: grid; place-items: center; flex: 0 0 auto;
  padding: 0;
}
.themetgl:hover { background: color-mix(in srgb, var(--ink) 8%, var(--ghost)); }
.themetgl svg { display: block; }
`;

/** Square pixel size of the lucide glyph, matching the prototype's 14px control band. */
const ICON_SIZE = 16;

/**
 * Lucide glyph shown for each resolved theme — the icon names the action's
 * destination (light shows a `moon` because clicking switches *to* dark; dark
 * shows a `sun` because clicking switches *to* light), matching the prototype.
 * Rendered via the shared `iconSvg` helper — never emoji.
 */
const GLYPH: Record<SliccTheme, string> = {
  light: iconSvg('moon', { size: ICON_SIZE }),
  dark: iconSvg('sun', { size: ICON_SIZE }),
};

/** Button `title` (tooltip) for each resolved theme — describes the action the click performs. */
const TITLE: Record<SliccTheme, string> = {
  light: 'Switch to dark mode',
  dark: 'Switch to light mode',
};

/**
 * `<slicc-theme-toggle>` — the circular nav control that flips the document
 * between light and dark (the prototype's `.themetgl` button, `#themeToggle`).
 *
 * It is the control that *owns* the theme: a click toggles `body.dark` via
 * `setTheme`, swaps its lucide glyph (a `moon` in light, a `sun` in dark — the
 * icon names where the click will take you), updates `aria-pressed` + `title`,
 * and forwards the resolved theme as a `theme` attribute onto every
 * `<slicc-pill>` and `<slicc-add-menu>` in the document so those components do
 * not fall back to `prefers-color-scheme`. Defaults to light on connect and
 * emits a composed, bubbling `slicc-theme-change` event carrying the new theme.
 *
 * @attr theme - resolved theme (`light` | `dark`), reflected; settable to drive
 *   the toggle programmatically (applies the theme as if clicked).
 * @fires slicc-theme-change - `CustomEvent<{ theme: 'light' | 'dark' }>`,
 *   composed + bubbling, dispatched whenever the resolved theme changes.
 * @csspart button - the circular toggle button (`.themetgl`).
 * @slot glyph-light - overrides the light-mode glyph (default: lucide `moon`).
 * @slot glyph-dark - overrides the dark-mode glyph (default: lucide `sun`).
 */
export class SliccThemeToggle extends HTMLElement {
  static readonly observedAttributes = ['theme'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;
  #applying = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.innerHTML = `<style>${STYLE}</style><button class="themetgl" part="button" type="button" aria-pressed="false"><slot name="glyph-light">${GLYPH.light}</slot><slot name="glyph-dark" hidden>${GLYPH.dark}</slot></button>`;
    this.#button = this.#root.querySelector('button');
  }

  connectedCallback(): void {
    this.#button?.addEventListener('click', this.#onClick);
    // Default to light on load unless the host already declares a theme.
    this.#apply(this.theme ?? 'light', { silent: true });
  }

  disconnectedCallback(): void {
    this.#button?.removeEventListener('click', this.#onClick);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'theme' || oldValue === newValue) return;
    // Re-entrancy guard: `#apply` reflects to the attribute, which re-enters here.
    if (this.#applying) return;
    if (this.isConnected) this.#apply(this.#normalize(newValue) ?? 'light', { silent: true });
  }

  /** The resolved theme. Returns `null` until first applied; setting it applies that theme. */
  get theme(): SliccTheme | null {
    return this.#normalize(this.getAttribute('theme'));
  }

  set theme(value: SliccTheme | null) {
    this.#apply(value === 'dark' ? 'dark' : 'light', { silent: true });
  }

  /** Whether the toggle is in the dark (pressed) state. */
  get pressed(): boolean {
    return this.theme === 'dark';
  }

  #normalize(value: string | null): SliccTheme | null {
    if (value === 'dark') return 'dark';
    if (value === 'light') return 'light';
    return null;
  }

  readonly #onClick = (): void => {
    this.#apply(this.theme === 'dark' ? 'light' : 'dark');
  };

  /**
   * Apply a resolved theme: flip `body.dark`, update the button (glyph, pressed
   * state, title), reflect the `theme` attribute, forward to peer components,
   * and (unless `silent`) emit `slicc-theme-change`.
   */
  #apply(theme: SliccTheme, opts: { silent?: boolean } = {}): void {
    this.#applying = true;
    try {
      // The control owns the document theme.
      setTheme(theme);

      // Reflect resolved theme to the attribute (drives external CSS / queries).
      if (this.getAttribute('theme') !== theme) this.setAttribute('theme', theme);

      // Update the button surface + a11y state.
      if (this.#button) {
        this.#button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        this.#button.title = TITLE[theme];
        const light = this.#root.querySelector<HTMLElement>('slot[name="glyph-light"]');
        const dark = this.#root.querySelector<HTMLElement>('slot[name="glyph-dark"]');
        light?.toggleAttribute('hidden', theme === 'dark');
        dark?.toggleAttribute('hidden', theme === 'light');
      }

      // Forward the explicit theme to peer components so they don't fall back to
      // prefers-color-scheme. These elements may not exist yet — that is fine; we
      // only stamp those present now. Referenced by tag name only (no import).
      for (const peer of document.querySelectorAll('slicc-pill, slicc-add-menu')) {
        peer.setAttribute('theme', theme);
      }
    } finally {
      this.#applying = false;
    }

    if (!opts.silent) {
      this.dispatchEvent(
        new CustomEvent<{ theme: SliccTheme }>('slicc-theme-change', {
          detail: { theme },
          bubbles: true,
          composed: true,
        })
      );
    }
  }
}

define('slicc-theme-toggle', SliccThemeToggle);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-theme-toggle': SliccThemeToggle;
  }
}
