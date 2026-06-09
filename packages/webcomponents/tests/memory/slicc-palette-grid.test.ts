import { beforeEach, describe, expect, it } from 'vitest';
// Sibling composed by tag — importing it registers <slicc-palette-cell> so the
// grid's chips upgrade and render their shadow chrome during the test run.
import { SliccPaletteCell } from '../../src/memory/slicc-palette-cell.js';
import {
  DEFAULT_TOKENS,
  type PaletteToken,
  SliccPaletteGrid,
} from '../../src/memory/slicc-palette-grid.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** Mount a palette grid with the given attributes and return it. */
function mount(attrs: Record<string, string> = {}): SliccPaletteGrid {
  const el = document.createElement('slicc-palette-grid') as SliccPaletteGrid;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

/** The composed chip elements (by tag) inside the grid. */
function cells(el: SliccPaletteGrid): SliccPaletteCell[] {
  return Array.from(el.querySelectorAll<SliccPaletteCell>('slicc-palette-cell'));
}

describe('slicc-palette-grid', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-palette-grid')).toBe(SliccPaletteGrid);
  });

  it('renders into its own light DOM (no shadow root)', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('.palgrid')).not.toBeNull();
    expect(el.querySelector('h4')).not.toBeNull();
  });

  it('defaults the heading to the prototype copy', () => {
    const el = mount();
    expect(el.heading).toBe('brand palette · tokens');
    expect(el.querySelector('h4')?.textContent).toBe('brand palette · tokens');
  });

  it('reflects heading attribute ↔ property', () => {
    const el = mount();
    el.heading = 'extended palette';
    expect(el.getAttribute('heading')).toBe('extended palette');
    expect(el.querySelector('h4')?.textContent).toBe('extended palette');
    el.heading = null;
    expect(el.hasAttribute('heading')).toBe(false);
    // Falls back to the default copy once the attribute is removed.
    expect(el.querySelector('h4')?.textContent).toBe('brand palette · tokens');
  });

  it('renders the default brand tokens (canvas / cone / scoop×3 / ink) as cells', () => {
    const el = mount();
    const chips = cells(el);
    expect(chips).toHaveLength(DEFAULT_TOKENS.length);
    expect(chips.map((c) => c.getAttribute('color'))).toEqual(DEFAULT_TOKENS.map((t) => t.color));
    expect(chips.map((c) => c.getAttribute('label'))).toEqual(DEFAULT_TOKENS.map((t) => t.label));
  });

  it('composes <slicc-palette-cell> by tag, which renders its own shadow chrome', () => {
    const el = mount();
    const chip = cells(el)[0];
    // Upgraded sibling: shadow chrome with the prototype .ch swatch + .cl label.
    expect(chip).toBeInstanceOf(SliccPaletteCell);
    expect(chip.shadowRoot?.querySelector('.ch')).not.toBeNull();
    expect(chip.shadowRoot?.querySelector('.cl')?.textContent).toBe('canvas #faf6f1');
    // The swatch band carries the token color as its background.
    const ch = chip.shadowRoot?.querySelector<HTMLElement>('.ch');
    expect(ch?.style.background).toContain('rgb(250, 246, 241)');
  });

  it('reflects the tokens property and re-renders the grid', () => {
    const el = mount();
    const custom: PaletteToken[] = [
      { label: 'one #111111', color: '#111111' },
      { label: 'two #222222', color: '#222222' },
    ];
    el.tokens = custom;
    const chips = cells(el);
    expect(chips).toHaveLength(2);
    expect(chips[1].getAttribute('label')).toBe('two #222222');
    // The getter returns a defensive copy, not the same array reference.
    expect(el.tokens).toEqual(custom);
    expect(el.tokens).not.toBe(custom);
  });

  it('falls back to the default tokens when set to null', () => {
    const el = mount();
    el.tokens = [{ label: 'solo', color: '#abcdef' }];
    expect(cells(el)).toHaveLength(1);
    el.tokens = null;
    expect(cells(el)).toHaveLength(DEFAULT_TOKENS.length);
  });

  it('renders a single-token grid', () => {
    const el = mount();
    el.tokens = [{ label: 'cone #ef7000', color: '#ef7000' }];
    const chips = cells(el);
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('color')).toBe('#ef7000');
  });

  it('renders an arbitrary number of swatch cells', () => {
    const el = mount();
    const many: PaletteToken[] = Array.from({ length: 12 }, (_, i) => ({
      label: `t${i}`,
      color: `#${i.toString(16).repeat(6).slice(0, 6)}`,
    }));
    el.tokens = many;
    expect(cells(el)).toHaveLength(12);
  });

  it('renders potentially-hostile labels safely (cell escapes the caption)', () => {
    const el = mount();
    el.tokens = [{ label: '<img src=x onerror=1>', color: '#fff' }];
    const chip = cells(el)[0];
    expect(chip.getAttribute('label')).toBe('<img src=x onerror=1>');
    expect(chip.shadowRoot?.querySelector('.cl img')).toBeNull();
    expect(chip.shadowRoot?.querySelector('.cl')?.textContent).toBe('<img src=x onerror=1>');
  });

  it('relocates slotted children into the grid ahead of the token cells', () => {
    const el = document.createElement('slicc-palette-grid') as SliccPaletteGrid;
    const extra = document.createElement('div');
    extra.className = 'extra-chip';
    extra.textContent = 'custom chip';
    el.appendChild(extra);
    document.body.appendChild(el);
    const grid = el.querySelector('.palgrid');
    expect(grid?.firstElementChild).toBe(extra);
    // Token cells follow the relocated child.
    expect(grid?.querySelectorAll('slicc-palette-cell').length).toBe(DEFAULT_TOKENS.length);
  });

  it('relays the cell palette-select up as a grid select with { label, color }', () => {
    const el = mount();
    let detail: { label: string; color: string } | null = null;
    el.addEventListener('select', (e) => {
      detail = (e as CustomEvent).detail;
    });
    cells(el)[1].click();
    expect(detail).not.toBeNull();
    expect(detail!.color).toBe(DEFAULT_TOKENS[1].color);
    expect(detail!.label).toBe(DEFAULT_TOKENS[1].label);
  });

  it('relays select for keyboard activation of a cell (Enter / Space)', () => {
    const el = mount();
    let count = 0;
    el.addEventListener('select', () => {
      count += 1;
    });
    const chip = cells(el)[0];
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(count).toBe(2);
  });

  it('does not emit select for clicks outside a cell', () => {
    const el = mount();
    let count = 0;
    el.addEventListener('select', () => {
      count += 1;
    });
    el.querySelector('h4')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(count).toBe(0);
  });

  it('stops relaying after disconnect (listener cleanup)', () => {
    const el = mount();
    let count = 0;
    el.addEventListener('select', () => {
      count += 1;
    });
    cells(el)[0].click();
    expect(count).toBe(1);
    el.remove();
    cells(el)[0].click();
    expect(count).toBe(1);
  });

  it('applies the prototype panel chrome (scroll + padding) and grid layout', () => {
    const el = mount();
    const cs = getComputedStyle(el);
    expect(cs.display).toBe('block');
    expect(cs.overflowY).toBe('auto');
    expect(cs.paddingLeft).toBe('18px');
    expect(cs.paddingTop).toBe('18px');
    const grid = el.querySelector('.palgrid') as HTMLElement;
    const gcs = getComputedStyle(grid);
    expect(gcs.display).toBe('grid');
    expect(gcs.gap).toBe('10px');
  });

  it('reflows the auto-fill grid by width (more columns when wider)', () => {
    const el = mount();
    el.style.width = '120px';
    const narrowCols = getComputedStyle(
      el.querySelector('.palgrid') as HTMLElement
    ).gridTemplateColumns.split(' ').length;
    el.style.width = '600px';
    const wideCols = getComputedStyle(
      el.querySelector('.palgrid') as HTMLElement
    ).gridTemplateColumns.split(' ').length;
    expect(wideCols).toBeGreaterThan(narrowCols);
  });

  it('renders light vs dark chip swatches via the composed cell (dark dims the band)', () => {
    const el = mount();
    const ch = cells(el)[0].shadowRoot?.querySelector('.ch') as HTMLElement;
    // The cell owns its dark dimming (:host-context). Light = no filter.
    expect(getComputedStyle(ch).filter).toBe('none');
    setTheme('dark');
    const darkFilter = getComputedStyle(ch).filter;
    expect(darkFilter).not.toBe('none');
    expect(darkFilter).toContain('brightness(0.55)');
    expect(darkFilter).toContain('saturate(0.85)');
  });
});
