import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
// Renders these child custom elements internally — owns their registration.
import '../primitives/slicc-snowflake.js';

/**
 * Scoped, document-level stylesheet for `<slicc-freezer-card>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag + scoped
 * class.
 *
 * Lifted faithfully from the prototype (`proto/StellarRubySwift.html`
 * `.freezer .fzcard` / `.snow` / `.ftext` / `.fzt` / `.fzm` / `.fzcard.thawed` /
 * `.fzcard.match-hidden`): one frozen-session row in the left "freezer" rail. A
 * clickable row with a leading 28px circular snowflake badge (composed here by
 * tag as `<slicc-snowflake>`) and a two-line `.ftext` block (title + meta).
 *
 * The freezer rail collapses to an icon-only strip; the prototype drives that via
 * the parent `.freezer:not(.open)`. Here each card owns its own `expanded`
 * attribute so it is independently demonstrable: collapsed (no `expanded`) zeroes
 * the gap, centers the badge, and collapses the text to zero width (badge only);
 * `expanded` fades the title+meta back in. Hovering an expanded row paints the
 * ghost background; hovering a collapsed (icon-only) row instead paints a soft
 * circular ring around the badge (a ring, not a rectangle), and
 * `thawed` flips the row into the rose flash (and is mirrored onto the badge) for
 * the ~1400ms reopen animation. `hidden` is the prototype's `.match-hidden`
 * search-hide.
 *
 * Everything is var-driven (--ghost / --line / --ink / --txt-3 / --canvas /
 * --rose / --ui) so dark mode flips automatically via the inherited theme scope;
 * there is no explicit dark override, exactly like the prototype.
 */
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
   as a dark pill to the right of the badge, mirroring the dock rail's tip. */
slicc-freezer-card .slicc-fzcard__tip {
  position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%) translateX(-3px);
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
   hugging the snowflake (painted on its `::part(badge)` circle, which carries the
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

/** Inject the scoped freezer-card stylesheet into a document once (idempotent). */
function ensureFreezerCardStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Prototype thaw-flash duration (`setTimeout(…, 1400)` on the freezer card). */
const THAW_MS = 1400;

/** Rendered lucide glyph size (px) for a custom `icon`, matching the snowflake badge. */
const ICON_SIZE = 14;

/**
 * `<slicc-freezer-card>` — one frozen-session row from the prototype's left
 * "freezer" rail (`.freezer .fzcard`). A clickable row with a leading 28px
 * circular snowflake badge — composed by tag as `<slicc-snowflake>` (an earlier
 * wave element), so the rose "thawing" flash propagates to the badge — and a
 * `.ftext` block carrying a single-line `.fzt` title and `.fzm` meta line.
 *
 * The badge shows the lucide `snowflake` glyph by default; setting the `icon`
 * attribute to any lucide name (e.g. `flame`, `git-branch`) renders that glyph
 * inside the same circular badge instead, so a card can carry a per-session icon
 * while keeping the snowflake as the default. The custom glyph still inherits the
 * badge's `currentColor`, so it tracks the frozen / thawed palette too.
 *
 * Light DOM (no shadow root): the host renders its own scaffold and relocates any
 * pre-existing light children into the title region, so the host app can style
 * the row and slot rich title content. The `title` / `meta` attributes, when
 * present, win over slotted content.
 *
 * Variants/states (all CSS-driven off host attributes):
 * - collapsed (no `expanded`): gap 0, badge centered, `.ftext` width 0 — badge
 *   only (mirrors the prototype's `.freezer:not(.open)` icon strip).
 * - expanded (`expanded`): the title + meta fade back in.
 * - hover: expanded rows get the ghost background; collapsed rows get a soft
 *   circular ring around the badge instead of a rectangular fill.
 * - thawed (`thawed`): the rose row + rose badge shown for ~1400ms on reopen.
 * - search-hidden (`hidden`): `display: none` (the prototype's `.match-hidden`).
 *
 * Clicking the row fires `freezer-card-select` (`detail.slug`) and runs a
 * transient thaw flash: it sets `thawed` on the card (and mirrors it onto the
 * inner `<slicc-snowflake>`), then clears it after ~1400ms. The host's own
 * "reopen" logic listens for the event.
 *
 * @attr title - the session heading (escaped); falls back to slotted content
 * @attr meta - the meta line, e.g. "2h ago · 18 turns · PR #128" (escaped)
 * @attr slug - the session id, surfaced in the `freezer-card-select` detail
 * @attr icon - optional lucide icon name; overrides the default snowflake glyph
 * @attr expanded - boolean; fades the title+meta in (collapsed = badge only)
 * @attr thawed - boolean; the rose reopen flash (mirrored onto the badge)
 * @attr hidden - boolean; search-hide (the prototype's `.match-hidden`)
 * @csspart badge - the leading `<slicc-snowflake>` badge
 * @csspart text - the `.ftext` title+meta column
 * @csspart title - the `.fzt` session heading
 * @csspart meta - the `.fzm` meta line
 * @slot - default; title content, used when the `title` attribute is absent
 * @fires freezer-card-select - composed + bubbling; `detail.slug` on click
 */
export class SliccFreezerCard extends HTMLElement {
  static readonly observedAttributes = ['title', 'meta', 'slug', 'icon', 'thawed'];

  #badge!: HTMLElement;
  #text!: HTMLElement;
  #title!: HTMLElement;
  #meta!: HTMLElement;
  #tip: HTMLElement | null = null;
  /** The custom lucide glyph slotted into the badge when `icon` is set. */
  #iconNode: SVGSVGElement | null = null;
  #built = false;
  #thawTimer: ReturnType<typeof setTimeout> | null = null;
  #onClick = (): void => this.#select();

  connectedCallback(): void {
    ensureFreezerCardStyle(this.ownerDocument);
    this.#build();
    this.#sync();
  }

  disconnectedCallback(): void {
    this.removeEventListener('click', this.#onClick);
    if (this.#thawTimer != null) {
      clearTimeout(this.#thawTimer);
      this.#thawTimer = null;
    }
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.#built) return;
    if (name === 'thawed') {
      // Mirror the row's rose flash onto the badge (prototype `.fzcard.thawed .snow`).
      this.#badge.toggleAttribute('thawed', newValue !== null);
    } else if (name === 'icon') {
      this.#syncIcon();
    } else {
      this.#sync();
    }
  }

  /** The session heading (`.fzt`). Falls back to slotted content when absent. */
  get title(): string {
    return this.getAttribute('title') ?? '';
  }

  set title(value: string | null) {
    if (value == null) this.removeAttribute('title');
    else this.setAttribute('title', value);
  }

  /** The meta line (`.fzm`), e.g. "2h ago · 18 turns · PR #128". */
  get meta(): string {
    return this.getAttribute('meta') ?? '';
  }

  set meta(value: string | null) {
    if (value == null) this.removeAttribute('meta');
    else this.setAttribute('meta', value);
  }

  /** Session id, surfaced in the `freezer-card-select` detail. */
  get slug(): string {
    return this.getAttribute('slug') ?? '';
  }

  set slug(value: string | null) {
    if (value == null) this.removeAttribute('slug');
    else this.setAttribute('slug', value);
  }

  /** Optional lucide icon name; overrides the default snowflake glyph when set. */
  get icon(): string | null {
    return this.getAttribute('icon');
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  /** Whether the title+meta are faded in (collapsed = badge only). */
  get expanded(): boolean {
    return this.hasAttribute('expanded');
  }

  set expanded(value: boolean) {
    this.toggleAttribute('expanded', value);
  }

  /** Whether the row is in the rose "thawing" flash (mirrored onto the badge). */
  get thawed(): boolean {
    return this.hasAttribute('thawed');
  }

  set thawed(value: boolean) {
    this.toggleAttribute('thawed', value);
  }

  /** Whether the card is search-hidden (the prototype's `.match-hidden`). */
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }

  set hidden(value: boolean) {
    this.toggleAttribute('hidden', value);
  }

  /** The leading `<slicc-snowflake>` badge (`part="badge"`). */
  get badge(): HTMLElement {
    this.#build();
    return this.#badge;
  }

  /**
   * Fire `freezer-card-select` and run the transient thaw flash: set `thawed`
   * (which mirrors onto the badge) and clear it after ~1400ms — matching the
   * prototype's `c.classList.add('thawed'); setTimeout(…, 1400)`.
   */
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

  /**
   * Run the rose thaw flash once: set `thawed` and clear it after ~1400ms. Safe
   * to call repeatedly — a pending flash is restarted rather than stacked.
   */
  flashThaw(duration: number = THAW_MS): void {
    if (this.#thawTimer != null) clearTimeout(this.#thawTimer);
    this.thawed = true;
    this.#thawTimer = setTimeout(() => {
      this.thawed = false;
      this.#thawTimer = null;
    }, duration);
  }

  /**
   * Build the badge + text scaffold once and relocate any pre-existing light
   * children into the title region. Idempotent — safe across re-connects (light
   * DOM survives a move, so the already-built scaffold is reused).
   */
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
      return;
    }

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes);

    this.#badge = this.ownerDocument.createElement('slicc-snowflake');
    this.#badge.setAttribute('part', 'badge');

    this.#title = h('div', { class: 'slicc-fzcard__title', part: 'title' });
    this.#meta = h('div', { class: 'slicc-fzcard__meta', part: 'meta' });
    this.#text = h('div', { class: 'slicc-fzcard__text', part: 'text' }, this.#title, this.#meta);

    // Slot pre-existing children into the title region (used when the `title`
    // attribute is absent).
    for (const node of incoming) this.#title.appendChild(node);

    // Collapsed-rail hover title (only visible when not expanded).
    this.#tip = h('span', { class: 'slicc-fzcard__tip', part: 'tip', 'aria-hidden': 'true' });

    this.replaceChildren(this.#badge, this.#text, this.#tip);
    this.addEventListener('click', this.#onClick);
  }

  /** Reflect title / meta / slug / thawed attributes into the scaffold. */
  #sync(): void {
    if (!this.#built) return;

    // Only overwrite the title region when an explicit attribute is present, so
    // slotted (default-slot) content survives re-syncs.
    const title = this.getAttribute('title');
    if (title != null) this.#title.textContent = title;

    this.#meta.textContent = this.meta;
    // The collapsed-rail hover title mirrors the session heading.
    if (this.#tip) this.#tip.textContent = title ?? (this.#title.textContent || '');
    this.#badge.toggleAttribute('thawed', this.thawed);
    this.#syncIcon();
  }

  /**
   * Reflect the `icon` attribute onto the badge: a custom lucide glyph is slotted
   * into the `<slicc-snowflake>` (overriding its default snowflake fallback), or
   * removed to fall back to the snowflake. The glyph inherits the badge's
   * `currentColor`, so it tracks the frozen / thawed palette.
   */
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
