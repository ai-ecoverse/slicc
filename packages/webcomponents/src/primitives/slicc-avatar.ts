import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

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
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  /* The rainbow gradient stays the ground behind the (optional) gravatar image. */
  background: var(--rainbow);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
/* When a gravatar or src image has resolved, layer it over the rainbow ground
   and hide the initials (the image is the foreground; rainbow + initials remain
   underneath as the fallback if image loading fails). */
.me.has-img { color: transparent; }
.img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
  display: block;
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-avatar>` — the circular user avatar from the prototype nav (`.me`).
 * A `--ctl-h` square with a `--rainbow` gradient fill and white initials,
 * grid-centered.
 *
 * Source precedence: an explicit `src` image wins; otherwise an `email` resolves
 * to a Gravatar (SHA-256 of the trimmed+lowercased address, `d=404` so a missing
 * gravatar falls back to initials); otherwise the explicit `initials`, then up to
 * 2 uppercase initials derived from `name`. With none of those — a signed-out
 * user — it shows a `?` placeholder. For both the `email` and explicit-`src`
 * paths the initials render immediately as the base content and the image is
 * layered on top once it loads — an `error` (CSP block, 404, network error)
 * swaps back to the initials so a failed load never shows a broken-image icon.
 *
 * Acts as a button for an account menu: clicking (or Enter/Space) emits a
 * composed, bubbling `slicc-avatar-click` event in addition to the native click.
 *
 * The rainbow fill + white text are fixed in both light and dark themes
 * (matching the prototype). Sizing is the inherited `--ctl-h`, overridable via
 * the `size` attribute (any CSS length).
 *
 * @attr initials - explicit initials to display (e.g. "PM"); wins over `name`
 * @attr name - full name; up to 2 uppercase initials are derived when `initials` is absent
 * @attr email - optional email; resolves to a Gravatar (SHA-256, `d=404`) shown behind initials
 * @attr src - optional image URL; renders an image-backed avatar instead of initials (wins over `email`)
 * @attr size - optional CSS length overriding the default `--ctl-h` square
 * @attr label - optional accessible label (defaults to `name`, then the initials)
 * @fires slicc-avatar-click - composed + bubbling; user activated the avatar (account menu)
 * @csspart avatar - the inner circular container
 * @csspart initials - the initials text node
 * @csspart image - the cover image node (when `src` is set)
 */
export class SliccAvatar extends HTMLElement {
  static readonly observedAttributes = ['initials', 'name', 'src', 'email', 'size', 'label'];

  readonly #root: ShadowRoot;
  /** Monotonic token guarding async gravatar + `src` image swaps against stale resolutions. */
  #gravatarToken = 0;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    this.addEventListener('click', this.#onActivate);
    this.addEventListener('keydown', this.#onKeydown);
  }

  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button');
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this.#render();
  }

  disconnectedCallback(): void {
    // Invalidate any in-flight gravatar / `src` image swap so a late resolution is ignored.
    this.#gravatarToken++;
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

  get email(): string | null {
    return this.getAttribute('email');
  }

  set email(value: string | null) {
    if (value == null) this.removeAttribute('email');
    else this.setAttribute('email', value);
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

  /**
   * Resolve the displayed glyph: explicit `initials`, else initials derived
   * from `name`, else a `?` placeholder for a signed-out user with no identity.
   */
  get resolvedInitials(): string {
    const explicit = this.initials;
    if (explicit != null && explicit.trim() !== '')
      return explicit.trim().slice(0, 2).toUpperCase();
    return deriveInitials(this.name) || '?';
  }

  /**
   * Compute the Gravatar URL for the current `email` (or an explicit address):
   * `https://www.gravatar.com/avatar/<sha256-hex>?s=<2x px>&d=404`. Returns
   * `null` when there is no email. Gravatar supports SHA-256 hashes; `d=404`
   * makes a missing gravatar fail to load so the initials remain.
   */
  async gravatarUrl(email: string | null = this.email): Promise<string | null> {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) return null;
    const hex = await sha256Hex(normalized);
    const s = this.#gravatarPx();
    return `https://www.gravatar.com/avatar/${hex}?s=${s}&d=404`;
  }

  /** Rendered avatar size in CSS pixels at 2× (for the gravatar `s=` param). */
  #gravatarPx(): number {
    const measured = this.getBoundingClientRect().width;
    const base = measured > 0 ? measured : 30;
    return Math.max(1, Math.round(base * 2));
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
    // Any pending image swap from a previous render is now stale (guards both
    // the async gravatar preload and the layered explicit-`src` load/error).
    const token = ++this.#gravatarToken;

    const src = this.src;
    const email = this.email;
    const initials = this.resolvedInitials;
    // Never announce the bare `?` placeholder — fall back to "Account".
    const a11yLabel = this.label ?? this.name ?? (initials === '?' ? 'Account' : initials);
    this.setAttribute('aria-label', a11yLabel);

    // Initials are always the base content so a failed image load leaves them
    // visible rather than a broken-image icon. Precedence remains: explicit
    // `src` > `email` (gravatar) > initials/name — the foreground image just
    // layers over the same initials underneath.
    const initialsNode = h('span', { class: 'ini', part: 'initials' }, initials);
    const slotChildren: HTMLElement[] = [initialsNode];
    if (src) {
      const img = h('img', {
        class: 'img',
        part: 'image',
        src,
        alt: a11yLabel,
      }) as HTMLImageElement;
      img.addEventListener('load', () => {
        if (token !== this.#gravatarToken) return;
        this.#root.querySelector<HTMLElement>('.me')?.classList.add('has-img');
      });
      img.addEventListener('error', () => {
        if (token !== this.#gravatarToken) return;
        img.remove();
        this.#root.querySelector<HTMLElement>('.me')?.classList.remove('has-img');
      });
      slotChildren.push(img);
    }

    const me = h('div', { class: 'me', part: 'avatar' }, h('slot', null, ...slotChildren));
    this.#root.replaceChildren(me);

    // Gravatar only applies when there is no explicit image; render initials now
    // and async-swap to the gravatar background once the hash resolves and the
    // image is confirmed to load (a 404 keeps the initials in place).
    if (!src && email) this.#applyGravatar(email, token);
  }

  /**
   * Resolve `email` → gravatar URL, preload it, and (if it loads, the request is
   * still current, and the element is connected) set it as the `.me`
   * background-image over the rainbow ground. A 404 (`d=404`) errors the preload
   * and leaves the initials untouched.
   */
  #applyGravatar(email: string, token: number): void {
    void this.gravatarUrl(email)
      .then((url) => {
        if (!url || token !== this.#gravatarToken) return;
        const probe = new Image();
        probe.onload = () => {
          if (token !== this.#gravatarToken || !this.isConnected) return;
          const me = this.#root.querySelector<HTMLElement>('.me');
          if (!me) return;
          me.style.backgroundImage = `url("${url}")`;
          me.classList.add('has-img');
        };
        // onerror (incl. d=404) intentionally leaves the initials in place.
        probe.src = url;
      })
      .catch(() => {
        /* digest unavailable / rejected — keep initials. */
      });
  }
}

/** Hex-encode a SHA-256 digest of `input` using the Web Crypto SubtleCrypto API. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
