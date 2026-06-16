import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccFreezerNew } from '../../src/freezer/slicc-freezer-new.js';
import { LONG_PRESS_MS } from '../../src/internal/long-press.js';
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
const optionsOf = (el: SliccFreezerNew) =>
  el.shadowRoot?.querySelector('.fznew-options') as HTMLElement;
const optionOf = (el: SliccFreezerNew, action: 'save' | 'skip' | 'erase') =>
  el.shadowRoot?.querySelector(`.fznew-opt--${action}`) as HTMLButtonElement;

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

  it('renders a lucide square-pen <svg> inside the badge by default', () => {
    const el = mount();
    const svg = badgeOf(el).querySelector('svg');
    expect(svg).toBeTruthy();
    // lucide glyph: 24×24 viewBox, currentColor stroke, sized to ~16px, path-only.
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
    // square-pen is built from <path> elements (no bespoke <line> like the old glyph).
    expect(svg?.querySelectorAll('path').length).toBeGreaterThan(0);
    // the lucide glyph carries the shared ::part="icon" hook for host styling.
    expect(svg?.getAttribute('part')).toBe('icon');
  });

  it('uses a lucide icon, not an emoji or bespoke unicode glyph', () => {
    const el = mount();
    const badge = badgeOf(el);
    // the glyph is a real <svg>, not a text-symbol node.
    expect(badge.querySelector('svg')).toBeTruthy();
    // no emoji / pictographic / glyph symbol leaked into the badge text.
    const text = badge.textContent ?? '';
    const FORBIDDEN = ['✦', '❄', '🔔', '🌙', '☀', '＋', '✎', '✏', '⤡'];
    expect(FORBIDDEN.some((g) => text.includes(g))).toBe(false);
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

  // --- three-state gesture / events ----------------------------------------

  it('single click commits new-chat-save after the double-click window', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      const evts: string[] = [];
      for (const t of ['new-chat-save', 'new-chat-skip', 'new-chat-erase']) {
        el.addEventListener(t, () => evts.push(t));
      }
      buttonOf(el).click();
      // Deferred — nothing fires until the double-click window elapses.
      expect(evts).toEqual([]);
      vi.advanceTimersByTime(350);
      expect(evts).toEqual(['new-chat-save']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('double click commits new-chat-skip and suppresses new-chat-save', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      const evts: string[] = [];
      for (const t of ['new-chat-save', 'new-chat-skip', 'new-chat-erase']) {
        el.addEventListener(t, () => evts.push(t));
      }
      const btn = buttonOf(el);
      btn.click();
      btn.click();
      vi.advanceTimersByTime(500);
      expect(evts).toEqual(['new-chat-skip']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('long press commits new-chat-erase', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      const evts: string[] = [];
      for (const t of ['new-chat-save', 'new-chat-skip', 'new-chat-erase']) {
        el.addEventListener(t, () => evts.push(t));
      }
      buttonOf(el).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(evts).toEqual(['new-chat-erase']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('modifier-click commits new-chat-erase immediately', () => {
    const el = mount();
    const evts: string[] = [];
    for (const t of ['new-chat-save', 'new-chat-skip', 'new-chat-erase']) {
      el.addEventListener(t, () => evts.push(t));
    }
    buttonOf(el).dispatchEvent(
      new MouseEvent('click', { button: 0, metaKey: true, bubbles: true })
    );
    expect(evts).toEqual(['new-chat-erase']);
  });

  it('the new-chat events bubble across the shadow boundary and are composed', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      const seen: CustomEvent[] = [];
      const handler = (e: Event) => seen.push(e as CustomEvent);
      document.body.addEventListener('new-chat-save', handler);
      buttonOf(el).click();
      vi.advanceTimersByTime(350);
      expect(seen).toHaveLength(1);
      expect(seen[0].bubbles).toBe(true);
      expect(seen[0].composed).toBe(true);
      document.body.removeEventListener('new-chat-save', handler);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the pending single-click timer on disconnect (no late event)', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      const evts: string[] = [];
      el.addEventListener('new-chat-save', () => evts.push('save'));
      buttonOf(el).click();
      el.remove();
      vi.advanceTimersByTime(1000);
      expect(evts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- expanded options legend ---------------------------------------------

  it('renders the three option buttons; collapsed hides the legend', () => {
    const el = mount();
    expect(optionOf(el, 'save')).toBeTruthy();
    expect(optionOf(el, 'skip')).toBeTruthy();
    expect(optionOf(el, 'erase')).toBeTruthy();
    expect(optionsOf(el).getAttribute('part')).toBe('options');
    // collapsed by default → legend not displayed
    expect(getComputedStyle(optionsOf(el)).display).toBe('none');
  });

  it('keeps the options legend hidden at rest even when expanded', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    // No hover / focus → the legend stays hidden (revealed only on hover/focus).
    expect(getComputedStyle(optionsOf(el)).display).toBe('none');
  });

  it('reveals the options legend on keyboard focus (focus-within) when expanded', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    buttonOf(el).focus();
    expect(getComputedStyle(optionsOf(el)).display).toBe('flex');
    buttonOf(el).blur();
    expect(getComputedStyle(optionsOf(el)).display).toBe('none');
  });

  it('has an expanded-hover rule that reveals the options legend', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
    const rules = Array.from(sheet.cssRules) as CSSStyleRule[];
    const hoverRule = rules.find(
      (r) =>
        r.selectorText?.includes(':host([expanded]:hover)') &&
        r.selectorText.includes('.fznew-options')
    );
    expect(hoverRule).toBeDefined();
    expect(hoverRule?.style.display).toBe('flex');
  });

  it('clicking an option button fires its event immediately', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    const evts: string[] = [];
    for (const t of ['new-chat-save', 'new-chat-skip', 'new-chat-erase']) {
      el.addEventListener(t, () => evts.push(t));
    }
    optionOf(el, 'skip').click();
    optionOf(el, 'erase').click();
    optionOf(el, 'save').click();
    expect(evts).toEqual(['new-chat-skip', 'new-chat-erase', 'new-chat-save']);
  });

  it('uses a lighter label font weight than the prototype 600', () => {
    const el = mount((node) => {
      node.expanded = true;
    });
    expect(getComputedStyle(labelOf(el)).fontWeight).toBe('500');
  });

  // --- busy / pending progress ---------------------------------------------

  it('reflects the busy property to the attribute and back', () => {
    const el = mount();
    expect(el.busy).toBe(false);
    el.busy = true;
    expect(el.hasAttribute('busy')).toBe(true);
    el.busy = false;
    expect(el.hasAttribute('busy')).toBe(false);
    el.setAttribute('busy', '');
    expect(el.busy).toBe(true);
  });

  it('idle: no spinner glyph and no aria-busy on the button', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.fznew-spinner')).toBeNull();
    expect(buttonOf(el).hasAttribute('aria-busy')).toBe(false);
    // the default new-chat icon slot is present when idle
    expect(badgeOf(el).querySelector('slot[name="icon"]')).toBeTruthy();
  });

  it('busy: swaps the badge glyph for a lucide spinner and sets aria-busy', () => {
    const el = mount((node) => {
      node.busy = true;
    });
    const spinner = el.shadowRoot?.querySelector('.fznew-spinner') as HTMLElement;
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute('part')).toBe('spinner');
    const svg = spinner.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('part')).toBe('icon');
    // the idle square-pen icon slot is replaced while busy
    expect(badgeOf(el).querySelector('slot[name="icon"]')).toBeNull();
    expect(buttonOf(el).getAttribute('aria-busy')).toBe('true');
  });

  it('a single (save) click enters the busy state optimistically', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      buttonOf(el).click();
      // Deferred during the double-click window — not busy yet.
      expect(el.busy).toBe(false);
      vi.advanceTimersByTime(350);
      expect(el.busy).toBe(true);
      expect(el.shadowRoot?.querySelector('.fznew-spinner')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skip / erase do not enter the busy state', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      const btn = buttonOf(el);
      btn.click();
      btn.click(); // double click → skip
      vi.advanceTimersByTime(500);
      expect(el.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the spinner static under prefers-reduced-motion', () => {
    const el = mount((node) => {
      node.busy = true;
    });
    const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
    const media = (Array.from(sheet.cssRules) as CSSRule[]).find(
      (r): r is CSSMediaRule =>
        r instanceof CSSMediaRule && r.conditionText.includes('prefers-reduced-motion')
    );
    expect(media).toBeDefined();
    const spinRule = (Array.from(media!.cssRules) as CSSStyleRule[]).find((r) =>
      r.selectorText?.includes('.fznew-spinner svg')
    );
    // Assert the stable `animation-name` longhand: current Chromium serializes the
    // `animation` shorthand as its full longhand expansion (because the
    // `animation-duration` initial is now `auto`), so a `=== 'none'` check on the
    // shorthand is brittle. `animation-name: none` is the precise "no spin" signal.
    expect(spinRule?.style.animationName).toBe('none');
  });

  // --- determinate progress ring -------------------------------------------

  it('reflects the progress property to the attribute and clamps to 0..1', () => {
    const el = mount();
    expect(el.progress).toBeNull();
    el.progress = 0.5;
    expect(el.getAttribute('progress')).toBe('0.5');
    expect(el.progress).toBe(0.5);
    el.progress = 2;
    expect(el.progress).toBe(1);
    el.progress = -1;
    expect(el.progress).toBe(0);
    el.progress = null;
    expect(el.hasAttribute('progress')).toBe(false);
    expect(el.progress).toBeNull();
  });

  it('busy without progress shows no determinate ring (plain spinner)', () => {
    const el = mount((node) => {
      node.busy = true;
    });
    expect(el.shadowRoot?.querySelector('.fznew-spinner')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('.fznew-ring')).toBeNull();
  });

  it('busy + progress renders the ring with the part hook and the progress var', () => {
    const el = mount((node) => {
      node.busy = true;
      node.progress = 0.25;
    });
    const ring = el.shadowRoot?.querySelector('.fznew-ring') as HTMLElement;
    expect(ring).toBeTruthy();
    expect(ring.getAttribute('part')).toBe('ring');
    expect(ring.style.getPropertyValue('--fznew-progress')).toBe('0.25');
  });

  it('does NOT render a ring when progress is set but the element is idle', () => {
    const el = mount((node) => {
      node.progress = 0.5;
    });
    expect(el.shadowRoot?.querySelector('.fznew-ring')).toBeNull();
  });

  it('streams progress updates in place without rebuilding the spinner svg', () => {
    const el = mount((node) => {
      node.busy = true;
      node.progress = 0.1;
    });
    const svgBefore = el.shadowRoot?.querySelector('.fznew-spinner svg');
    el.progress = 0.8;
    const ring = el.shadowRoot?.querySelector('.fznew-ring') as HTMLElement;
    expect(ring.style.getPropertyValue('--fznew-progress')).toBe('0.8');
    // Same svg node — the fast path updated the var, it did not re-render.
    expect(el.shadowRoot?.querySelector('.fznew-spinner svg')).toBe(svgBefore);
  });

  it('removing the progress attribute drops the ring back to the plain spinner', () => {
    const el = mount((node) => {
      node.busy = true;
      node.progress = 0.5;
    });
    expect(el.shadowRoot?.querySelector('.fznew-ring')).toBeTruthy();
    el.progress = null;
    expect(el.shadowRoot?.querySelector('.fznew-ring')).toBeNull();
    expect(el.shadowRoot?.querySelector('.fznew-spinner')).toBeTruthy();
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
    const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
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
