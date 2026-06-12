import { beforeEach, describe, expect, it, vi } from 'vitest';
// Siblings composed by tag in the default toolbar — importing here registers
// them so the composed elements upgrade during the test run.
import '../../src/add-menu/slicc-add-menu.js';
import { SliccInputCard } from '../../src/composer/slicc-input-card.js';
import '../../src/primitives/slicc-send-button.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccInputCard) => void): SliccInputCard {
  const el = document.createElement('slicc-input-card') as SliccInputCard;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The inner card surface (carries the focus-within ring). */
function card(el: SliccInputCard): HTMLElement {
  return el.querySelector('.slicc-input-card__card') as HTMLElement;
}

/** The inner autosizing textarea. */
function textarea(el: SliccInputCard): HTMLTextAreaElement {
  return el.querySelector('textarea.ta') as HTMLTextAreaElement;
}

/** The toolbar row. */
function toolbar(el: SliccInputCard): HTMLElement {
  return el.querySelector('.toolbar') as HTMLElement;
}

function enter(el: SliccInputCard, shift = false): void {
  textarea(el).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true })
  );
}

describe('slicc-input-card', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-input-card')).toBe(SliccInputCard);
  });

  describe('structure', () => {
    it('renders a light-DOM card with textarea + toolbar (no shadow root)', () => {
      const el = mount();
      expect(el.shadowRoot).toBeNull();
      expect(card(el)).toBeTruthy();
      expect(textarea(el)).toBeTruthy();
      expect(toolbar(el)).toBeTruthy();
      // Textarea precedes the toolbar in the column.
      const kids = Array.from(card(el).children);
      expect(kids.indexOf(textarea(el))).toBeLessThan(kids.indexOf(toolbar(el)));
    });

    it('exposes part hooks on card / textarea / toolbar', () => {
      const el = mount();
      expect(el.querySelector('[part="card"]')).toBe(card(el));
      expect(el.querySelector('[part="textarea"]')).toBe(textarea(el));
      expect(el.querySelector('[part="toolbar"]')).toBe(toolbar(el));
    });

    it('seeds the prototype placeholder by default', () => {
      const el = mount();
      expect(textarea(el).placeholder).toBe('Ask sliccy, or describe a change…');
    });

    it('composes slicc-add-menu + slicc-send-button by tag when no toolbar is supplied', () => {
      const el = mount();
      expect(toolbar(el).querySelector('slicc-add-menu')).toBeTruthy();
      expect(toolbar(el).querySelector('slicc-send-button')).toBeTruthy();
    });

    it('relocates slot="toolbar" children into the toolbar instead of the default controls', () => {
      const el = mount((e) => {
        const send = document.createElement('slicc-send-button');
        send.setAttribute('slot', 'toolbar');
        send.id = 'host-send';
        e.appendChild(send);
      });
      expect(toolbar(el).querySelector('#host-send')).toBeTruthy();
      // The default add-menu is NOT injected when the host supplied a toolbar.
      expect(toolbar(el).querySelector('slicc-add-menu')).toBeNull();
    });
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects value both ways', () => {
      const el = mount();
      el.value = 'hello';
      expect(el.getAttribute('value')).toBe('hello');
      expect(textarea(el).value).toBe('hello');
      el.value = '';
      expect(el.hasAttribute('value')).toBe(false);
      expect(textarea(el).value).toBe('');
    });

    it('seeds the textarea from a pre-set value attribute', () => {
      const el = mount((e) => e.setAttribute('value', 'seeded'));
      expect(el.value).toBe('seeded');
      expect(textarea(el).value).toBe('seeded');
    });

    it('reflects placeholder', () => {
      const el = mount((e) => {
        e.placeholder = 'Type here';
      });
      expect(el.getAttribute('placeholder')).toBe('Type here');
      expect(textarea(el).placeholder).toBe('Type here');
      el.placeholder = null;
      expect(el.hasAttribute('placeholder')).toBe(false);
      expect(textarea(el).placeholder).toBe('Ask sliccy, or describe a change…');
    });

    it('reflects disabled onto the textarea', () => {
      const el = mount();
      expect(el.disabled).toBe(false);
      expect(textarea(el).disabled).toBe(false);
      el.disabled = true;
      expect(el.hasAttribute('disabled')).toBe(true);
      expect(textarea(el).disabled).toBe(true);
    });
  });

  describe('idle vs focus-within state', () => {
    it('paints a transparent (token) border when idle', () => {
      const el = mount();
      const cs = getComputedStyle(card(el));
      // Light --line is #e5e5e5 → rgb(229, 229, 229); definitely not the violet ring.
      expect(cs.borderTopColor).toBe('rgb(229, 229, 229)');
      expect(cs.borderTopWidth).toBe('1px');
    });

    it('switches the border to the violet token on focus-within', async () => {
      const el = mount();
      textarea(el).focus();
      expect(el.querySelector('.slicc-input-card__card:focus-within')).toBe(card(el));
      // The card has `transition: .14s`, so border-color animates from --line to
      // --violet — wait past the transition before reading the resolved value.
      await new Promise((r) => setTimeout(r, 220));
      const cs = getComputedStyle(card(el));
      // --violet #8b5cf6 → rgb(139, 92, 246).
      expect(cs.borderTopColor).toBe('rgb(139, 92, 246)');
    });

    it('renders the 16px radius and column padding from the prototype', () => {
      const el = mount();
      const cs = getComputedStyle(card(el));
      expect(cs.borderTopLeftRadius).toBe('16px');
      expect(cs.flexDirection).toBe('column');
      // padding: 14px 12px 10px 16px
      expect(cs.paddingTop).toBe('14px');
      expect(cs.paddingRight).toBe('12px');
      expect(cs.paddingBottom).toBe('10px');
      expect(cs.paddingLeft).toBe('16px');
    });

    it('flips the card surface to the dark canvas token under .dark', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      document.body.appendChild(wrap);
      const el = document.createElement('slicc-input-card') as SliccInputCard;
      wrap.appendChild(el);
      const cs = getComputedStyle(card(el));
      // dark --canvas #161618 → rgb(22, 22, 24).
      expect(cs.backgroundColor).toBe('rgb(22, 22, 24)');
    });
  });

  describe('autosize', () => {
    it('lays out the textarea between the 28px min and 140px max bounds', () => {
      const el = mount();
      const cs = getComputedStyle(textarea(el));
      expect(cs.minHeight).toBe('28px');
      expect(cs.maxHeight).toBe('140px');
      expect(cs.resize).toBe('none');
    });

    it('caps the explicit height at 140px and scrolls for tall content', () => {
      const el = mount();
      const ta = textarea(el);
      // Force a tall scrollHeight, then drive the autosize path via input.
      vi.spyOn(ta, 'scrollHeight', 'get').mockReturnValue(400);
      ta.value = 'x'.repeat(2000);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      expect(ta.style.height).toBe('140px');
      expect(ta.style.overflowY).toBe('auto');
    });

    it('keeps overflow hidden for short content', () => {
      const el = mount();
      const ta = textarea(el);
      vi.spyOn(ta, 'scrollHeight', 'get').mockReturnValue(40);
      ta.value = 'one line';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      expect(ta.style.height).toBe('40px');
      expect(ta.style.overflowY).toBe('hidden');
    });
  });

  describe('events', () => {
    it('emits an input event carrying the current value on each keystroke', () => {
      const el = mount();
      const seen: string[] = [];
      el.addEventListener('input', (e) => seen.push((e as Event as CustomEvent).detail.value));
      const ta = textarea(el);
      ta.value = 'ab';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      expect(seen).toEqual(['ab']);
      // The reflected attribute tracks the live value.
      expect(el.getAttribute('value')).toBe('ab');
    });

    it('emits a composed + bubbling submit on Enter (no shift)', () => {
      const el = mount();
      el.value = 'ship it';
      const submit = vi.fn();
      el.addEventListener('submit', (e) => submit((e as Event as CustomEvent).detail.value));
      enter(el);
      expect(submit).toHaveBeenCalledWith('ship it');
    });

    it('does NOT submit on Shift+Enter (newline)', () => {
      const el = mount();
      el.value = 'line one';
      const submit = vi.fn();
      el.addEventListener('submit', submit);
      enter(el, true);
      expect(submit).not.toHaveBeenCalled();
    });

    it('suppresses submit when the textarea is empty / whitespace-only', () => {
      const el = mount();
      const submit = vi.fn();
      el.addEventListener('submit', submit);
      enter(el);
      el.value = '   ';
      enter(el);
      expect(submit).not.toHaveBeenCalled();
    });

    it('suppresses submit when disabled', () => {
      const el = mount((e) => {
        e.value = 'ready';
        e.disabled = true;
      });
      const submit = vi.fn();
      el.addEventListener('submit', submit);
      enter(el);
      expect(submit).not.toHaveBeenCalled();
    });

    it('prevents the Enter default so no newline is inserted on submit', () => {
      const el = mount();
      el.value = 'go';
      const ev = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      textarea(el).dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });
  });

  describe('history walking (ArrowUp / ArrowDown)', () => {
    function arrow(el: SliccInputCard, key: 'ArrowUp' | 'ArrowDown'): KeyboardEvent {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      textarea(el).dispatchEvent(ev);
      return ev;
    }

    it('emits history-up when ArrowUp is pressed with the caret at the start', () => {
      const el = mount((e) => {
        e.value = 'typed text';
      });
      const ta = textarea(el);
      ta.setSelectionRange(0, 0);
      const up = vi.fn();
      el.addEventListener('history-up', up);
      const ev = arrow(el, 'ArrowUp');
      expect(up).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('does NOT emit history-up when the caret is mid-text (default jump-to-start wins)', () => {
      const el = mount((e) => {
        e.value = 'typed text';
      });
      textarea(el).setSelectionRange(5, 5);
      const up = vi.fn();
      el.addEventListener('history-up', up);
      const ev = arrow(el, 'ArrowUp');
      expect(up).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    });

    it('does NOT emit history-up over an active selection', () => {
      const el = mount((e) => {
        e.value = 'typed text';
      });
      textarea(el).setSelectionRange(0, 5);
      const up = vi.fn();
      el.addEventListener('history-up', up);
      arrow(el, 'ArrowUp');
      expect(up).not.toHaveBeenCalled();
    });

    it('emits history-down when ArrowDown is pressed with the caret at the end', () => {
      const el = mount((e) => {
        e.value = 'typed';
      });
      const ta = textarea(el);
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const down = vi.fn();
      el.addEventListener('history-down', down);
      arrow(el, 'ArrowDown');
      expect(down).toHaveBeenCalledTimes(1);
    });

    it('does NOT emit history-down when the caret is mid-text', () => {
      const el = mount((e) => {
        e.value = 'typed';
      });
      textarea(el).setSelectionRange(2, 2);
      const down = vi.fn();
      el.addEventListener('history-down', down);
      arrow(el, 'ArrowDown');
      expect(down).not.toHaveBeenCalled();
    });

    it('emits history-up/down on an empty composer (caret is at both bounds)', () => {
      const el = mount();
      const up = vi.fn();
      const down = vi.fn();
      el.addEventListener('history-up', up);
      el.addEventListener('history-down', down);
      arrow(el, 'ArrowUp');
      arrow(el, 'ArrowDown');
      expect(up).toHaveBeenCalledTimes(1);
      expect(down).toHaveBeenCalledTimes(1);
    });
  });

  it('focusEnd() focuses the textarea with the caret at the end', () => {
    const el = mount((e) => {
      e.value = 'hello world';
    });
    el.focusEnd();
    const ta = textarea(el);
    expect(ta).toBe(document.activeElement);
    expect(ta.selectionStart).toBe('hello world'.length);
    expect(ta.selectionEnd).toBe('hello world'.length);
  });

  it('ellipsizes long placeholders instead of clipping them', () => {
    const el = mount((e) => {
      e.setAttribute('placeholder', 'A very long LLM-suggested follow-up that will not fit');
    });
    const sheetText = (document.getElementById('slicc-input-card-style') as HTMLStyleElement)
      ?.textContent;
    // ::placeholder computed styles are not exposed via getComputedStyle —
    // assert the injected rule carries the ellipsis trio.
    const rule = sheetText?.match(/\.ta::placeholder \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('text-overflow: ellipsis');
    expect(rule).toContain('overflow: hidden');
  });

  it('clear() empties the textarea and drops the value attribute', () => {
    const el = mount((e) => {
      e.value = 'something';
    });
    el.clear();
    expect(el.value).toBe('');
    expect(el.hasAttribute('value')).toBe(false);
    expect(textarea(el).value).toBe('');
  });

  it('focus() focuses the inner textarea', () => {
    const el = mount();
    el.focus();
    expect(el.querySelector('textarea.ta')).toBe(document.activeElement);
  });
});

describe('slicc-input-card / send button', () => {
  it('clicking the default send button emits submit with the current value', () => {
    const el = document.createElement('slicc-input-card');
    document.body.appendChild(el);
    el.value = 'ship it';
    const submits: string[] = [];
    el.addEventListener('submit', (e) => {
      submits.push((e as Event as CustomEvent<{ value: string }>).detail.value);
    });

    const send = el.querySelector('slicc-send-button');
    expect(send).not.toBeNull();
    send!.dispatchEvent(new CustomEvent('send', { bubbles: true, composed: true }));
    expect(submits).toEqual(['ship it']);
    el.remove();
  });

  it('send is suppressed when empty or disabled', () => {
    const el = document.createElement('slicc-input-card');
    document.body.appendChild(el);
    const submits: unknown[] = [];
    el.addEventListener('submit', (e) => submits.push(e));
    const send = el.querySelector('slicc-send-button')!;

    send.dispatchEvent(new CustomEvent('send', { bubbles: true, composed: true }));
    el.value = '   ';
    send.dispatchEvent(new CustomEvent('send', { bubbles: true, composed: true }));
    el.value = 'ready';
    el.disabled = true;
    send.dispatchEvent(new CustomEvent('send', { bubbles: true, composed: true }));
    expect(submits).toEqual([]);
    el.remove();
  });
});
