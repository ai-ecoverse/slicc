import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { type SliccTheme, setTheme } from './tokens.js';

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
const SHEET = sheet(STYLE);

const ICON_SIZE = 16;

const GLYPH: Record<SliccTheme, string> = {
  light: 'moon',
  dark: 'sun',
};

const TITLE: Record<SliccTheme, string> = {
  light: 'Switch to dark mode',
  dark: 'Switch to light mode',
};

export class SliccThemeToggle extends HTMLElement {
  static readonly observedAttributes = ['theme'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;
  #applying = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    const button = h(
      'button',
      { class: 'themetgl', part: 'button', type: 'button', 'aria-pressed': 'false' },
      h('slot', { name: 'glyph-light' }, iconEl(GLYPH.light, { size: ICON_SIZE })),
      h('slot', { name: 'glyph-dark', hidden: true }, iconEl(GLYPH.dark, { size: ICON_SIZE }))
    ) as HTMLButtonElement;
    this.#root.replaceChildren(button);
    this.#button = button;
  }

  connectedCallback(): void {
    this.#button?.addEventListener('click', this.#onClick);

    this.#apply(this.theme ?? 'light', { silent: true });
  }

  disconnectedCallback(): void {
    this.#button?.removeEventListener('click', this.#onClick);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'theme' || oldValue === newValue) return;

    if (this.#applying) return;
    if (this.isConnected) this.#apply(this.#normalize(newValue) ?? 'light', { silent: true });
  }

  get theme(): SliccTheme | null {
    return this.#normalize(this.getAttribute('theme'));
  }

  set theme(value: SliccTheme | null) {
    this.#apply(value === 'dark' ? 'dark' : 'light', { silent: true });
  }

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

  #apply(theme: SliccTheme, opts: { silent?: boolean } = {}): void {
    this.#applying = true;
    try {
      setTheme(theme);

      if (this.getAttribute('theme') !== theme) this.setAttribute('theme', theme);

      if (this.#button) {
        this.#button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        this.#button.title = TITLE[theme];
        const light = this.#root.querySelector<HTMLElement>('slot[name="glyph-light"]');
        const dark = this.#root.querySelector<HTMLElement>('slot[name="glyph-dark"]');
        light?.toggleAttribute('hidden', theme === 'dark');
        dark?.toggleAttribute('hidden', theme === 'light');
      }

      for (const peer of document.querySelectorAll('slicc-add-menu')) {
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
