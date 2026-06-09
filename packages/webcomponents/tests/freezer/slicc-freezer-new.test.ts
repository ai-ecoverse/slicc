import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccFreezerNew } from '../../src/freezer/slicc-freezer-new.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccFreezerNew) => void): SliccFreezerNew {
  const el = document.createElement('slicc-freezer-new');
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

const buttonOf = (el: SliccFreezerNew) =>
  el.shadowRoot?.querySelector('button.fznew') as HTMLButtonElement;
const badgeOf = (el: SliccFreezerNew) => el.shadowRoot?.querySelector('.nico') as HTMLElement;
const labelOf = (el: SliccFreezerNew) => el.shadowRoot?.querySelector('.nlbl') as HTMLElement;

/** Resolve a token expression (e.g. `var(--ghost)`) to its computed rgb(). */
function rgb(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

describe('slicc-freezer-new', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  // --- registration --------------------------------------------------------

  it('registers the custom element', () => {
    expect(customElements.get('slicc-freezer-new')).toBe(SliccFreezerNew);
  });

  // --- structure -----------------------------------------------------------

  it('renders the .fznew button with the .nico badge and .nlbl label in shadow', () => {
    const el = mount();
    const btn = buttonOf(el);
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('part')).toBe('button');
    expect(btn.getAttribute('type')).toBe('button');

    const badge = badgeOf(el);
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('part')).toBe('badge');

    const label = labelOf(el);
    expect(label).toBeTruthy();
    expect(label.getAttribute('part')).toBe('label');
  });

  it('renders the inline pencil SVG inside the badge by default', () => {
    const el = mount();
    const svg = badgeOf(el).querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.querySelector('path')).toBeTruthy();
    expect(svg?.querySelector('line')).toBeTruthy();
  });

  it('exposes named "icon" and default slots for overriding glyph + label', () => {
    const el = mount();
    const iconSlot = el.shadowRoot?.querySelector('slot[name="icon"]');
    const defaultSlot = el.shadowRoot?.querySelector('.nlbl slot:not([name])');
    expect(iconSlot).toBeTruthy();
    expect(defaultSlot).toBeTruthy();
  });

  it('uses the label for the default text, aria-label, and title', () => {
    const el = mount();
    const btn = buttonOf(el);
    expect(btn.getAttribute('aria-label')).toBe('New chat');
    expect(btn.getAttribute('title')).toBe('New chat');
    expect(labelOf(el).textContent).toContain('New chat');
    expect(el.label).toBe('New chat');
  });

  // --- attribute ↔ property reflection -------------------------------------

  it('reflects the expanded property to the attribute and back', () => {
    const el = mount();
    expect(el.expanded).toBe(false);
    el.expanded = true;
    expect(el.hasAttribute('expanded')).toBe(true);
    el.expanded = false;
    expect(el.hasAttribute('expanded')).toBe(false);

    el.setAttribute('expanded', '');
    expect(el.expanded).toBe(true);
  });

  it('reflects the label property to the attribute and the accessible name', () => {
    const el = mount();
    el.label = 'Start fresh';
    expect(el.getAttribute('label')).toBe('Start fresh');
    const btn = buttonOf(el);
    expect(btn.getAttribute('aria-label')).toBe('Start fresh');
    expect(btn.getAttribute('title')).toBe('Start fresh');
    expect(labelOf(el).textContent).toContain('Start fresh');

    el.label = null;
    expect(el.hasAttribute('label')).toBe(false);
    expect(el.label).toBe('New chat');
  });

  it('escapes interpolated label text', () => {
    const el = mount((node) => {
      node.label = '<img src=x onerror=alert(1)>';
    });
    const btn = buttonOf(el);
    expect(btn.getAttribute('aria-label')).toBe('<img src=x onerror=alert(1)>');
    // No injected element — text is escaped.
    expect(labelOf(el).querySelector('img')).toBeNull();
    expect(labelOf(el).textContent).toContain('<img src=x onerror=alert(1)>');
  });

  // --- behavior / events ---------------------------------------------------

  it('emits a composed, bubbling new-session event on click', () => {
    const el = mount();
    const handler = vi.fn();
    document.body.addEventListener('new-session', handler);
    const evts: CustomEvent[] = [];
    el.addEventListener('new-session', (e) => evts.push(e as CustomEvent));

    buttonOf(el).click();

    expect(evts).toHaveLength(1);
    expect(evts[0].bubbles).toBe(true);
    expect(evts[0].composed).toBe(true);
    // bubbles across the shadow boundary up to the document body
    expect(handler).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('new-session', handler);
  });

  // --- base appearance / metrics (real Chromium) ---------------------------

  it('is a full-width 36px-row button with an 8px radius and pointer cursor', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    const btn = buttonOf(el);
    const cs = getComputedStyle(btn);
    expect(cs.minHeight).toBe('36px');
    expect(cs.borderTopLeftRadius).toBe('8px');
    expect(cs.cursor).toBe('pointer');
    expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)'); // transparent at rest
    // full-width row: CSS width:100% resolves to the parent's content width in px.
    expect(cs.width).toMatch(/px$/);
    expect(Number.parseFloat(cs.width)).toBeGreaterThan(100);
  });

  it('context-tints the .nico badge from --ctx (28px circle, ctx glyph color)', () => {
    const el = mount();
    const badge = getComputedStyle(badgeOf(el));
    expect(badge.width).toBe('28px');
    expect(badge.height).toBe('28px');
    expect(badge.borderRadius).toBe('50%');
    // glyph color is the raw --ctx token (#f59e0b → rgb(245, 158, 11))
    expect(badge.color).toBe(rgb('var(--ctx)'));
    // tinted fill differs from a plain canvas fill (it is color-mix(--ctx 14%, --canvas))
    expect(badge.backgroundColor).not.toBe(rgb('var(--canvas)'));
    expect(badge.borderTopWidth).toBe('1px');
  });

  // --- collapsed vs expanded variants (real Chromium) ----------------------

  it('collapsed: label is zero-width / hidden and the row centers icon-only', () => {
    const el = mount(); // collapsed by default
    const label = getComputedStyle(labelOf(el));
    expect(label.opacity).toBe('0');
    // flex: 0 0 0 collapses the label box to zero width
    expect(labelOf(el).getBoundingClientRect().width).toBeCloseTo(0, 0);

    const btn = getComputedStyle(buttonOf(el));
    expect(btn.justifyContent).toBe('center');
    expect(btn.columnGap).toBe('0px');
  });

  it('expanded: label fades in to full opacity beside the badge', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    const label = getComputedStyle(labelOf(el));
    expect(label.opacity).toBe('1');
    expect(labelOf(el).getBoundingClientRect().width).toBeGreaterThan(0);

    const btn = getComputedStyle(buttonOf(el));
    // gap restored when expanded (prototype gap:10px)
    expect(btn.columnGap).toBe('10px');
  });

  it('toggling expanded flips the label visibility live', () => {
    const el = mount();
    expect(getComputedStyle(labelOf(el)).opacity).toBe('0');
    el.expanded = true;
    expect(getComputedStyle(labelOf(el)).opacity).toBe('1');
    el.expanded = false;
    expect(getComputedStyle(labelOf(el)).opacity).toBe('0');
  });

  // --- hover (real Chromium :hover rule) -----------------------------------

  it('hover state: ghost background (rule resolves the inherited token)', () => {
    const el = mount();
    const sheet = (el.shadowRoot as ShadowRoot).styleSheets[0];
    const rules = Array.from(sheet.cssRules) as CSSStyleRule[];
    const hoverRule = rules.find((r) => r.selectorText === '.fznew:hover');
    expect(hoverRule).toBeDefined();
    expect(hoverRule?.style.background).toBe('var(--ghost)');
  });

  // --- dark mode adapts via inherited tokens -------------------------------

  it('the context-tinted badge adapts to dark mode (color-mix into --canvas/--line)', () => {
    const el = mount();
    const badge = badgeOf(el);
    const lightBg = getComputedStyle(badge).backgroundColor;
    const lightBorder = getComputedStyle(badge).borderTopColor;
    document.body.classList.add('dark');
    const darkBg = getComputedStyle(badge).backgroundColor;
    const darkBorder = getComputedStyle(badge).borderTopColor;
    document.body.classList.remove('dark');
    // --canvas and --line both flip in dark mode, so the mixed surfaces change
    expect(darkBg).not.toBe(lightBg);
    expect(darkBorder).not.toBe(lightBorder);
  });
});
