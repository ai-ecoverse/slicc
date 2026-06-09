import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

const STYLE = `
:host {
  display: inline-grid;
  place-items: center;
  width: var(--avatar-size, var(--ctl-h, 30px));
  height: var(--avatar-size, var(--ctl-h, 30px));
  border-radius: 9999px;
  background: var(--rainbow);
  color: #fff;
  font-family: var(--ui);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  flex: 0 0 auto;
  cursor: pointer;
  overflow: hidden;
  -webkit-user-select: none;
  user-select: none;
}
:host([hidden]) { display: none; }
:host(:focus-visible) { outline: 2px solid var(--violet); outline-offset: 2px; }
.me {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
}
.img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
  display: block;
}
`;

/**
 * `<slicc-avatar>` — the circular user avatar from the prototype nav (`.me`).
 * A `--ctl-h` square with a `--rainbow` gradient fill and white initials,
 * grid-centered. Renders explicit `initials`, falls back to up-to-2 uppercase
 * initials derived from `name`, or shows a cover image when `src` is set.
 * Acts as a button for an account menu: clicking (or Enter/Space) emits a
 * composed, bubbling `slicc-avatar-click` event in addition to the native click.
 *
 * The rainbow fill + white text are fixed in both light and dark themes
 * (matching the prototype). Sizing is the inherited `--ctl-h`, overridable via
 * the `size` attribute (any CSS length).
 *
 * @attr initials - explicit initials to display (e.g. "PM"); wins over `name`
 * @attr name - full name; up to 2 uppercase initials are derived when `initials` is absent
 * @attr src - optional image URL; renders an image-backed avatar instead of initials
 * @attr size - optional CSS length overriding the default `--ctl-h` square
 * @attr label - optional accessible label (defaults to `name`, then the initials)
 * @fires slicc-avatar-click - composed + bubbling; user activated the avatar (account menu)
 * @csspart avatar - the inner circular container
 * @csspart initials - the initials text node
 * @csspart image - the cover image node (when `src` is set)
 * @slot - optional custom content replacing the default initials/image
 */
export class SliccAvatar extends HTMLElement {
  static readonly observedAttributes = ['initials', 'name', 'src', 'size', 'label'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.addEventListener('click', this.#onActivate);
    this.addEventListener('keydown', this.#onKeydown);
  }

  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button');
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this.#render();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'size') {
      this.#applySize(value);
    }
    if (this.isConnected) this.#render();
  }

  get initials(): string | null {
    return this.getAttribute('initials');
  }

  set initials(value: string | null) {
    if (value == null) this.removeAttribute('initials');
    else this.setAttribute('initials', value);
  }

  get name(): string | null {
    return this.getAttribute('name');
  }

  set name(value: string | null) {
    if (value == null) this.removeAttribute('name');
    else this.setAttribute('name', value);
  }

  get src(): string | null {
    return this.getAttribute('src');
  }

  set src(value: string | null) {
    if (value == null) this.removeAttribute('src');
    else this.setAttribute('src', value);
  }

  get size(): string | null {
    return this.getAttribute('size');
  }

  set size(value: string | null) {
    if (value == null) this.removeAttribute('size');
    else this.setAttribute('size', value);
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Resolve the displayed initials: explicit `initials`, else derived from `name`. */
  get resolvedInitials(): string {
    const explicit = this.initials;
    if (explicit != null && explicit.trim() !== '')
      return explicit.trim().slice(0, 2).toUpperCase();
    return deriveInitials(this.name);
  }

  #applySize(value: string | null): void {
    if (value == null || value.trim() === '') this.style.removeProperty('--avatar-size');
    else this.style.setProperty('--avatar-size', value);
  }

  #onActivate = (): void => {
    this.dispatchEvent(new CustomEvent('slicc-avatar-click', { bubbles: true, composed: true }));
  };

  #onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.click();
    }
  };

  #render(): void {
    const src = this.src;
    const initials = this.resolvedInitials;
    const a11yLabel = this.label ?? this.name ?? initials;
    this.setAttribute('aria-label', a11yLabel);

    const inner = src
      ? `<img class="img" part="image" src="${escapeHtml(src)}" alt="${escapeHtml(a11yLabel)}">`
      : `<span class="ini" part="initials">${escapeHtml(initials)}</span>`;

    this.#root.innerHTML = `<style>${STYLE}</style><div class="me" part="avatar"><slot>${inner}</slot></div>`;
  }
}

/** Take up to 2 uppercase initials from a full name (first letters of first/last word). */
function deriveInitials(name: string | null): string {
  if (!name) return '';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

define('slicc-avatar', SliccAvatar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-avatar': SliccAvatar;
  }
}
