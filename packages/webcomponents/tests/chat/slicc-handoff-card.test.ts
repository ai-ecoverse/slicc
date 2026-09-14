import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccHandoffCard } from '../../src/chat/slicc-handoff-card.js';
import { iconSvg } from '../../src/internal/icons.js';

import { SliccGooglyEyes } from '../../src/primitives/slicc-googly-eyes.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{21FF}]|[\u{2900}-\u{297F}]|[\u{2B00}-\u{2BFF}]|[\u{FF00}-\u{FFEF}]/u;

function lucideShapeKey(name: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = iconSvg(name, { size: 12 });
  const svg = tmp.querySelector('svg') as SVGSVGElement;
  return [...svg.children].map((c) => c.outerHTML).join('');
}

function mount(attrs: Record<string, string> = {}): SliccHandoffCard {
  const el = document.createElement('slicc-handoff-card');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe('slicc-handoff-card', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-handoff-card')).toBe(SliccHandoffCard);
  });

  it('registers the composed googly-eyes sibling', () => {
    expect(customElements.get('slicc-googly-eyes')).toBe(SliccGooglyEyes);
  });

  it('reflects attributes to properties and back', () => {
    const el = mount();
    el.variant = 'opened';
    el.name = 'Hero studio';
    el.pre = 'From';
    el.text = 'body';
    el.eyes = 'dead';
    expect(el.getAttribute('variant')).toBe('opened');
    expect(el.getAttribute('name')).toBe('Hero studio');
    expect(el.getAttribute('pre')).toBe('From');
    expect(el.getAttribute('text')).toBe('body');
    expect(el.getAttribute('eyes')).toBe('dead');

    el.name = null;
    el.pre = null;
    el.text = null;
    expect(el.hasAttribute('name')).toBe(false);
    expect(el.hasAttribute('pre')).toBe(false);
    expect(el.hasAttribute('text')).toBe(false);
  });

  it('defaults variant to handoff and eyes to open', () => {
    const el = mount();
    expect(el.variant).toBe('handoff');
    expect(el.eyes).toBe('open');

    el.setAttribute('variant', 'bogus');
    el.setAttribute('eyes', 'bogus');
    expect(el.variant).toBe('handoff');
    expect(el.eyes).toBe('open');
  });

  describe('handoff variant (default)', () => {
    it('renders the bordered card structure with avatar, label and paragraph', () => {
      const el = mount({ name: 'acme.com', text: 'Continue in SLICC.' });
      const card = el.shadowRoot?.querySelector('.handoff');
      expect(card).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.handoff .top')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.handoff .av')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.handoff .lbl2')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.handoff p')?.textContent).toBe('Continue in SLICC.');

      expect(el.shadowRoot?.querySelector('.opened')).toBeNull();
    });

    it('composes the googly-eyes avatar by tag inside .av', () => {
      const el = mount({ name: 'acme.com' });
      const eyes = el.shadowRoot?.querySelector('.av slicc-googly-eyes');
      expect(eyes).toBeInstanceOf(SliccGooglyEyes);
    });

    it('forwards the dead eye state to the avatar', () => {
      const el = mount({ name: 'acme.com', eyes: 'dead' });
      const eyes = el.shadowRoot?.querySelector('.av slicc-googly-eyes') as SliccGooglyEyes;
      expect(eyes.getAttribute('eyes')).toBe('dead');

      el.eyes = 'open';
      const open = el.shadowRoot?.querySelector('.av slicc-googly-eyes') as SliccGooglyEyes;
      expect(open.hasAttribute('eyes')).toBe(false);
    });

    it('renders a lucide hand glyph in the label — never an emoji', () => {
      const el = mount({ name: 'acme.com' });
      const hand = el.shadowRoot?.querySelector('.lbl2 .hand') as HTMLElement;
      expect(hand).not.toBeNull();
      expect(hand.getAttribute('part')).toBe('hand');
      const svg = hand.querySelector('svg');
      expect(svg).toBeInstanceOf(SVGSVGElement);

      expect(svg?.innerHTML).toBe(lucideShapeKey('hand'));
      expect(svg?.getAttribute('width')).toBe('13');

      expect(EMOJI_RE.test(el.shadowRoot?.textContent ?? '')).toBe(false);
    });

    it('tints the hand glyph violet', () => {
      const el = mount({ name: 'acme.com' });
      const hand = el.shadowRoot?.querySelector('.lbl2 .hand') as HTMLElement;

      expect(getComputedStyle(hand).color).toBe('rgb(139, 92, 246)');
    });

    it('renders the muted prefix and a violet bold name', () => {
      const el = mount({ name: 'acme.com', pre: 'Handoff request from' });
      const pre = el.shadowRoot?.querySelector('.lbl2 .pre');
      const name = el.shadowRoot?.querySelector('.lbl2 b');
      expect(pre?.textContent).toBe('Handoff request from');
      expect(name?.textContent).toBe('acme.com');
    });

    it('uses the default prefix when pre is absent', () => {
      const el = mount({ name: 'acme.com' });
      expect(el.shadowRoot?.querySelector('.lbl2 .pre')?.textContent).toBe('Handoff request from');
    });

    it('falls back to slotted body when text attribute is absent', () => {
      const el = mount({ name: 'acme.com' });
      expect(el.shadowRoot?.querySelector('p slot')).not.toBeNull();
    });

    it('escapes interpolated name and body text', () => {
      const el = mount({ name: '<img src=x>', text: '<b>x</b>' });
      const name = el.shadowRoot?.querySelector('.lbl2 b');
      const p = el.shadowRoot?.querySelector('p');
      expect(name?.querySelector('img')).toBeNull();
      expect(name?.textContent).toBe('<img src=x>');
      expect(p?.querySelector('b')).toBeNull();
      expect(p?.textContent).toBe('<b>x</b>');
    });

    it('paints a violet-tinted round avatar (light mode)', () => {
      const el = mount({ name: 'acme.com' });
      const av = el.shadowRoot?.querySelector('.av') as HTMLElement;
      const cs = getComputedStyle(av);

      expect(Number.parseFloat(cs.width)).toBeCloseTo(26, 0);
      expect(Number.parseFloat(cs.height)).toBeCloseTo(26, 0);

      const bg = cs.backgroundColor;
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      const nums = bg.match(/[\d.]+/g)?.map(Number) ?? [];
      const red = bg.startsWith('color(') ? nums[0] * 255 : nums[0];
      expect(red).toBeGreaterThan(200);
    });

    it('routes the avatar tint toward the dark canvas in dark mode', () => {
      const el = mount({ name: 'acme.com' });
      const av = el.shadowRoot?.querySelector('.av') as HTMLElement;
      const light = getComputedStyle(av).backgroundColor;
      document.body.classList.add('dark');
      const dark = getComputedStyle(av).backgroundColor;
      expect(dark).not.toBe(light);
      const m = dark.match(/\d+/g)?.map(Number) ?? [];

      expect(m[0]).toBeLessThan(120);
    });
  });

  describe('opened variant', () => {
    it('renders the compact ghost pill with a rainbow glyph chip and bold target', () => {
      const el = mount({ variant: 'opened', name: 'Hero studio', text: '· interactive sprinkle' });
      const card = el.shadowRoot?.querySelector('.opened');
      expect(card).not.toBeNull();

      expect(el.shadowRoot?.querySelector('.opened .sg')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.opened b')?.textContent).toBe('Hero studio');
      expect(el.shadowRoot?.textContent).toContain('· interactive sprinkle');

      expect(el.shadowRoot?.querySelector('.handoff')).toBeNull();
      expect(el.shadowRoot?.querySelector('slicc-googly-eyes')).toBeNull();
    });

    it('renders the rainbow chip as a lucide sparkles <svg> — never the ✦ glyph', () => {
      const el = mount({ variant: 'opened', name: 'Hero studio' });
      const chip = el.shadowRoot?.querySelector('.opened .sg') as HTMLElement;
      const svg = chip.querySelector('svg');

      expect(svg).toBeInstanceOf(SVGSVGElement);

      expect(svg?.innerHTML).toBe(lucideShapeKey('sparkles'));
      expect(svg?.getAttribute('width')).toBe('12');
      expect(svg?.getAttribute('height')).toBe('12');

      expect((chip.textContent ?? '').trim()).toBe('');
      expect(chip.textContent ?? '').not.toContain('✦');
      expect(EMOJI_RE.test(el.shadowRoot?.textContent ?? '')).toBe(false);
      expect(EMOJI_RE.test(chip.outerHTML)).toBe(false);
    });

    it('tints the sparkles glyph via currentColor (white chip text)', () => {
      const el = mount({ variant: 'opened', name: 'Hero studio' });
      const svg = el.shadowRoot?.querySelector('.opened .sg svg') as SVGSVGElement;

      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(getComputedStyle(svg).color).toBe('rgb(255, 255, 255)');
    });

    it('paints the rainbow glyph chip as a gradient', () => {
      const el = mount({ variant: 'opened', name: 'Hero studio' });
      const sg = el.shadowRoot?.querySelector('.sg') as HTMLElement;
      expect(getComputedStyle(sg).backgroundImage).toContain('gradient');
    });

    it('uses the ghost ground for the pill', () => {
      const el = mount({ variant: 'opened', name: 'Hero studio' });
      const card = el.shadowRoot?.querySelector('.opened') as HTMLElement;
      const cs = getComputedStyle(card);
      expect(cs.display).toBe('flex');

      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    });

    it('re-renders from handoff to opened when variant changes', () => {
      const el = mount({ name: 'acme.com', text: 'body' });
      expect(el.shadowRoot?.querySelector('.handoff')).not.toBeNull();
      el.variant = 'opened';
      expect(el.shadowRoot?.querySelector('.handoff')).toBeNull();
      expect(el.shadowRoot?.querySelector('.opened')).not.toBeNull();
    });

    it('escapes interpolated name in the opened variant', () => {
      const el = mount({ variant: 'opened', name: '<x>', text: 'ok' });
      const b = el.shadowRoot?.querySelector('.opened b');
      expect(b?.querySelector('x')).toBeNull();
      expect(b?.textContent).toBe('<x>');
    });
  });
});
