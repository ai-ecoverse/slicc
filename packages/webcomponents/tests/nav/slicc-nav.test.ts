import { beforeEach, describe, expect, it } from 'vitest';
import { SliccNav } from '../../src/nav/slicc-nav.js';
// Siblings from earlier waves — already registered; safe to import so the
// populated bar mirrors the prototype's header (logo + switcher + controls).
import '../../src/primitives/slicc-avatar.js';
import '../../src/primitives/slicc-floatbar.js';
import '../../src/primitives/slicc-logo.js';
import '../../src/switcher/slicc-scoop-switcher.js';
import '../../src/theme/slicc-theme-toggle.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** The auto-inserted (or author-supplied) flexible spacer in the bar. */
function spacerOf(el: SliccNav): HTMLElement | null {
  return el.querySelector(':scope > .slicc-nav__spacer, :scope > .spacer');
}

/**
 * Build a realistic, populated nav: logo → scoop switcher → floatbar → theme
 * toggle → avatar, in DOM (== layout) order, matching the prototype header. The
 * nav auto-inserts the flexible spacer before the floatbar.
 */
function makeNav(accent?: string): SliccNav {
  const el = document.createElement('slicc-nav') as SliccNav;
  // Give the bar real width so the flex row + spacer geometry resolves.
  el.style.cssText = 'width:1000px;';
  if (accent) el.setAttribute('accent', accent);
  el.innerHTML = `
    <slicc-logo></slicc-logo>
    <slicc-scoop-switcher active="cone">
      <slicc-pill class="scoop" data-k="cone" type="cone" color="#b07823" eyes="open" label="Sliccy" active></slicc-pill>
      <slicc-pill class="scoop" data-k="researcher" type="scoop" color="#06b6d4" eyes="none" label="researcher"></slicc-pill>
    </slicc-scoop-switcher>
    <slicc-floatbar label="CLI · tray · 1 follower" linked online></slicc-floatbar>
    <slicc-theme-toggle></slicc-theme-toggle>
    <slicc-avatar initials="PM"></slicc-avatar>`;
  return el;
}

describe('slicc-nav', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-nav')).toBe(SliccNav);
  });

  it('renders into light DOM (no shadow root) and tags itself as part="bar"', () => {
    const el = makeNav();
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    expect(el.classList.contains('slicc-nav')).toBe(true);
    expect(el.getAttribute('part')).toBe('bar');
  });

  it('reflects the accent attribute to the property and back', () => {
    const el = makeNav();
    document.body.appendChild(el);

    expect(el.accent).toBeNull();
    el.accent = '#06b6d4';
    expect(el.getAttribute('accent')).toBe('#06b6d4');
    expect(el.accent).toBe('#06b6d4');

    el.setAttribute('accent', '#8b5cf6');
    expect(el.accent).toBe('#8b5cf6');

    el.accent = null;
    expect(el.hasAttribute('accent')).toBe(false);
    expect(el.accent).toBeNull();
  });

  it('keeps the composed controls in DOM (== layout) order', () => {
    const el = makeNav();
    document.body.appendChild(el);
    const tags = [...el.children]
      .filter((c) => c.tagName.startsWith('SLICC-') || c.classList.contains('slicc-nav__spacer'))
      .map((c) => (c.classList.contains('slicc-nav__spacer') ? 'spacer' : c.tagName.toLowerCase()));
    // logo, switcher, [auto spacer], floatbar, theme toggle, avatar.
    expect(tags[0]).toBe('slicc-logo');
    expect(tags[1]).toBe('slicc-scoop-switcher');
    expect(tags).toContain('spacer');
    expect(tags).toContain('slicc-floatbar');
    expect(tags).toContain('slicc-theme-toggle');
    expect(tags).toContain('slicc-avatar');
    // Avatar is last.
    expect(tags[tags.length - 1]).toBe('slicc-avatar');
  });

  it('auto-inserts the flexible spacer immediately before the first right-aligned control', () => {
    const el = makeNav();
    document.body.appendChild(el);
    const spacer = spacerOf(el);
    expect(spacer).not.toBeNull();
    expect(el.spacer).toBe(spacer);
    // It sits right before the floatbar (the first right-aligned control).
    const floatbar = el.querySelector('slicc-floatbar');
    expect(spacer!.nextElementSibling).toBe(floatbar);
    // The spacer is the flexible gap (flex-grow:1).
    expect(getComputedStyle(spacer as HTMLElement).flexGrow).toBe('1');
    expect((spacer as HTMLElement).getAttribute('part')).toBe('spacer');
  });

  it('respects an author-supplied .spacer (does not insert a second one)', () => {
    const el = document.createElement('slicc-nav') as SliccNav;
    el.innerHTML = `
      <slicc-logo></slicc-logo>
      <div class="spacer"></div>
      <slicc-avatar initials="PM"></slicc-avatar>`;
    document.body.appendChild(el);
    expect(el.querySelectorAll('.spacer, .slicc-nav__spacer').length).toBe(1);
    // The author's spacer is still flexible (styled by the host rule).
    expect(getComputedStyle(el.querySelector('.spacer') as HTMLElement).flexGrow).toBe('1');
  });

  it('falls back to appending the spacer at the end when there is no right-aligned control', () => {
    const el = document.createElement('slicc-nav') as SliccNav;
    el.innerHTML = '<slicc-logo></slicc-logo>';
    document.body.appendChild(el);
    const spacer = spacerOf(el);
    expect(spacer).not.toBeNull();
    expect(spacer).toBe(el.lastElementChild);
  });

  it('maps the accent attribute onto the --ctx custom property inline on the host', () => {
    const el = makeNav('#8b5cf6');
    document.body.appendChild(el);
    expect(el.style.getPropertyValue('--ctx').trim()).toBe('#8b5cf6');

    // Updating accent updates --ctx.
    el.accent = '#06b6d4';
    expect(el.style.getPropertyValue('--ctx').trim()).toBe('#06b6d4');

    // Clearing accent removes the inline override (falls back to inherited --ctx).
    el.accent = null;
    expect(el.style.getPropertyValue('--ctx')).toBe('');
  });

  it('emits a composed, bubbling slicc-nav-accent-change when the accent changes', () => {
    const el = makeNav();
    document.body.appendChild(el);

    const seen: (string | null)[] = [];
    let composed = false;
    document.body.addEventListener('slicc-nav-accent-change', (e) => {
      const ce = e as CustomEvent<{ accent: string | null }>;
      seen.push(ce.detail.accent);
      composed = ce.composed && ce.bubbles;
    });

    el.accent = '#f43f5e';
    el.accent = null;

    expect(seen).toEqual(['#f43f5e', null]);
    expect(composed).toBe(true);
  });

  it('is a fixed-height frosted header: --barh height, 0 24px padding, bottom --line border, z-index 4', () => {
    const el = makeNav('#f59e0b');
    document.body.appendChild(el);
    const cs = getComputedStyle(el);

    // Fixed bar height from --barh (44px).
    expect(cs.height).toBe('44px');
    // Prototype padding: 0 vertical, 24px horizontal.
    expect(cs.paddingTop).toBe('0px');
    expect(cs.paddingLeft).toBe('24px');
    expect(cs.paddingRight).toBe('24px');
    // 14px inter-control gap.
    expect(cs.columnGap).toBe('14px');

    // Bottom border from --line; the other edges stay borderless.
    expect(cs.borderBottomStyle).toBe('solid');
    expect(cs.borderBottomWidth).toBe('1px');
    expect(cs.borderTopStyle).toBe('none');

    // Stacks above the chat shell below it.
    expect(cs.zIndex).toBe('4');

    // Frosted glass: blur + saturate backdrop filter.
    const backdrop =
      cs.backdropFilter || (cs as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter;
    expect(backdrop).toContain('blur(18px)');
    expect(backdrop).toContain('saturate(1.4)');

    // It is a flex row.
    expect(cs.display).toBe('flex');
  });

  it('context-tinted: the frosted background reacts to the accent (--ctx) — different accents → different surfaces', () => {
    const amber = makeNav('#f59e0b');
    document.body.appendChild(amber);
    const amberBg = getComputedStyle(amber).backgroundColor;

    const cyan = makeNav('#06b6d4');
    document.body.appendChild(cyan);
    const cyanBg = getComputedStyle(cyan).backgroundColor;

    // The color-mix tint resolves to concrete, non-transparent colors that
    // differ because --ctx differs.
    expect(amberBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(cyanBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(amberBg).not.toBe(cyanBg);
    expect(/(rgba?|color)\(/.test(amberBg)).toBe(true);
  });

  it('light variant: background mixes the accent over the light --canvas', () => {
    const el = makeNav('#f59e0b');
    document.body.appendChild(el);
    const bg = getComputedStyle(el).backgroundColor;
    expect(bg).not.toBe('transparent');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(/(rgba?|color)\(/.test(bg)).toBe(true);
  });

  it('dark variant: recomputes the frosted tint from the flipped --canvas/--line (no explicit dark rule)', () => {
    const el = makeNav('#f59e0b');
    document.body.appendChild(el);
    const light = getComputedStyle(el).backgroundColor;

    setTheme('dark');
    const dark = getComputedStyle(el).backgroundColor;
    // --canvas flips dark, so the color-mix tint resolves to a different surface.
    expect(dark).not.toBe(light);
    expect(dark).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('survives detach + re-attach without duplicating the spacer', () => {
    const el = makeNav();
    document.body.appendChild(el);
    const spacer = spacerOf(el);

    el.remove();
    document.body.appendChild(el);

    expect(spacerOf(el)).toBe(spacer);
    expect(el.querySelectorAll('.slicc-nav__spacer, .spacer').length).toBe(1);
  });

  it('pushes the right-aligned controls to the edge: avatar sits at the bar right inset', () => {
    const el = makeNav('#f59e0b');
    document.body.appendChild(el);
    const avatar = el.querySelector('slicc-avatar') as HTMLElement;
    const navRect = el.getBoundingClientRect();
    const avatarRect = avatar.getBoundingClientRect();
    // The avatar's right edge sits at the bar's right edge minus the 24px inset
    // (allow a small tolerance for sub-pixel rounding).
    expect(navRect.right - avatarRect.right).toBeGreaterThan(20);
    expect(navRect.right - avatarRect.right).toBeLessThan(28);
    // And it is pushed well past the left cluster (the spacer absorbed the gap).
    expect(avatarRect.left - navRect.left).toBeGreaterThan(300);
  });

  it('tightens its padding + gap below 560px so the bar fits an extension sidebar', () => {
    const el = document.createElement('slicc-nav');
    document.body.appendChild(el);
    const sheet = (document.getElementById('slicc-nav-style') as HTMLStyleElement).sheet;
    const media = Array.from(sheet?.cssRules ?? []).find(
      (r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText.includes('560px')
    );
    expect(media).toBeDefined();
    const navRule = Array.from((media as CSSMediaRule).cssRules).find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('.slicc-nav')
    );
    expect(navRule?.style.paddingLeft).toBe('10px');
    expect(navRule?.style.gap).toBe('8px');
  });
});
