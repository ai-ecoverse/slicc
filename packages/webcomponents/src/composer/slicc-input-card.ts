import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-input-card>`. A light-DOM
 * component can't carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the host
 * class below.
 *
 * Lifted verbatim from the prototype `.inputcard` / `.ta` / `.toolbar`
 * (proto/StellarRubySwift.html): the lifted white card inside the composer — a
 * `var(--canvas)` surface with a 1px `var(--line)` border, 16px radius, soft
 * shadow, and 14/12/10/16 padding, laid out as a flex column with a borderless
 * autosizing `<textarea class="ta">` on top and a `<div class="toolbar">` row
 * below. `:focus-within` paints the violet ring. Everything is var-driven
 * (--canvas / --line / --violet / --ink) so dark mode flips automatically via
 * the inherited theme scope.
 */
const STYLE = `
slicc-input-card {
  display: block;
}
slicc-input-card > .slicc-input-card__card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--canvas);
  padding: 14px 12px 10px 16px;
  box-shadow: rgba(10, 10, 10, 0.05) 0 2px 12px -2px;
  transition: 0.14s;
}
slicc-input-card > .slicc-input-card__card:focus-within {
  border-color: var(--violet);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--violet) 15%, transparent),
    rgba(10, 10, 10, 0.05) 0 2px 12px -2px;
}
slicc-input-card .ta {
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font: inherit;
  font-family: var(--ui);
  font-size: 16px;
  line-height: 1.5;
  color: var(--ink);
  min-height: 28px;
  max-height: 140px;
  overflow-y: hidden;
}
slicc-input-card .ta::placeholder {
  color: var(--txt-3);
}
slicc-input-card .toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
}
/* The add-menu fills the toolbar so its searchbox can slide in next to the +/×,
   matching the prototype (.toolbar slicc-add-menu{flex:1;min-width:0;}). */
slicc-input-card .toolbar slicc-add-menu {
  flex: 1;
  min-width: 0;
}
`;

const STYLE_ID = 'slicc-input-card-style';

/** Inject the scoped input-card stylesheet into a document once (idempotent). */
function ensureInputCardStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Prototype placeholder copy for the composer textarea. */
const DEFAULT_PLACEHOLDER = 'Ask sliccy, or describe a change…';

/**
 * `<slicc-input-card>` — the lifted white input card from the prototype composer
 * (`.inputcard`): a rounded `var(--canvas)` surface with a 1px `var(--line)`
 * border, 16px radius, soft shadow and 14/12/10/16 padding, laid out as a flex
 * column with a borderless autosizing `<textarea class="ta">` on top and a
 * `<div class="toolbar">` control row below. Focusing the textarea lights the
 * card's violet `:focus-within` ring.
 *
 * Light DOM (no shadow root): the host renders its own card scaffold (textarea +
 * toolbar) and relocates caller-supplied toolbar children (`slot="toolbar"`)
 * into the toolbar row so the host app can style it and compose controls inside
 * it. When no toolbar children are supplied it composes the default prototype
 * controls — `<slicc-add-menu>` + `<slicc-send-button>` — by tag. The scoped
 * stylesheet (above) is injected once into the host document.
 *
 * Internal DOM (light DOM):
 *
 *     <slicc-input-card>
 *       <div class="slicc-input-card__card">
 *         <textarea class="ta" rows="1" placeholder="Ask sliccy, …"></textarea>
 *         <div class="toolbar">
 *           <!-- slot="toolbar" children, or the default add-menu + send-button -->
 *         </div>
 *       </div>
 *     </slicc-input-card>
 *
 * Behavior: the textarea autosizes from a 28px min-height up to a 140px max
 * (then scrolls). Enter sends (emits `submit`); Shift+Enter inserts a newline.
 * Every keystroke emits `input`.
 *
 * @attr value - the textarea contents (reflected to/from the property)
 * @attr placeholder - textarea placeholder (defaults to the prototype copy)
 * @attr disabled - boolean; disables the textarea
 * @csspart card - the rounded white card surface (carries the focus ring)
 * @csspart textarea - the borderless autosizing `<textarea>`
 * @csspart toolbar - the control row below the textarea
 * @slot toolbar - controls relocated into the toolbar row (light DOM has no
 *   native slot); when empty, a default add-menu + send-button are composed
 * @fires input - composed + bubbling; `detail.value` carries the current text
 * @fires submit - composed + bubbling; on Enter without Shift; `detail.value`
 *   carries the submitted text (suppressed when the textarea is empty/disabled)
 */
export class SliccInputCard extends HTMLElement {
  static readonly observedAttributes = ['value', 'placeholder', 'disabled'];

  #card!: HTMLDivElement;
  #textarea!: HTMLTextAreaElement;
  #toolbar!: HTMLDivElement;
  #built = false;

  connectedCallback(): void {
    ensureInputCardStyle(this.ownerDocument);
    this.#build();
    this.#syncAttributes();
    this.#autosize();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.#built || oldValue === newValue) return;
    this.#syncAttributes();
    if (name === 'value') this.#autosize();
  }

  /** The textarea contents. */
  get value(): string {
    return this.#built ? this.#textarea.value : (this.getAttribute('value') ?? '');
  }

  set value(value: string) {
    const next = value ?? '';
    if (this.#built) {
      this.#textarea.value = next;
      this.#autosize();
    }
    // Keep the attribute as the serialized seed (so SSR / re-connect restores).
    if (next === '') this.removeAttribute('value');
    else this.setAttribute('value', next);
  }

  /** Textarea placeholder copy. */
  get placeholder(): string {
    return this.getAttribute('placeholder') ?? DEFAULT_PLACEHOLDER;
  }

  set placeholder(value: string | null) {
    if (value == null) this.removeAttribute('placeholder');
    else this.setAttribute('placeholder', value);
  }

  /** Whether the textarea is disabled. */
  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value));
  }

  /** Focus the inner textarea (so callers don't need to dig in). */
  override focus(options?: FocusOptions): void {
    this.#build();
    this.#textarea.focus(options);
  }

  /** Clear the textarea and collapse it back to its min-height. */
  clear(): void {
    this.value = '';
  }

  /**
   * Build the card scaffold once and relocate any pre-existing toolbar children
   * into the toolbar row. Idempotent — safe across re-connects (light DOM
   * survives the move).
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;
    const doc = this.ownerDocument;

    // Collect children that existed before we owned the subtree: nodes marked
    // for the toolbar slot are relocated into the toolbar; everything else is
    // discarded so it can't break the fixed textarea-then-toolbar layout.
    const toolbarChildren = Array.from(this.children).filter(
      (n) => n.getAttribute('slot') === 'toolbar'
    );
    this.replaceChildren();

    this.#card = doc.createElement('div');
    this.#card.className = 'slicc-input-card__card';
    this.#card.setAttribute('part', 'card');

    this.#textarea = doc.createElement('textarea');
    this.#textarea.className = 'ta';
    this.#textarea.setAttribute('part', 'textarea');
    this.#textarea.rows = 1;

    this.#toolbar = doc.createElement('div');
    this.#toolbar.className = 'toolbar';
    this.#toolbar.setAttribute('part', 'toolbar');

    if (toolbarChildren.length > 0) {
      for (const node of toolbarChildren) this.#toolbar.appendChild(node);
    } else {
      // No caller toolbar — compose the prototype default controls by tag.
      this.#toolbar.innerHTML =
        '<slicc-add-menu></slicc-add-menu><slicc-send-button></slicc-send-button>';
    }

    this.#card.append(this.#textarea, this.#toolbar);
    this.appendChild(this.#card);

    this.#textarea.addEventListener('input', this.#onInput);
    this.#textarea.addEventListener('keydown', this.#onKeydown);
  }

  /** Push host attributes onto the inner textarea. */
  #syncAttributes(): void {
    if (!this.#built) return;
    const ta = this.#textarea;
    ta.placeholder = this.placeholder;
    ta.disabled = this.disabled;
    const value = this.getAttribute('value') ?? '';
    if (ta.value !== value) ta.value = value;
  }

  #onInput = (e: Event): void => {
    // The textarea is a light-DOM child, so its native `input` bubbles through
    // the host. Stop it here so external listeners receive only our re-emitted
    // CustomEvent('input') (which carries detail.value) — not the bare native
    // event with no detail.
    e.stopPropagation();
    // Keep the reflected attribute in step without clobbering the caret: only
    // touch the attribute, never re-assign `.value` mid-edit.
    const v = this.#textarea.value;
    if (v === '') this.removeAttribute('value');
    else this.setAttribute('value', v);
    this.#autosize();
    this.dispatchEvent(
      new CustomEvent('input', { bubbles: true, composed: true, detail: { value: v } })
    );
  };

  #onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (this.disabled) return;
    const value = this.#textarea.value;
    if (value.trim() === '') return;
    this.dispatchEvent(
      new CustomEvent('submit', { bubbles: true, composed: true, detail: { value } })
    );
  };

  /**
   * Autosize the textarea: collapse to scrollHeight (bounded by the CSS 28px
   * min / 140px max) and switch to scrolling once it would exceed the max.
   */
  #autosize(): void {
    if (!this.#built) return;
    const ta = this.#textarea;
    ta.style.height = 'auto';
    const next = ta.scrollHeight;
    // 140px is the prototype max-height; beyond it the textarea scrolls.
    ta.style.height = `${Math.min(next, 140)}px`;
    ta.style.overflowY = next > 140 ? 'auto' : 'hidden';
  }
}

define('slicc-input-card', SliccInputCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-input-card': SliccInputCard;
  }
}
