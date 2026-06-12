import { define } from '../internal/define.js';
// Renders these child custom elements internally — owns their registration.
import './slicc-memtag.js';

/**
 * Scoped, document-level stylesheet for `<slicc-memrow>`. A light-DOM component
 * can't carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the prototype hooks.
 *
 * Lifted verbatim from the prototype's memory panel
 * (`proto/StellarRubySwift.html` `.memrow` / `.mt` / `.ms` / `.memrow.fresh`):
 * a bordered, rounded card whose header row (`.mt`) carries a bold title and a
 * right-pinned tag, above a muted summary (`.ms`). The `fresh` variant tints the
 * border + background rose to flag the newest memory.
 *
 * The `.mtag.*` rules are the prototype's own inline-tag styling; they are kept
 * here as a faithful fallback for the right-aligned `<slicc-memtag>` (and for the
 * prototype-style `.mtag` span the row renders alongside it), so the row reads
 * correctly even before the sibling element registers. Dark-mode rules rebase
 * the rose/cyan/violet tints over `var(--canvas)` (instead of the prototype's
 * hardcoded `#fff`) so tinted surfaces stay dark — matching the prototype's
 * `body.dark` overrides, generalised to the library's `.dark` /
 * `[data-theme="dark"]` theme scopes.
 */
const STYLE = `
slicc-memrow {
  display: block;
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 11px 13px;
  margin-bottom: 9px;
  font-family: var(--ui);
  color: var(--ink);
}
slicc-memrow .mt {
  display: flex;
  align-items: center;
  gap: 8px;
}
slicc-memrow .mt b {
  font-size: 13px;
  font-weight: 600;
}
slicc-memrow .mtag {
  margin-left: auto;
  font-family: var(--ui);
  font-size: 10px;
  border-radius: 26px;
  padding: 1px 8px;
}
slicc-memrow slicc-memtag {
  margin-left: auto;
}
slicc-memrow .ms {
  font-size: 12.5px;
  color: var(--txt-2);
  margin-top: 5px;
  line-height: 1.5;
}
slicc-memrow .mtag.us {
  color: var(--rose);
  background: color-mix(in srgb, var(--rose) 12%, #fff);
  border: 1px solid color-mix(in srgb, var(--rose) 28%, var(--line));
}
slicc-memrow .mtag.fb {
  color: var(--cyan);
  background: color-mix(in srgb, var(--cyan) 12%, #fff);
  border: 1px solid color-mix(in srgb, var(--cyan) 28%, var(--line));
}
slicc-memrow .mtag.pj {
  color: var(--violet);
  background: color-mix(in srgb, var(--violet) 12%, #fff);
  border: 1px solid color-mix(in srgb, var(--violet) 28%, var(--line));
}
slicc-memrow.fresh {
  border-color: color-mix(in srgb, var(--rose) 45%, var(--line));
  background: color-mix(in srgb, var(--rose) 7%, #fff);
}
.dark slicc-memrow.fresh,
[data-theme="dark"] slicc-memrow.fresh {
  background: color-mix(in srgb, var(--rose) 16%, var(--canvas));
  border-color: color-mix(in srgb, var(--rose) 40%, var(--line));
}
.dark slicc-memrow .mtag.us,
[data-theme="dark"] slicc-memrow .mtag.us {
  background: color-mix(in srgb, var(--rose) 22%, var(--canvas));
  border-color: color-mix(in srgb, var(--rose) 38%, var(--line));
}
.dark slicc-memrow .mtag.fb,
[data-theme="dark"] slicc-memrow .mtag.fb {
  background: color-mix(in srgb, var(--cyan) 22%, var(--canvas));
  border-color: color-mix(in srgb, var(--cyan) 38%, var(--line));
}
.dark slicc-memrow .mtag.pj,
[data-theme="dark"] slicc-memrow .mtag.pj {
  background: color-mix(in srgb, var(--violet) 22%, var(--canvas));
  border-color: color-mix(in srgb, var(--violet) 38%, var(--line));
}
`;

const STYLE_ID = 'slicc-memrow-style';

/** Inject the scoped memrow stylesheet into a document once (idempotent). */
function ensureMemrowStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Memory-tag kinds, in the prototype's vocabulary. */
export type MemTag = 'user' | 'feedback' | 'project';

/** Coerce an arbitrary string to a known {@link MemTag}, defaulting to `user`. */
function normalizeTag(value: string | null): MemTag {
  return value === 'feedback' || value === 'project' ? value : 'user';
}

/**
 * `<slicc-memrow>` — a single memory entry from the prototype's memory panel
 * (`.memrow`). A bordered, rounded card with a header row (`.mt`) carrying a bold
 * title and a right-pinned tag (`<slicc-memtag>` by `tag`), above a muted summary
 * (`.ms`). The `fresh` variant rose-tints the border + background to flag the
 * newest memory; in dark mode that tint rebases over `var(--canvas)`.
 *
 * Light DOM (no shadow root): the host renders its own `.mt` / `.ms` chrome into
 * itself and relocates any caller-supplied children into the card (extra summary
 * content) so the host app can style and slot content. The scoped stylesheet
 * (above) is injected once into the host document.
 *
 * Internal DOM (light DOM):
 *
 *     <slicc-memrow class="fresh">
 *       <div class="mt">
 *         <b>…title…</b>
 *         <slicc-memtag kind="user">user</slicc-memtag>
 *       </div>
 *       <div class="ms">…summary…<!-- relocated slotted children --></div>
 *     </slicc-memrow>
 *
 * @attr title - the bold memory title (escaped)
 * @attr summary - the muted summary line (escaped)
 * @attr tag - `user` | `feedback` | `project`; selects the right-pinned memtag
 * @attr fresh - boolean; rose-tints the card as the newest memory (mirrored to
 *   the `fresh` host class so the scoped stylesheet can target it)
 * @slot - extra summary content relocated into the `.ms` line (light DOM has no
 *   native slot)
 * @fires select - the row was activated (click / Enter / Space); `detail` carries
 *   `{ title, summary, tag }`
 */
export class SliccMemrow extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['title', 'summary', 'tag', 'fresh'];
  }

  #initialized = false;
  #mt: HTMLDivElement | null = null;
  #titleEl: HTMLElement | null = null;
  #tagEl: HTMLElement | null = null;
  #ms: HTMLDivElement | null = null;
  #onActivate: ((e: Event) => void) | null = null;
  #onKey: ((e: KeyboardEvent) => void) | null = null;

  connectedCallback(): void {
    ensureMemrowStyle(this.ownerDocument);
    if (!this.#initialized) this.#initialize();
    this.#sync();
    this.#bind();
  }

  disconnectedCallback(): void {
    this.#unbind();
  }

  attributeChangedCallback(): void {
    if (!this.#initialized) return;
    this.#sync();
  }

  /** The bold memory title. */
  get title(): string {
    return this.getAttribute('title') ?? '';
  }

  set title(value: string | null) {
    if (value == null) this.removeAttribute('title');
    else this.setAttribute('title', value);
  }

  /** The muted summary line. */
  get summary(): string {
    return this.getAttribute('summary') ?? '';
  }

  set summary(value: string | null) {
    if (value == null) this.removeAttribute('summary');
    else this.setAttribute('summary', value);
  }

  /** The tag kind — `user` | `feedback` | `project` (defaults to `user`). */
  get tag(): MemTag {
    return normalizeTag(this.getAttribute('tag'));
  }

  set tag(value: MemTag) {
    this.setAttribute('tag', value);
  }

  /** Whether this is the newest (rose-tinted) memory. */
  get fresh(): boolean {
    return this.hasAttribute('fresh');
  }

  set fresh(value: boolean) {
    this.toggleAttribute('fresh', value);
  }

  #initialize(): void {
    this.#initialized = true;

    const mt = this.ownerDocument.createElement('div');
    mt.className = 'mt';
    const titleEl = this.ownerDocument.createElement('b');
    const tagEl = this.ownerDocument.createElement('slicc-memtag');
    mt.append(titleEl, tagEl);

    const ms = this.ownerDocument.createElement('div');
    ms.className = 'ms';

    // Relocate any pre-existing host children (extra summary content) into the
    // `.ms` line so the caller can slot content; light DOM has no native slot.
    while (this.firstChild) ms.appendChild(this.firstChild);

    this.append(mt, ms);
    this.#mt = mt;
    this.#titleEl = titleEl;
    this.#tagEl = tagEl;
    this.#ms = ms;
  }

  /** Push current attribute state into the rendered chrome. */
  #sync(): void {
    const titleEl = this.#titleEl;
    const tagEl = this.#tagEl;
    const ms = this.#ms;
    if (!titleEl || !tagEl || !ms) return;

    titleEl.textContent = this.title;

    const tag = this.tag;
    // Drive the composed <slicc-memtag> through its real API (`type` picks the
    // hue + default label). It renders its own pill in shadow DOM — painting
    // the prototype `.mtag.*` fallback classes on the HOST as well used to
    // draw a second pill around it (doubled borders). The `.mtag` rules in
    // the scoped stylesheet remain for raw prototype spans only.
    tagEl.className = '';
    tagEl.setAttribute('type', tag);
    tagEl.textContent = '';

    // Replace only the leading summary text node, preserving any relocated
    // slotted children that follow it.
    const first = ms.firstChild;
    const summary = this.summary;
    if (first && first.nodeType === Node.TEXT_NODE) {
      first.textContent = summary;
    } else if (summary) {
      ms.insertBefore(this.ownerDocument.createTextNode(summary), first);
    }

    // Mirror the boolean attribute to the host class the stylesheet targets.
    this.classList.toggle('fresh', this.fresh);
  }

  #bind(): void {
    if (!this.#onActivate) {
      this.#onActivate = (e: Event) => this.#emitSelect(e);
      this.addEventListener('click', this.#onActivate);
    }
    if (!this.#onKey) {
      this.#onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.#emitSelect(e);
        }
      };
      this.addEventListener('keydown', this.#onKey);
    }
  }

  #unbind(): void {
    if (this.#onActivate) {
      this.removeEventListener('click', this.#onActivate);
      this.#onActivate = null;
    }
    if (this.#onKey) {
      this.removeEventListener('keydown', this.#onKey);
      this.#onKey = null;
    }
  }

  #emitSelect(sourceEvent: Event): void {
    this.dispatchEvent(
      new CustomEvent('select', {
        bubbles: true,
        composed: true,
        detail: { title: this.title, summary: this.summary, tag: this.tag, sourceEvent },
      })
    );
  }
}

define('slicc-memrow', SliccMemrow);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-memrow': SliccMemrow;
  }
}
