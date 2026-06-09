import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccCollapseBtn } from '../../src/primitives/slicc-collapse-btn.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function rgb(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

describe('slicc-collapse-btn', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-collapse-btn')).toBe(SliccCollapseBtn);
  });

  it('renders the collapse button in its shadow root', () => {
    const el = document.createElement('slicc-collapse-btn');
    document.body.appendChild(el);
    const btn = el.shadowRoot?.querySelector('button.col');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('part')).toBe('button');
  });

  it('defaults to the ⤡ glyph and "Collapse" label', () => {
    const el = document.createElement('slicc-collapse-btn');
    document.body.appendChild(el);
    const slot = el.shadowRoot?.querySelector('slot');
    expect(slot?.textContent).toBe('⤡');
    const btn = el.shadowRoot?.querySelector('button');
    expect(btn?.getAttribute('aria-label')).toBe('Collapse');
    expect(btn?.getAttribute('title')).toBe('Collapse');
    // property mirrors the default when the attribute is absent
    expect(el.glyph).toBe('⤡');
    expect(el.label).toBe('Collapse');
  });

  it('reflects the label property to the attribute and the accessible name', () => {
    const el = document.createElement('slicc-collapse-btn');
    el.label = 'Hide panel';
    document.body.appendChild(el);
    expect(el.getAttribute('label')).toBe('Hide panel');
    const btn = el.shadowRoot?.querySelector('button');
    expect(btn?.getAttribute('aria-label')).toBe('Hide panel');
    expect(btn?.getAttribute('title')).toBe('Hide panel');
  });

  it('reflects the glyph property to the attribute and rendered text', () => {
    const el = document.createElement('slicc-collapse-btn');
    el.glyph = '⤢';
    document.body.appendChild(el);
    expect(el.getAttribute('glyph')).toBe('⤢');
    expect(el.shadowRoot?.querySelector('slot')?.textContent).toBe('⤢');
  });

  it('escapes label and glyph text', () => {
    const el = document.createElement('slicc-collapse-btn');
    el.label = '<img src=x>';
    el.glyph = '<b>x</b>';
    document.body.appendChild(el);
    const btn = el.shadowRoot?.querySelector('button');
    expect(btn?.getAttribute('aria-label')).toBe('<img src=x>');
    const slot = el.shadowRoot?.querySelector('slot');
    expect(slot?.querySelector('b')).toBeNull();
    expect(slot?.textContent).toBe('<b>x</b>');
  });

  it('emits a composed, bubbling collapse event on click', () => {
    const el = document.createElement('slicc-collapse-btn');
    document.body.appendChild(el);
    const handler = vi.fn();
    document.body.addEventListener('collapse', handler);
    const evts: CustomEvent[] = [];
    el.addEventListener('collapse', (e) => evts.push(e as CustomEvent));

    el.shadowRoot?.querySelector('button')?.click();

    expect(evts).toHaveLength(1);
    expect(evts[0].bubbles).toBe(true);
    expect(evts[0].composed).toBe(true);
    // bubbles across the shadow boundary up to the document body
    expect(handler).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('collapse', handler);
  });

  it('idle state: 28px tall, canvas bg, 1px line border, 8px radius, txt-2 glyph (real Chromium)', () => {
    const el = document.createElement('slicc-collapse-btn');
    document.body.appendChild(el);
    const btn = el.shadowRoot?.querySelector('button.col') as HTMLButtonElement;
    const cs = getComputedStyle(btn);
    expect(btn.getBoundingClientRect().height).toBeCloseTo(28, 0);
    expect(cs.borderTopLeftRadius).toBe('8px');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.cursor).toBe('pointer');
    expect(cs.backgroundColor).toBe(rgb('var(--canvas)'));
    expect(cs.borderTopColor).toBe(rgb('var(--line)'));
    expect(cs.color).toBe(rgb('var(--txt-2)'));
  });

  it('hover state: ghost bg / ink text (real Chromium :hover rule resolves the tokens)', () => {
    const el = document.createElement('slicc-collapse-btn');
    document.body.appendChild(el);
    const sheet = (el.shadowRoot as ShadowRoot).styleSheets[0];
    const rules = Array.from(sheet.cssRules) as CSSStyleRule[];
    const hoverRule = rules.find((r) => r.selectorText === '.col:hover');
    expect(hoverRule).toBeDefined();
    expect(hoverRule?.style.background).toBe('var(--ghost)');
    expect(hoverRule?.style.color).toBe('var(--ink)');
  });

  it('flips with dark mode via inherited tokens', () => {
    const el = document.createElement('slicc-collapse-btn');
    document.body.appendChild(el);
    const btn = el.shadowRoot?.querySelector('button.col') as HTMLButtonElement;
    const light = getComputedStyle(btn).backgroundColor;
    document.body.classList.add('dark');
    const dark = getComputedStyle(btn).backgroundColor;
    document.body.classList.remove('dark');
    expect(dark).not.toBe(light);
  });
});
