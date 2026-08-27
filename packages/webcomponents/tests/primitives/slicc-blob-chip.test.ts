import { beforeEach, describe, expect, it } from 'vitest';
import { SliccBlobChip } from '../../src/primitives/slicc-blob-chip.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function makeChip(): SliccBlobChip {
  return document.createElement('slicc-blob-chip') as SliccBlobChip;
}

describe('slicc-blob-chip', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-blob-chip')).toBe(SliccBlobChip);
  });

  it('renders a button with the chip/icon/label parts', () => {
    const el = makeChip();
    el.label = 'png · 12 KB';
    document.body.appendChild(el);

    const button = el.shadowRoot?.querySelector('button');
    expect(button?.getAttribute('part')).toBe('chip');
    // A real button, so keyboard activation and the role come from the
    // platform rather than from an ARIA attribute we would have to maintain.
    expect(button?.type).toBe('button');
    expect(el.shadowRoot?.querySelector('svg')?.getAttribute('part')).toBe('icon');
    const label = el.shadowRoot?.querySelector('.label');
    expect(label?.getAttribute('part')).toBe('label');
    expect(label?.textContent).toBe('png · 12 KB');
  });

  it('reflects the label attribute <-> property', () => {
    const el = makeChip();
    document.body.appendChild(el);
    el.setAttribute('label', 'pdf · 148 KB');
    expect(el.label).toBe('pdf · 148 KB');
    el.label = 'zip · 2 MB';
    expect(el.getAttribute('label')).toBe('zip · 2 MB');
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('zip · 2 MB');
  });

  it('defaults to the file icon and honours an explicit one', () => {
    const el = makeChip();
    document.body.appendChild(el);
    expect(el.icon).toBe('file');
    el.icon = 'image';
    expect(el.getAttribute('icon')).toBe('image');
    expect(el.shadowRoot?.querySelector('svg')).not.toBeNull();
  });

  it('escapes its label rather than parsing it as markup', () => {
    const el = makeChip();
    el.label = '<img src=x onerror=alert(1)>';
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('img')).toBeNull();
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe(
      '<img src=x onerror=alert(1)>'
    );
  });

  it('retargets an inner click to the host so one listener catches both input modes', () => {
    const el = makeChip();
    el.label = 'png · 12 KB';
    document.body.appendChild(el);

    let seen = 0;
    el.addEventListener('click', () => {
      seen += 1;
    });
    el.shadowRoot?.querySelector('button')?.click();
    expect(seen).toBe(1);
  });

  it('renders icon-only when it has no label', () => {
    const el = makeChip();
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('');
    expect(el.shadowRoot?.querySelector('svg')).not.toBeNull();
  });
});
