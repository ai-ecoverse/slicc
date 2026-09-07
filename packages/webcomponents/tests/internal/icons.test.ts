import { describe, expect, it } from 'vitest';
import { hasIcon, iconEl, iconSvg } from '../../src/internal/icons.js';

describe('iconSvg()', () => {
  it('renders a known lucide icon', () => {
    const svg = iconSvg('arrow-up');
    expect(svg).toContain('<svg');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it('accepts kebab, camel and Pascal spellings', () => {
    expect(hasIcon('arrow-up')).toBe(true);
    expect(hasIcon('arrowUp')).toBe(true);
    expect(hasIcon('ArrowUp')).toBe(true);
    expect(hasIcon('definitely-not-an-icon')).toBe(false);
  });

  it('yields an empty but correctly sized svg for an unknown name', () => {
    const svg = iconSvg('definitely-not-an-icon', { size: 24 });
    expect(svg).toContain('width="24"');
    expect(svg).not.toContain('<path');
  });

  // Escaping only `"` left a raw `&` in the value, which either swallows what
  // follows as a character reference or comes back double-escaped.
  it('fully escapes attribute values instead of only the quote', () => {
    const svg = iconSvg('arrow-up', { class: 'a&b "c"', part: '<p>' });
    expect(svg).toContain('class="a&amp;b &quot;c&quot;"');
    expect(svg).toContain('part="&lt;p&gt;"');
    expect(svg).not.toContain('class="a&b');
  });

  it('parses back to a single element with the attributes intact', () => {
    const host = document.createElement('div');
    host.innerHTML = iconSvg('arrow-up', { class: 'a&b' });
    const svg = host.firstElementChild;
    expect(svg?.tagName.toLowerCase()).toBe('svg');
    expect(svg?.getAttribute('class')).toBe('a&b');
  });
});

describe('iconEl()', () => {
  it('builds a live svg element without innerHTML', () => {
    const el = iconEl('arrow-up', { size: 20, class: 'a&b' });
    expect(el.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(el.getAttribute('width')).toBe('20');
    expect(el.getAttribute('class')).toBe('a&b');
    expect(el.childElementCount).toBeGreaterThan(0);
  });

  it('yields an empty svg for an unknown name', () => {
    const el = iconEl('definitely-not-an-icon');
    expect(el.childElementCount).toBe(0);
  });
});
