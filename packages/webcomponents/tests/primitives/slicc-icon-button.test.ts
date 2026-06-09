import { beforeEach, describe, expect, it } from 'vitest';
import { SliccIconButton } from '../../src/primitives/slicc-icon-button.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(glyph = '+'): SliccIconButton {
  const el = document.createElement('slicc-icon-button');
  el.textContent = glyph;
  document.body.appendChild(el);
  return el;
}

function innerButton(el: SliccIconButton): HTMLButtonElement {
  return el.shadowRoot?.querySelector('.iconbtn') as HTMLButtonElement;
}

describe('slicc-icon-button', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-icon-button')).toBe(SliccIconButton);
  });

  it('renders an inner button with the icon slot in its shadow root', () => {
    const el = mount();
    const btn = innerButton(el);
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect(btn.getAttribute('part')).toBe('button');
    expect(btn.querySelector('slot')).not.toBeNull();
  });

  it('projects the slotted glyph into the button', () => {
    const el = mount('★');
    const slot = innerButton(el).querySelector('slot') as HTMLSlotElement;
    const assigned = slot.assignedNodes();
    expect(assigned.map((n) => n.textContent).join('')).toBe('★');
  });

  it('reflects the disabled property to the attribute and inner button', () => {
    const el = mount();
    expect(el.disabled).toBe(false);
    el.disabled = true;
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(innerButton(el).disabled).toBe(true);
    el.disabled = false;
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(innerButton(el).disabled).toBe(false);
  });

  it('reflects the disabled attribute to the property', () => {
    const el = mount();
    el.setAttribute('disabled', '');
    expect(el.disabled).toBe(true);
    expect(innerButton(el).disabled).toBe(true);
  });

  it('reflects the label property to aria-label and title on the inner button', () => {
    const el = mount();
    el.label = 'Add scoop';
    expect(el.getAttribute('label')).toBe('Add scoop');
    const btn = innerButton(el);
    expect(btn.getAttribute('aria-label')).toBe('Add scoop');
    expect(btn.getAttribute('title')).toBe('Add scoop');
  });

  it('omits the accessible name when no label is set', () => {
    const btn = innerButton(mount());
    expect(btn.hasAttribute('aria-label')).toBe(false);
    expect(btn.hasAttribute('title')).toBe(false);
  });

  it('escapes label text', () => {
    const el = mount();
    el.label = '"><img src=x>';
    const btn = innerButton(el);
    expect(btn.getAttribute('aria-label')).toBe('"><img src=x>');
    expect(btn.querySelector('img')).toBeNull();
  });

  it('emits a composed, bubbling click that escapes the host', () => {
    const el = mount();
    let count = 0;
    el.addEventListener('click', () => {
      count += 1;
    });
    innerButton(el).click();
    expect(count).toBe(1);
  });

  it('does not fire click when disabled', () => {
    const el = mount();
    el.disabled = true;
    let count = 0;
    el.addEventListener('click', () => {
      count += 1;
    });
    innerButton(el).click();
    expect(count).toBe(0);
  });

  // --- Real-Chromium appearance fidelity -----------------------------------

  it('renders the prototype 30x30 / 8px-radius / 1px-border box (idle)', () => {
    const btn = innerButton(mount());
    const cs = getComputedStyle(btn);
    expect(cs.width).toBe('30px');
    expect(cs.height).toBe('30px');
    expect(cs.borderTopLeftRadius).toBe('8px');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.display).toBe('grid');
    expect(cs.placeItems).toContain('center');
  });

  it('uses --canvas surface and --txt-2 glyph in the idle state (light)', () => {
    const btn = innerButton(mount());
    const cs = getComputedStyle(btn);
    // --canvas: #fff, --txt-2: #737373, --line: #e5e5e5
    expect(cs.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(cs.color).toBe('rgb(115, 115, 115)');
    expect(cs.borderTopColor).toBe('rgb(229, 229, 229)');
  });

  it('flips the idle palette in dark mode via inherited tokens', () => {
    document.body.classList.add('dark');
    try {
      const btn = innerButton(mount());
      const cs = getComputedStyle(btn);
      // dark --canvas: #161618, --txt-2: #9b9ba1
      expect(cs.backgroundColor).toBe('rgb(22, 22, 24)');
      expect(cs.color).toBe('rgb(155, 155, 161)');
    } finally {
      document.body.classList.remove('dark');
    }
  });

  it('lights up to --ghost surface and --ink glyph on hover', () => {
    // :hover cannot be synthesized via the JS event/focus model, so assert the
    // hover rule is present in the shadow stylesheet with the prototype tokens.
    const el = mount();
    const sheet = el.shadowRoot?.adoptedStyleSheets?.length
      ? [...el.shadowRoot.styleSheets, ...el.shadowRoot.adoptedStyleSheets]
      : [...(el.shadowRoot?.styleSheets ?? [])];
    const hoverRule = sheet
      .flatMap((s) => [...s.cssRules])
      .find((r) => r.cssText.includes('.iconbtn:hover') && !r.cssText.includes(':disabled'));
    expect(hoverRule).toBeDefined();
    // --ghost: #ececef, --ink: #0a0a0a
    expect(hoverRule?.cssText).toContain('var(--ghost)');
    expect(hoverRule?.cssText).toContain('var(--ink)');
  });

  it('dims and removes the pointer cursor when disabled', () => {
    const el = mount();
    el.disabled = true;
    const cs = getComputedStyle(innerButton(el));
    expect(cs.cursor).toBe('default');
    expect(Number.parseFloat(cs.opacity)).toBeLessThan(1);
  });

  it('uses a pointer cursor when idle', () => {
    expect(getComputedStyle(innerButton(mount())).cursor).toBe('pointer');
  });
});
