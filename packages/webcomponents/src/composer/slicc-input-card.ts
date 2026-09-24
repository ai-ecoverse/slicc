import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';

import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';

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
  /* Long (LLM-suggested) placeholders ellipsize instead of clipping when
     the workbench narrows the chat column. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

function ensureInputCardStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const DEFAULT_PLACEHOLDER = 'Ask sliccy, or describe a change…';

function focusIsNowhere(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || active === doc.documentElement;
}

export class SliccInputCard extends HTMLElement {
  static readonly observedAttributes = ['value', 'placeholder', 'suggestion', 'disabled'];

  #card!: HTMLDivElement;
  #textarea!: HTMLTextAreaElement;
  #toolbar!: HTMLDivElement;
  #built = false;

  #lostCaret: { start: number; end: number } | null = null;

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

  get value(): string {
    return this.#built ? this.#textarea.value : (this.getAttribute('value') ?? '');
  }

  set value(value: string) {
    const next = value ?? '';
    if (this.#built) {
      this.#textarea.value = next;
      this.#autosize();
    }

    if (next === '') this.removeAttribute('value');
    else this.setAttribute('value', next);
  }

  get placeholder(): string {
    return this.getAttribute('placeholder') ?? DEFAULT_PLACEHOLDER;
  }

  set placeholder(value: string | null) {
    if (value == null) this.removeAttribute('placeholder');
    else this.setAttribute('placeholder', value);
  }

  get suggestion(): string | null {
    return this.getAttribute('suggestion');
  }

  set suggestion(value: string | null) {
    if (value == null || value === '') this.removeAttribute('suggestion');
    else this.setAttribute('suggestion', value);
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value));
  }

  override focus(options?: FocusOptions): void {
    this.#build();
    this.#textarea.focus(options);
  }

  clear(): void {
    this.value = '';
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;
    const doc = this.ownerDocument;

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
      this.#toolbar.append(h('slicc-add-menu'), h('slicc-send-button'));
    }

    this.#card.append(this.#textarea, this.#toolbar);
    this.appendChild(this.#card);

    this.#textarea.addEventListener('input', this.#onInput);
    this.#textarea.addEventListener('keydown', this.#onKeydown);

    this.#toolbar.addEventListener('send', this.#onSend);
  }

  #syncAttributes(): void {
    if (!this.#built) return;
    const ta = this.#textarea;

    ta.placeholder = this.suggestion ?? this.placeholder;
    this.#syncDisabled(ta);
    const value = this.getAttribute('value') ?? '';
    if (ta.value !== value) ta.value = value;
  }

  #syncDisabled(ta: HTMLTextAreaElement): void {
    const disabled = this.disabled;
    if (disabled === ta.disabled) return;
    if (disabled) {
      const root = ta.getRootNode() as Partial<DocumentOrShadowRoot>;
      this.#lostCaret =
        root.activeElement === ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
      ta.disabled = true;
      return;
    }
    ta.disabled = false;
    const caret = this.#lostCaret;
    this.#lostCaret = null;
    if (!caret || !focusIsNowhere(this.ownerDocument)) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(caret.start, caret.end);
  }

  #onInput = (e: Event): void => {
    e.stopPropagation();

    const v = this.#textarea.value;
    if (v === '') this.removeAttribute('value');
    else this.setAttribute('value', v);
    this.#autosize();
    this.dispatchEvent(
      new CustomEvent('input', { bubbles: true, composed: true, detail: { value: v } })
    );
  };

  #onKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.#emitSubmit(undefined, e.ctrlKey || e.metaKey);
      return;
    }

    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const suggestion = this.suggestion;
      if (suggestion && this.#textarea.value === '') {
        e.preventDefault();

        this.removeAttribute('suggestion');
        const ta = this.#textarea;
        ta.value = suggestion;
        ta.setSelectionRange(suggestion.length, suggestion.length);

        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }

    const ta = this.#textarea;
    const collapsed = ta.selectionStart === ta.selectionEnd;
    if (e.key === 'ArrowUp' && collapsed && ta.selectionStart === 0) {
      e.preventDefault();
      this.dispatchEvent(new CustomEvent('history-up', { bubbles: true, composed: true }));
    } else if (e.key === 'ArrowDown' && collapsed && ta.selectionStart === ta.value.length) {
      this.dispatchEvent(new CustomEvent('history-down', { bubbles: true, composed: true }));
    }
  };

  #onSend = (e: Event): void => {
    e.stopPropagation();
    this.#emitSubmit();
  };

  submit(source?: string): void {
    this.#build();
    this.#emitSubmit(source);
  }

  focusEnd(): void {
    if (!this.#built) return;
    const ta = this.#textarea;
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }

  #emitSubmit(source?: string, steer?: boolean): void {
    if (this.disabled) return;
    const value = this.#textarea.value;
    if (value.trim() === '') return;

    this.removeAttribute('suggestion');
    this.dispatchEvent(
      new CustomEvent('submit', {
        bubbles: true,
        composed: true,
        detail: { value, ...(source ? { source } : {}), ...(steer ? { steer: true } : {}) },
      })
    );
  }

  #autosize(): void {
    if (!this.#built) return;
    const ta = this.#textarea;
    ta.style.height = 'auto';
    const next = ta.scrollHeight;

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
