import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccFreezerCard } from '../../src/freezer/slicc-freezer-card.js';
// Sibling composed by tag — already registered when tests run; importing it lets
// us assert the badge upgrades to the real <slicc-snowflake> element.
import { SliccSnowflake } from '../../src/primitives/slicc-snowflake.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccFreezerCard) => void): SliccFreezerCard {
  const el = document.createElement('slicc-freezer-card');
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

function makeCard(
  attrs: { title?: string; meta?: string; slug?: string; expanded?: boolean } = {}
): SliccFreezerCard {
  const el = document.createElement('slicc-freezer-card');
  if (attrs.title) el.setAttribute('title', attrs.title);
  if (attrs.meta) el.setAttribute('meta', attrs.meta);
  if (attrs.slug) el.setAttribute('slug', attrs.slug);
  if (attrs.expanded) el.setAttribute('expanded', '');
  return el;
}

const badgeOf = (el: SliccFreezerCard) => el.querySelector('slicc-snowflake') as SliccSnowflake;
const textOf = (el: SliccFreezerCard) => el.querySelector('.slicc-fzcard__text') as HTMLElement;
const titleOf = (el: SliccFreezerCard) => el.querySelector('.slicc-fzcard__title') as HTMLElement;
const metaOf = (el: SliccFreezerCard) => el.querySelector('.slicc-fzcard__meta') as HTMLElement;

describe('slicc-freezer-card', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  // --- registration --------------------------------------------------------

  it('registers the custom element', () => {
    expect(customElements.get('slicc-freezer-card')).toBe(SliccFreezerCard);
  });

  // --- structure -----------------------------------------------------------

  it('renders into light DOM (no shadow root): badge + text column', () => {
    const el = makeCard({ title: 'warm hero redesign', meta: '2h ago', slug: 'warm-hero' });
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();

    const badge = badgeOf(el);
    const text = textOf(el);
    expect(badge).not.toBeNull();
    expect(text).not.toBeNull();
    // Composes the snowflake by tag — it upgrades to the real element.
    expect(badge).toBeInstanceOf(SliccSnowflake);
    expect(badge.getAttribute('part')).toBe('badge');
    expect(text.getAttribute('part')).toBe('text');

    // Badge precedes the text column.
    expect(badge.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('exposes title/meta part hooks and renders the attribute text', () => {
    const el = makeCard({
      title: 'warm hero redesign',
      meta: '2h ago · 18 turns · PR #128',
      slug: 'warm-hero',
    });
    document.body.appendChild(el);
    const title = titleOf(el);
    const metaEl = metaOf(el);
    expect(title.getAttribute('part')).toBe('title');
    expect(metaEl.getAttribute('part')).toBe('meta');
    expect(title.textContent).toBe('warm hero redesign');
    expect(metaEl.textContent).toBe('2h ago · 18 turns · PR #128');
  });

  it('falls back to slotted title content when the title attribute is absent', () => {
    const el = document.createElement('slicc-freezer-card');
    el.innerHTML = '<b class="slotted">slotted heading</b>';
    document.body.appendChild(el);
    const title = titleOf(el);
    expect(title.querySelector('.slotted')).not.toBeNull();
    expect(title.textContent).toBe('slotted heading');
  });

  it('escapes interpolated meta text', () => {
    const el = mount((node) => {
      node.setAttribute('meta', '<img src=x onerror=alert(1)> · now');
    });
    const metaEl = metaOf(el);
    expect(metaEl.querySelector('img')).toBeNull();
    expect(metaEl.textContent).toBe('<img src=x onerror=alert(1)> · now');
  });

  it('exposes the badge getter (same node as the rendered badge)', () => {
    const el = mount();
    expect(el.badge).toBe(badgeOf(el));
  });

  // --- attribute ↔ property reflection -------------------------------------

  it('reflects title / meta / slug to attributes and back', () => {
    const el = mount();
    el.title = 'pricing table revamp';
    el.meta = '3 weeks ago';
    el.slug = 'pricing';
    expect(el.getAttribute('title')).toBe('pricing table revamp');
    expect(el.getAttribute('meta')).toBe('3 weeks ago');
    expect(el.getAttribute('slug')).toBe('pricing');
    expect(el.title).toBe('pricing table revamp');
    expect(el.meta).toBe('3 weeks ago');
    expect(el.slug).toBe('pricing');

    el.title = null;
    el.meta = null;
    el.slug = null;
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.hasAttribute('meta')).toBe(false);
    expect(el.hasAttribute('slug')).toBe(false);
    expect(el.slug).toBe('');
  });

  it('reflects boolean expanded / thawed / hidden to attributes and back', () => {
    const el = mount();
    expect(el.expanded).toBe(false);
    expect(el.thawed).toBe(false);
    expect(el.hidden).toBe(false);

    el.expanded = true;
    el.thawed = true;
    el.hidden = true;
    expect(el.hasAttribute('expanded')).toBe(true);
    expect(el.hasAttribute('thawed')).toBe(true);
    expect(el.hasAttribute('hidden')).toBe(true);

    el.expanded = false;
    el.thawed = false;
    el.hidden = false;
    expect(el.hasAttribute('expanded')).toBe(false);
    expect(el.hasAttribute('thawed')).toBe(false);
    expect(el.hasAttribute('hidden')).toBe(false);

    el.setAttribute('expanded', '');
    expect(el.expanded).toBe(true);
  });

  it('updates the title/meta scaffold when attributes change after connect', () => {
    const el = makeCard({ title: 'a', meta: 'b' });
    document.body.appendChild(el);
    el.title = 'onboarding rewrite';
    el.meta = 'last week · 24 turns';
    expect(titleOf(el).textContent).toBe('onboarding rewrite');
    expect(metaOf(el).textContent).toBe('last week · 24 turns');
  });

  // --- custom icon ---------------------------------------------------------

  it('defaults to the snowflake badge with no slotted glyph (icon absent)', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago' });
    document.body.appendChild(el);
    // No light-DOM svg is slotted into the badge — the default snowflake glyph
    // lives in the snowflake's own shadow root.
    expect(badgeOf(el).querySelector(':scope > svg')).toBeNull();
    expect(el.icon).toBeNull();
  });

  it('icon: renders a custom lucide glyph slotted into the badge', () => {
    const el = makeCard({ title: 'hotfix', meta: '5 turns' });
    el.setAttribute('icon', 'flame');
    document.body.appendChild(el);
    const glyph = badgeOf(el).querySelector(':scope > svg');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(glyph?.getAttribute('stroke')).toBe('currentColor');
    expect(glyph?.getAttribute('part')).toBe('icon');
    expect(el.icon).toBe('flame');
  });

  it('reflects the icon property to the attribute and back', () => {
    const el = mount();
    expect(el.icon).toBeNull();
    el.icon = 'git-branch';
    expect(el.getAttribute('icon')).toBe('git-branch');
    expect(badgeOf(el).querySelector(':scope > svg')).not.toBeNull();
    el.icon = null;
    expect(el.hasAttribute('icon')).toBe(false);
  });

  it('swaps the custom glyph when icon changes and reverts to snowflake when cleared', () => {
    const el = mount();
    el.icon = 'flame';
    const first = badgeOf(el).querySelector(':scope > svg');
    expect(first).not.toBeNull();
    el.icon = 'bug';
    const second = badgeOf(el).querySelector(':scope > svg');
    expect(second).not.toBeNull();
    // Exactly one custom glyph is slotted (the old one is replaced, not stacked).
    expect(badgeOf(el).querySelectorAll(':scope > svg').length).toBe(1);
    expect(second).not.toBe(first);
    el.icon = null;
    expect(badgeOf(el).querySelector(':scope > svg')).toBeNull();
  });

  // --- collapsed vs expanded (real Chromium) -------------------------------

  it('expanded: the row keeps its gap and the text column is visible (opacity 1)', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago', expanded: true });
    el.style.width = '240px';
    document.body.appendChild(el);

    const cs = getComputedStyle(el);
    expect(cs.gap).toBe('10px');

    const text = getComputedStyle(textOf(el));
    expect(text.opacity).toBe('1');
    // Real layout width, not collapsed to zero.
    expect(textOf(el).getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it('collapsed: gap 0, centered, the text column collapses to zero width (badge only)', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago' });
    el.style.width = '240px';
    document.body.appendChild(el);

    const cs = getComputedStyle(el);
    expect(cs.gap).toBe('0px');
    expect(cs.justifyContent).toBe('center');
    expect(cs.paddingLeft).toBe('0px');

    const text = getComputedStyle(textOf(el));
    expect(text.opacity).toBe('0');
    // Width collapses so only the 28px badge takes space.
    expect(textOf(el).getBoundingClientRect().width).toBe(0);
  });

  it('is at least 36px tall with the prototype 8px border radius', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago', expanded: true });
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    expect(Number.parseFloat(cs.minHeight)).toBeCloseTo(36, 0);
    expect(cs.borderTopLeftRadius).toBe('8px');
    expect(cs.cursor).toBe('pointer');
  });

  // --- thawed flash (real Chromium) ----------------------------------------

  it('thawed: paints the rose row background and mirrors thawed onto the badge', () => {
    const el = mount((node) => {
      node.thawed = true;
    });
    const bg = getComputedStyle(el).backgroundColor;
    // Rose-tinted color-mix resolves to a concrete, non-transparent color.
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(/(rgba?|color)\(/.test(bg)).toBe(true);

    // The composed badge picks up `thawed`, so its glyph flips to #b91c4d.
    expect(badgeOf(el).hasAttribute('thawed')).toBe(true);
    const badgeInner = badgeOf(el).shadowRoot?.querySelector('.snow') as HTMLElement;
    expect(getComputedStyle(badgeInner).color).toBe('rgb(185, 28, 77)');
  });

  it('clearing thawed restores the row and badge to the frozen look', () => {
    const el = mount((node) => {
      node.thawed = true;
    });
    expect(badgeOf(el).hasAttribute('thawed')).toBe(true);
    el.thawed = false;
    expect(badgeOf(el).hasAttribute('thawed')).toBe(false);
    const badgeInner = badgeOf(el).shadowRoot?.querySelector('.snow') as HTMLElement;
    expect(getComputedStyle(badgeInner).color).toBe('rgb(115, 115, 115)');
  });

  // --- search-hidden -------------------------------------------------------

  it('hidden: the prototype .match-hidden display:none', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago', expanded: true });
    el.hidden = true;
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('none');
    el.hidden = false;
    expect(getComputedStyle(el).display).toBe('flex');
  });

  // --- behavior / events ---------------------------------------------------

  it('click fires freezer-card-select with the slug, composed + bubbling', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago', slug: 'warm-hero', expanded: true });
    document.body.appendChild(el);

    let detail: { slug: string } | null = null;
    let bubbled = false;
    el.addEventListener('freezer-card-select', (e) => {
      const ce = e as CustomEvent<{ slug: string }>;
      detail = ce.detail;
      expect(ce.bubbles).toBe(true);
      expect(ce.composed).toBe(true);
    });
    document.body.addEventListener('freezer-card-select', () => {
      bubbled = true;
    });

    el.click();
    expect(detail).toEqual({ slug: 'warm-hero' });
    expect(bubbled).toBe(true);
  });

  it('click runs the transient thaw flash and clears it after ~1400ms', () => {
    vi.useFakeTimers();
    try {
      const el = makeCard({ title: 'warm hero', slug: 'warm-hero', expanded: true });
      document.body.appendChild(el);

      el.click();
      expect(el.thawed).toBe(true);
      expect(badgeOf(el).hasAttribute('thawed')).toBe(true);

      vi.advanceTimersByTime(1399);
      expect(el.thawed).toBe(true);

      vi.advanceTimersByTime(2);
      expect(el.thawed).toBe(false);
      expect(badgeOf(el).hasAttribute('thawed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flashThaw restarts a pending flash rather than stacking timers', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      el.flashThaw();
      vi.advanceTimersByTime(1000);
      // Re-trigger before the first flash ends — the window restarts.
      el.flashThaw();
      vi.advanceTimersByTime(1000);
      expect(el.thawed).toBe(true);
      vi.advanceTimersByTime(401);
      expect(el.thawed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a pending thaw timer on disconnect (no late mutation)', () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      el.flashThaw();
      expect(el.thawed).toBe(true);
      el.remove();
      // Timer was cleared on disconnect; advancing must not flip thawed off
      // by re-running the callback (it would still be true from flashThaw).
      vi.advanceTimersByTime(5000);
      expect(el.thawed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- lifecycle -----------------------------------------------------------

  it('survives detach + re-attach without rebuilding / duplicating the scaffold', () => {
    const el = makeCard({ title: 'warm hero', meta: '2h ago', expanded: true });
    document.body.appendChild(el);
    const text = textOf(el);
    const badge = badgeOf(el);

    el.remove();
    document.body.appendChild(el);

    expect(textOf(el)).toBe(text);
    expect(badgeOf(el)).toBe(badge);
    expect(el.querySelectorAll('.slicc-fzcard__text').length).toBe(1);
    expect(el.querySelectorAll('slicc-snowflake').length).toBe(1);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('collapsed hover title', () => {
    it('renders a .tip carrying the session title, shown only when collapsed', () => {
      const el = mount((e) => {
        e.setAttribute('title', 'warm hero redesign');
        e.setAttribute('meta', '2h ago');
      });
      const tip = el.querySelector('.slicc-fzcard__tip') as HTMLElement;
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe('warm hero redesign');
      // Collapsed (no expanded): the tip is available (display:block), faded out.
      expect(getComputedStyle(tip).display).toBe('block');
      expect(getComputedStyle(tip).opacity).toBe('0');
    });

    it('hides the tip when the row is expanded (the title is already visible)', () => {
      const el = mount((e) => {
        e.setAttribute('title', 'warm hero redesign');
        e.setAttribute('expanded', '');
      });
      const tip = el.querySelector('.slicc-fzcard__tip') as HTMLElement;
      expect(getComputedStyle(tip).display).toBe('none');
    });

    it('escapes an overflow-clipping rail: the tip is viewport-fixed at the row edge', () => {
      // The regression: the freezer host clips overflow (width animation), so
      // an absolutely-positioned tip hanging right of the 44px rail was cut
      // off and unreadable. The tip is now position:fixed with coords stamped
      // on hover from the row's rect — clipping ancestors can't touch it.
      const rail = document.createElement('div');
      rail.style.cssText = 'position:fixed;left:0;top:0;width:44px;height:300px;overflow:hidden;';
      const el = document.createElement('slicc-freezer-card') as SliccFreezerCard;
      el.setAttribute('title', 'clipped session');
      rail.appendChild(el);
      document.body.appendChild(rail);

      el.dispatchEvent(new PointerEvent('pointerenter'));
      const tip = el.querySelector('.slicc-fzcard__tip') as HTMLElement;
      expect(getComputedStyle(tip).position).toBe('fixed');

      const row = el.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      // Anchored just right of the row — i.e. OUTSIDE the 44px clipping rail.
      expect(tipRect.left).toBeGreaterThan(row.right);
      expect(tipRect.left).toBeGreaterThan(44);
      // Vertically centered on the row.
      expect(Math.abs(tipRect.top + tipRect.height / 2 - (row.top + row.height / 2))).toBeLessThan(
        2
      );
    });
  });

  describe('hover affordance (ring, not rectangle)', () => {
    function cardStyleRules(): CSSStyleRule[] {
      const styleEl = document.getElementById('slicc-freezer-card-style') as HTMLStyleElement;
      return Array.from((styleEl.sheet as CSSStyleSheet).cssRules) as CSSStyleRule[];
    }

    it('collapsed hover rings the badge ::part instead of a rectangular fill', () => {
      mount(); // ensures the scoped stylesheet is injected into the document
      const rules = cardStyleRules();
      // Collapsed (icon-only) hover/focus paints a circular ring on the badge part.
      const ringRule = rules.find(
        (r) =>
          r.selectorText?.includes(':not([expanded]):hover') &&
          r.selectorText.includes('slicc-snowflake::part(badge)')
      );
      expect(ringRule).toBeDefined();
      expect(ringRule?.style.boxShadow).not.toBe('');
    });

    it('gates the rectangular ghost fill to expanded rows only', () => {
      mount();
      const rules = cardStyleRules();
      const expandedHoverFill = rules.find(
        (r) => r.selectorText === 'slicc-freezer-card[expanded]:hover'
      );
      expect(expandedHoverFill?.style.background).toBe('var(--ghost)');
      // The bare `slicc-freezer-card:hover { background }` rectangular rule is gone.
      expect(rules.some((r) => r.selectorText === 'slicc-freezer-card:hover')).toBe(false);
    });
  });
});
