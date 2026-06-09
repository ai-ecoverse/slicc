import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccTag } from '../../src/primitives/slicc-tag.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const HUES = ['rose', 'cyan', 'violet', 'amber', 'waffle', 'green'] as const;

function makeTag(): SliccTag {
  return document.createElement('slicc-tag') as SliccTag;
}

describe('slicc-tag', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tag')).toBe(SliccTag);
  });

  it('renders a chip with the tag/label parts in its shadow root', () => {
    const el = makeTag();
    el.label = 'tag';
    document.body.appendChild(el);
    const tag = el.shadowRoot?.querySelector('.tag');
    expect(tag?.getAttribute('part')).toBe('tag');
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.getAttribute('part')).toBe('label');
    expect(label?.textContent).toBe('tag');
  });

  it('reflects the label attribute <-> property', () => {
    const el = makeTag();
    el.label = 'project';
    document.body.appendChild(el);
    expect(el.getAttribute('label')).toBe('project');
    expect(el.label).toBe('project');
    el.removeAttribute('label');
    expect(el.label).toBeNull();
  });

  it('reflects the hue attribute <-> property and ignores unknown hues', () => {
    const el = makeTag();
    el.hue = 'violet';
    document.body.appendChild(el);
    expect(el.getAttribute('hue')).toBe('violet');
    expect(el.hue).toBe('violet');
    // Unknown hue value is stored on the attribute but the getter normalizes to null.
    el.setAttribute('hue', 'octarine');
    expect(el.hue).toBeNull();
    el.hue = null;
    expect(el.hasAttribute('hue')).toBe(false);
  });

  it('reflects the dot boolean attribute <-> property and toggles the dot part', () => {
    const el = makeTag();
    el.label = 'x';
    document.body.appendChild(el);
    expect(el.dot).toBe(false);
    expect(el.shadowRoot?.querySelector('.dot')).toBeNull();

    el.dot = true;
    expect(el.hasAttribute('dot')).toBe(true);
    const dot = el.shadowRoot?.querySelector('.dot');
    expect(dot?.getAttribute('part')).toBe('dot');

    el.dot = false;
    expect(el.hasAttribute('dot')).toBe(false);
    expect(el.shadowRoot?.querySelector('.dot')).toBeNull();
  });

  it('falls back to the default slot when no label attribute is set', () => {
    const el = makeTag();
    el.textContent = 'slotted';
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('slot')).not.toBeNull();
    // The slotted light-DOM content is what actually renders.
    expect(el.textContent).toBe('slotted');
  });

  it('prefers the label attribute over slot content', () => {
    const el = makeTag();
    el.textContent = 'slotted';
    el.label = 'attr';
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('slot')).toBeNull();
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('attr');
  });

  it('escapes label text', () => {
    const el = makeTag();
    el.label = '<script>x</script>';
    document.body.appendChild(el);
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.querySelector('script')).toBeNull();
    expect(label?.textContent).toBe('<script>x</script>');
  });

  it('renders a neutral chip by default (no hue) with token background and border', () => {
    const el = makeTag();
    el.label = 'neutral';
    document.body.appendChild(el);
    const tag = el.shadowRoot?.querySelector('.tag') as HTMLElement;
    const cs = getComputedStyle(tag);
    // Pill shape + prototype sizing.
    expect(parseFloat(cs.borderTopLeftRadius)).toBeGreaterThanOrEqual(13);
    expect(cs.fontSize).toBe('10px');
    expect(cs.borderTopWidth).toBe('1px');
    // Neutral background resolves to (near) white canvas in light mode.
    expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  for (const hue of HUES) {
    it(`tints the ${hue} variant: distinct text color, tinted fill, and visible border`, () => {
      const neutral = makeTag();
      neutral.label = 'n';
      const tinted = makeTag();
      tinted.hue = hue;
      tinted.label = hue;
      document.body.append(neutral, tinted);

      const neutralCs = getComputedStyle(neutral.shadowRoot?.querySelector('.tag') as HTMLElement);
      const tintedTag = tinted.shadowRoot?.querySelector('.tag') as HTMLElement;
      const cs = getComputedStyle(tintedTag);

      // Text color is the hue, so it differs from the neutral chip's muted text.
      expect(cs.color).not.toBe(neutralCs.color);
      // Fill and border resolve to opaque mixes over the canvas.
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(cs.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
      // Tinting changes the fill away from the neutral background.
      expect(cs.backgroundColor).not.toBe(neutralCs.backgroundColor);
    });
  }

  it('deepens the tint in dark mode (background differs from light)', () => {
    const light = makeTag();
    light.hue = 'violet';
    light.label = 'p';
    document.body.appendChild(light);
    const lightBg = getComputedStyle(
      light.shadowRoot?.querySelector('.tag') as HTMLElement
    ).backgroundColor;

    document.body.classList.add('dark');
    const dark = makeTag();
    dark.hue = 'violet';
    dark.label = 'p';
    document.body.appendChild(dark);
    const darkBg = getComputedStyle(
      dark.shadowRoot?.querySelector('.tag') as HTMLElement
    ).backgroundColor;

    expect(darkBg).not.toBe(lightBg);
  });

  it('re-renders when attributes change after connection', () => {
    const el = makeTag();
    el.label = 'one';
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('one');
    el.label = 'two';
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('two');
  });
});
