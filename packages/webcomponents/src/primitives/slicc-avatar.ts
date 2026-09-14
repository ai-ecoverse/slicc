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

export class SliccAvatar extends HTMLElement {
  static readonly observedAttributes = ['initials', 'name', 'src', 'email', 'size', 'label'];

  readonly #root: ShadowRoot;

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

  get resolvedInitials(): string {
    const explicit = this.initials;
    if (explicit != null && explicit.trim() !== '')
      return explicit.trim().slice(0, 2).toUpperCase();
    return deriveInitials(this.name) || '?';
  }

  async gravatarUrl(email: string | null = this.email): Promise<string | null> {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) return null;
    const hex = await sha256Hex(normalized);
    const s = this.#gravatarPx();
    return `https://www.gravatar.com/avatar/${hex}?s=${s}&d=404`;
  }

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
    const token = ++this.#gravatarToken;

    const src = this.src;
    const email = this.email;
    const initials = this.resolvedInitials;

    const a11yLabel = this.label ?? this.name ?? (initials === '?' ? 'Account' : initials);
    this.setAttribute('aria-label', a11yLabel);

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

    if (!src && email) this.#applyGravatar(email, token);
  }

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

        probe.src = url;
      })
      .catch(() => {});
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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
