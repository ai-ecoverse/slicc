import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';

/**
 * Scoped, document-level stylesheet for `<slicc-action-row>`. Light-DOM
 * components cannot carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the host
 * tag + scoped class.
 *
 * Faithful to the prototype `.act` / `.acth` / `.actb` rules
 * (proto/StellarRubySwift.html): the quiet, feed-style expandable tool row used
 * for `edit_file`, `playwright`, `vitest`, `mcp`, `upskill`, … . The header is
 * always visible; the monospace body expands when the host gains `[open]`
 * (prototype `.act.open`), rotating the chevron 90°. Everything is var-driven
 * (--txt-2/3 / --ink / --ghost / --line / --mono / --violet / --amber / --cyan)
 * so dark mode flips automatically via the inherited theme scope. The body
 * syntax colors (`.add`/`.del`/`.ok`/`.p`) are the prototype's fixed light-body
 * values; only `.mut` follows the theme.
 */
const STYLE = `
slicc-action-row {
  display: block;
  margin: -2px 0 16px;
  font-family: var(--ui);
}
slicc-action-row .slicc-act__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--txt-2);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}
slicc-action-row .slicc-act__head:hover {
  background: var(--ghost);
}
slicc-action-row .slicc-act__head:focus-visible {
  outline: 2px solid var(--violet);
  outline-offset: 1px;
}
slicc-action-row .slicc-act__ic {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  font-size: 10px;
  color: #fff;
  background: var(--ink);
  flex: 0 0 auto;
}
slicc-action-row .slicc-act__ic.vi { background: var(--violet); }
slicc-action-row .slicc-act__ic.am { background: var(--amber); }
slicc-action-row .slicc-act__ic.cy { background: var(--cyan); }
slicc-action-row .slicc-act__ic.gh { background: #1f2328; }
slicc-action-row .slicc-act__label {
  color: var(--ink);
  font-weight: 500;
}
slicc-action-row .slicc-act__badge {
  margin-left: auto;
  color: var(--txt-3);
}
slicc-action-row .slicc-act__badge:empty {
  display: none;
}
slicc-action-row .slicc-act__chev {
  color: var(--txt-3);
  transition: transform 0.15s;
}
slicc-action-row[open] .slicc-act__chev {
  transform: rotate(90deg);
}
slicc-action-row .slicc-act__body {
  display: none;
  margin: 3px 0 0 28px;
  background: var(--ghost);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 9px 11px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  color: var(--txt-2);
}
slicc-action-row[open] .slicc-act__body {
  display: block;
}
slicc-action-row .slicc-act__body .add { color: #1a7f37; }
slicc-action-row .slicc-act__body .del { color: #cf222e; }
slicc-action-row .slicc-act__body .ok  { color: #1a7f37; }
slicc-action-row .slicc-act__body .p   { color: #6b6b6b; }
slicc-action-row .slicc-act__body .mut { color: var(--txt-3); }
slicc-action-row .vlink {
  color: var(--violet);
  font-weight: 600;
  text-decoration: none;
  border-bottom: 1px dotted color-mix(in srgb, var(--violet) 55%, transparent);
  cursor: pointer;
}
slicc-action-row .vlink:hover {
  border-bottom-style: solid;
}
`;

const STYLE_ID = 'slicc-action-row-style';

/** Inject the scoped action-row stylesheet into a document once (idempotent). */
function ensureActionRowStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Accepted icon tones; anything else falls back to the default ink chip. */
const TONES = new Set(['ink', 'vi', 'am', 'cy', 'gh']);

/**
 * `<slicc-action-row>` — the prototype's quiet, feed-style expandable tool row
 * (`.act` / `.acth` / `.actb`): a full-width header button with a square glyph
 * chip (`.ic`), a label (`.al`, which may carry a `.vlink` filename), a
 * right-aligned result badge (`.ab`), and a chevron (`.acx`); below it a hidden
 * monospace command/diff body (`.actb`) that expands on click and rotates the
 * chevron 90°. Used for `edit_file`, `playwright`, `vitest`, `mcp`, `upskill`, …
 *
 * Light DOM (no shadow root): the host renders its own scaffold and relocates
 * light children into named regions so the host app can style it and slot rich
 * content. Children with `slot="body"` land in the monospace body region;
 * everything else (the default/unnamed slot, e.g. a `.vlink` label) lands in the
 * header label. The body markup carries the prototype's syntax classes
 * (`.add`/`.del`/`.ok`/`.p`/`.mut`).
 *
 * Clicking the header toggles `[open]` and fires `slicc-action-row-toggle`.
 *
 * @attr open - boolean; expands the body and rotates the chevron (prototype `.act.open`)
 * @attr icon - glyph character for the square chip (e.g. `✎`, `◳`, `✓`, `⎇`)
 * @attr tone - chip tone: `ink` (default) | `vi` | `am` | `cy` | `gh`
 * @attr label - header label text (escaped); falls back to slotted/default content
 * @attr result - right-aligned result badge text (escaped); hidden when empty
 * @csspart head - the full-width header button
 * @csspart icon - the square glyph chip
 * @csspart label - the header label region
 * @csspart badge - the right-aligned result badge
 * @csspart chevron - the disclosure chevron
 * @csspart body - the monospace command/diff body
 * @slot - default; header label content (e.g. a `.vlink` filename)
 * @slot body - the monospace command/diff output
 * @fires slicc-action-row-toggle - composed + bubbling; `detail.open` on toggle
 */
export class SliccActionRow extends HTMLElement {
  static readonly observedAttributes = ['open', 'icon', 'tone', 'label', 'result'];

  #head!: HTMLButtonElement;
  #icon!: HTMLElement;
  #label!: HTMLElement;
  #badge!: HTMLElement;
  #body!: HTMLElement;
  #built = false;
  #onClick = (): void => this.#toggle();

  connectedCallback(): void {
    ensureActionRowStyle(this.ownerDocument);
    this.#build();
    this.#sync();
  }

  disconnectedCallback(): void {
    this.#head?.removeEventListener('click', this.#onClick);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.#built) return;
    if (name === 'open') {
      this.#head.setAttribute('aria-expanded', String(newValue !== null));
      this.dispatchEvent(
        new CustomEvent('slicc-action-row-toggle', {
          bubbles: true,
          composed: true,
          detail: { open: newValue !== null },
        })
      );
    } else {
      this.#sync();
    }
  }

  /** Whether the body is expanded (prototype `.act.open`). */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  /** Glyph character shown in the square chip. */
  get icon(): string | null {
    return this.getAttribute('icon');
  }

  set icon(value: string | null) {
    if (value == null) this.removeAttribute('icon');
    else this.setAttribute('icon', value);
  }

  /** Chip tone — `ink` (default), `vi`, `am`, `cy`, or `gh`. */
  get tone(): 'ink' | 'vi' | 'am' | 'cy' | 'gh' {
    const t = this.getAttribute('tone');
    return t && TONES.has(t) ? (t as 'ink' | 'vi' | 'am' | 'cy' | 'gh') : 'ink';
  }

  set tone(value: 'ink' | 'vi' | 'am' | 'cy' | 'gh') {
    this.setAttribute('tone', value);
  }

  /** Header label text (escaped); falls back to slotted content when absent. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Right-aligned result badge text (escaped); hidden when empty. */
  get result(): string | null {
    return this.getAttribute('result');
  }

  set result(value: string | null) {
    if (value == null) this.removeAttribute('result');
    else this.setAttribute('result', value);
  }

  /** Toggle `[open]`; the `open` attribute change fires the toggle event. */
  #toggle(): void {
    this.open = !this.open;
  }

  /**
   * Build the header/body scaffold once and relocate any pre-existing light
   * children into the label/body regions. Idempotent — safe across re-connects.
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes).filter(
      (n) =>
        !(n instanceof HTMLElement && n.classList.contains('slicc-act__head')) &&
        !(n instanceof HTMLElement && n.classList.contains('slicc-act__body'))
    );

    this.#head = this.ownerDocument.createElement('button');
    this.#head.type = 'button';
    this.#head.className = 'slicc-act__head';
    this.#head.setAttribute('part', 'head');

    this.#icon = h('span', { class: 'slicc-act__ic', part: 'icon' });
    this.#label = h('span', { class: 'slicc-act__label', part: 'label' });
    this.#badge = h('span', { class: 'slicc-act__badge', part: 'badge' });
    append(this.#head, [
      this.#icon,
      this.#label,
      this.#badge,
      h('span', { class: 'slicc-act__chev', part: 'chevron', 'aria-hidden': 'true' }, '▸'),
    ]);

    this.#body = this.ownerDocument.createElement('div');
    this.#body.className = 'slicc-act__body';
    this.#body.setAttribute('part', 'body');

    // Slot pre-existing children: slot="body" → body region, rest → label.
    for (const node of incoming) {
      if (node instanceof HTMLElement && node.getAttribute('slot') === 'body') {
        this.#body.appendChild(node);
      } else {
        this.#label.appendChild(node);
      }
    }

    this.replaceChildren(this.#head, this.#body);
    this.#head.addEventListener('click', this.#onClick);
  }

  /** Reflect icon / tone / label / result attributes into the scaffold. */
  #sync(): void {
    if (!this.#built) return;

    const tone = this.tone;
    this.#icon.className = `slicc-act__ic${tone === 'ink' ? '' : ` ${tone}`}`;
    this.#icon.textContent = this.icon ?? '';

    // Only overwrite the label region when an explicit attribute is present,
    // so slotted (default-slot) content survives re-syncs.
    const label = this.label;
    if (label != null) this.#label.textContent = label;

    this.#head.setAttribute('aria-expanded', String(this.open));
    this.#badge.textContent = this.result ?? '';
  }
}

define('slicc-action-row', SliccActionRow);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-action-row': SliccActionRow;
  }
}
