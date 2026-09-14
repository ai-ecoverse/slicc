import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

import '../primitives/slicc-snowflake.js';

const STYLE = `
slicc-freezer-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
  flex: 0 0 auto;
  font-family: var(--ui);
  transition: background-color 0.15s;
}
/* Collapsed (icon-only) rail rows get a hover title — the session name appears
   as a dark pill to the right of the badge, mirroring the dock rail's tip.
   The pill is VIEWPORT-FIXED (coords stamped on hover from the row's rect):
   the freezer host clips its overflow for the width animation, so an
   absolutely-positioned tip hanging outside the 44px rail would be cut off. */
slicc-freezer-card .slicc-fzcard__tip {
  position: fixed; left: var(--tip-x, 0); top: var(--tip-y, 0);
  transform: translateY(-50%) translateX(-3px);
  z-index: 30; background: var(--ink); color: var(--canvas, #fff);
  font: 500 11px var(--ui); white-space: nowrap; padding: 3px 8px; border-radius: 6px;
  box-shadow: 0 4px 12px -4px rgba(10,10,10,.3);
  opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease; display: none;
}
slicc-freezer-card:not([expanded]) .slicc-fzcard__tip { display: block; }
slicc-freezer-card:not([expanded]):hover .slicc-fzcard__tip,
slicc-freezer-card:not([expanded]):focus-within .slicc-fzcard__tip { opacity: 1; transform: translateY(-50%); }
slicc-freezer-card .slicc-fzcard__tip:empty { display: none; }
@media (prefers-reduced-motion: reduce) {
  slicc-freezer-card .slicc-fzcard__tip,
  slicc-freezer-card slicc-snowflake::part(badge) { transition: none; }
}
slicc-freezer-card[hidden] {
  display: none;
}
slicc-freezer-card:not([expanded]) {
  gap: 0;
  justify-content: center;
  padding: 4px 0;
}
slicc-freezer-card[expanded]:hover {
  background: var(--ghost);
}
/* Collapsed (icon-only) hover: a full-row ghost fill reads as a clashing
   rectangle around the lone centered badge, so swap it for a soft circular ring
   hugging the snowflake (painted on its ::part(badge) circle, which carries the
   50% radius) — the affordance reads as a ring, not a rectangle. Token-based. */
slicc-freezer-card slicc-snowflake::part(badge) {
  transition: box-shadow 0.15s;
}
slicc-freezer-card:not([expanded]):hover slicc-snowflake::part(badge),
slicc-freezer-card:not([expanded]):focus-within slicc-snowflake::part(badge) {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ctx) 35%, var(--line));
}
slicc-freezer-card .slicc-fzcard__text {
  flex: 1;
  min-width: 0;
  opacity: 0;
  transition: opacity 0.18s;
}
slicc-freezer-card:not([expanded]) .slicc-fzcard__text {
  width: 0;
  min-width: 0;
  flex: 0 0 0;
  overflow: hidden;
}
slicc-freezer-card[expanded] .slicc-fzcard__text {
  opacity: 1;
  transition: opacity 0.25s 0.15s;
}
slicc-freezer-card .slicc-fzcard__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
slicc-freezer-card .slicc-fzcard__meta {
  margin-top: 2px;
  font-family: var(--ui);
  font-size: 10.5px;
  color: var(--txt-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
slicc-freezer-card[thawed] {
  background: color-mix(in srgb, var(--rose) 12%, transparent);
}
`;

const STYLE_ID = 'slicc-freezer-card-style';

function ensureFreezerCardStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const THAW_MS = 1400;

const ICON_SIZE = 14;

export class SliccFreezerCard extends HTMLElement {
  static readonly observedAttributes = ['title', 'meta', 'slug', 'icon', 'thawed'];

  #badge!: HTMLElement;
  #text!: HTMLElement;
  #title!: HTMLElement;
  #meta!: HTMLElement;
  #tip: HTMLElement | null = null;

  #iconNode: SVGSVGElement | null = null;
  #built = false;
  #thawTimer: ReturnType<typeof setTimeout> | null = null;
  #onClick = (): void => this.#select();

  #onTipAnchor = (): void => {
    if (!this.#tip) return;
    const rect = this.getBoundingClientRect();
    this.#tip.style.setProperty('--tip-x', `${rect.right + 8}px`);
    this.#tip.style.setProperty('--tip-y', `${rect.top + rect.height / 2}px`);
  };

  connectedCallback(): void {
    ensureFreezerCardStyle(this.ownerDocument);
    this.#build();
    this.#sync();
  }

  disconnectedCallback(): void {
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('pointerenter', this.#onTipAnchor);
    this.removeEventListener('focusin', this.#onTipAnchor);
    if (this.#thawTimer != null) {
      clearTimeout(this.#thawTimer);
      this.#thawTimer = null;
    }
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.#built) return;
    if (name === 'thawed') {
      this.#badge.toggleAttribute('thawed', newValue !== null);
    } else if (name === 'icon') {
      this.#syncIcon();
    } else {
      this.#sync();
    }
  }

  get title(): string {
    return this.getAttribute('title') ?? '';
  }

  set title(value: string | null) {
    if (value == null) this.removeAttribute('title');
    else this.setAttribute('title', value);
  }

  get meta(): string {
    return this.getAttribute('meta') ?? '';
  }

  set meta(value: string | null) {
    if (value == null) this.removeAttribute('meta');
    else this.setAttribute('meta', value);
  }

  get slug(): string {
    return this.getAttribute('slug') ?? '';
  }

  set slug(value: string | null) {
    if (value == null) this.removeAttribute('slug');
    else this.setAttribute('slug', value);
  }

  get icon(): string | null {
    return this.getAttribute('icon');
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  get expanded(): boolean {
    return this.hasAttribute('expanded');
  }

  set expanded(value: boolean) {
    this.toggleAttribute('expanded', value);
  }

  get thawed(): boolean {
    return this.hasAttribute('thawed');
  }

  set thawed(value: boolean) {
    this.toggleAttribute('thawed', value);
  }

  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }

  set hidden(value: boolean) {
    this.toggleAttribute('hidden', value);
  }

  get badge(): HTMLElement {
    this.#build();
    return this.#badge;
  }

  #select(): void {
    this.dispatchEvent(
      new CustomEvent('freezer-card-select', {
        bubbles: true,
        composed: true,
        detail: { slug: this.slug },
      })
    );
    this.flashThaw();
  }

  flashThaw(duration: number = THAW_MS): void {
    if (this.#thawTimer != null) clearTimeout(this.#thawTimer);
    this.thawed = true;
    this.#thawTimer = setTimeout(() => {
      this.thawed = false;
      this.#thawTimer = null;
    }, duration);
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    const existing = this.querySelector(':scope > .slicc-fzcard__text');
    if (existing instanceof HTMLElement) {
      this.#text = existing;
      this.#title = existing.querySelector('.slicc-fzcard__title') as HTMLElement;
      this.#meta = existing.querySelector('.slicc-fzcard__meta') as HTMLElement;
      this.#badge = this.querySelector(':scope > slicc-snowflake') as HTMLElement;
      this.#tip = this.querySelector(':scope > .slicc-fzcard__tip');
      this.addEventListener('click', this.#onClick);
      this.addEventListener('pointerenter', this.#onTipAnchor);
      this.addEventListener('focusin', this.#onTipAnchor);
      return;
    }

    const incoming = Array.from(this.childNodes);

    this.#badge = this.ownerDocument.createElement('slicc-snowflake');
    this.#badge.setAttribute('part', 'badge');

    this.#title = h('div', { class: 'slicc-fzcard__title', part: 'title' });
    this.#meta = h('div', { class: 'slicc-fzcard__meta', part: 'meta' });
    this.#text = h('div', { class: 'slicc-fzcard__text', part: 'text' }, this.#title, this.#meta);

    for (const node of incoming) this.#title.appendChild(node);

    this.#tip = h('span', { class: 'slicc-fzcard__tip', part: 'tip', 'aria-hidden': 'true' });

    this.replaceChildren(this.#badge, this.#text, this.#tip);
    this.addEventListener('click', this.#onClick);
    this.addEventListener('pointerenter', this.#onTipAnchor);
    this.addEventListener('focusin', this.#onTipAnchor);
  }

  #sync(): void {
    if (!this.#built) return;

    const title = this.getAttribute('title');
    if (title != null) this.#title.textContent = title;

    this.#meta.textContent = this.meta;

    if (this.#tip) this.#tip.textContent = title ?? (this.#title.textContent || '');
    this.#badge.toggleAttribute('thawed', this.thawed);
    this.#syncIcon();
  }

  #syncIcon(): void {
    if (!this.#built) return;
    const name = this.getAttribute('icon');
    if (name) {
      const next = iconEl(name, { size: ICON_SIZE, class: 'ic', part: 'icon' });
      if (this.#iconNode) this.#iconNode.replaceWith(next);
      else this.#badge.appendChild(next);
      this.#iconNode = next;
    } else if (this.#iconNode) {
      this.#iconNode.remove();
      this.#iconNode = null;
    }
  }
}

define('slicc-freezer-card', SliccFreezerCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-freezer-card': SliccFreezerCard;
  }
}
