import { beforeEach, describe, expect, it } from 'vitest';
import { iconSvg } from '../../src/internal/icons.js';
import { SliccIconButton } from '../../src/primitives/slicc-icon-button.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(icon?: string): SliccIconButton {
  const el = document.createElement('slicc-icon-button');
  if (icon) el.setAttribute('icon', icon);
  document.body.appendChild(el);
  return el;
}

function innerButton(el: SliccIconButton): HTMLButtonElement {
  return el.shadowRoot?.querySelector('.iconbtn') as HTMLButtonElement;
}

/** The lucide `<svg>` rendered inside the default slot (null if overridden). */
function renderedSvg(el: SliccIconButton): SVGSVGElement | null {
  return el.shadowRoot?.querySelector('.icon svg') as SVGSVGElement | null;
}

/** lucide registry path/shape children for `name`, serialized for comparison. */
function lucideShapeKey(name: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = iconSvg(name, { size: 16 });
  const svg = tmp.querySelector('svg') as SVGSVGElement;
  return [...svg.children].map((c) => c.outerHTML).join('');
}

/**
 * Matches emoji / pictographic / arrow / dingbat / unicode-symbol glyphs
 * (e.g. 📎 ✦ ❄ 🔔 🌙 ☀ ↑ ⤡ ＋) — none of which may appear in the rendered
 * button: it must use lucide `<svg>` glyphs only.
 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{21FF}]|[\u{2900}-\u{297F}]|[\u{2B00}-\u{2BFF}]|[\u{FF00}-\u{FFEF}]/u;

describe('slicc-icon-button', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-icon-button')).toBe(SliccIconButton);
  });

  it('renders an inner button with the default slot in its shadow root', () => {
    const el = mount();
    const btn = innerButton(el);
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect(btn.getAttribute('part')).toBe('button');
    expect(btn.querySelector('slot')).not.toBeNull();
  });

  // --- Lucide icon rendering ------------------------------------------------

  it('renders a lucide <svg> (default `plus`) — no emoji/text glyph', () => {
    const el = mount();
    const svg = renderedSvg(el);
    expect(svg).toBeInstanceOf(SVGSVGElement);
    // default icon is `plus`
    expect(el.icon).toBe('plus');
    expect(svg?.innerHTML).toBe(lucideShapeKey('plus'));
    // the button carries no emoji / unicode-symbol text content
    expect(EMOJI_RE.test(innerButton(el).textContent ?? '')).toBe(false);
    expect((innerButton(el).textContent ?? '').trim()).toBe('');
  });

  it('setting `icon` renders the matching lucide <svg> and swaps shapes', () => {
    const el = mount();
    const plusKey = lucideShapeKey('plus');
    for (const name of ['paperclip', 'settings', 'search', 'mic']) {
      el.icon = name;
      const svg = renderedSvg(el);
      expect(svg, name).toBeInstanceOf(SVGSVGElement);
      expect(svg?.innerHTML, name).toBe(lucideShapeKey(name));
      // a real swap: the new shape differs from the default `plus` glyph
      expect(svg?.innerHTML, name).not.toBe(plusKey);
      // never an emoji glyph
      expect(EMOJI_RE.test(svg?.outerHTML ?? ''), name).toBe(false);
    }
  });

  it('reflects the icon attribute to the property and re-renders', () => {
    const el = mount();
    el.setAttribute('icon', 'search');
    expect(el.icon).toBe('search');
    expect(renderedSvg(el)?.innerHTML).toBe(lucideShapeKey('search'));
    el.icon = null;
    expect(el.hasAttribute('icon')).toBe(false);
    expect(el.icon).toBe('plus');
    expect(renderedSvg(el)?.innerHTML).toBe(lucideShapeKey('plus'));
  });

  it('exposes the lucide svg via the `icon` ::part', () => {
    expect(renderedSvg(mount('settings'))?.getAttribute('part')).toBe('icon');
  });

  it('a slotted custom <svg> overrides the lucide icon', () => {
    const el = document.createElement('slicc-icon-button');
    el.setAttribute('icon', 'plus');
    el.innerHTML =
      '<svg class="custom" width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';
    document.body.appendChild(el);
    const slot = innerButton(el).querySelector('slot') as HTMLSlotElement;
    const assigned = slot.assignedElements();
    expect(assigned).toHaveLength(1);
    expect((assigned[0] as Element).classList.contains('custom')).toBe(true);
  });

  // --- disabled / label / click ---------------------------------------------

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

  it('tints the lucide glyph with the button currentColor (idle)', () => {
    // lucide strokes use `currentColor`, so the rendered svg picks up --txt-2.
    const svg = renderedSvg(mount());
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(getComputedStyle(svg as Element).color).toBe('rgb(115, 115, 115)');
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
