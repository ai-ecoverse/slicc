import type { StructuredTextItem } from 'unpdf';
import { describe, expect, it } from 'vitest';
import {
  clampPageRange,
  extractPdfText,
  renderLayout,
  renderReadingOrder,
} from '../../../src/shell/supplemental-commands/pdf-text.js';
import { tinyPdfBytes } from '../helpers/pdf-fixtures.js';

/** Build a pdf.js-shaped text item; `width` defaults to a 5pt-per-char run. */
function item(str: string, overrides: Partial<StructuredTextItem> = {}): StructuredTextItem {
  return {
    str,
    x: 0,
    y: 0,
    width: str.length * 5,
    height: 10,
    fontSize: 10,
    fontFamily: 'Helvetica',
    dir: 'ltr',
    hasEOL: false,
    ...overrides,
  };
}

describe('renderReadingOrder', () => {
  it('inserts a space when two runs are visibly apart', () => {
    const first = item('Total', { x: 0 });
    const second = item('Due', { x: first.width + 8 });
    expect(renderReadingOrder([first, second])).toBe('Total Due');
  });

  it('leaves adjacent runs glued together', () => {
    const first = item('sub', { x: 0 });
    const second = item('total', { x: first.width });
    expect(renderReadingOrder([first, second])).toBe('subtotal');
  });

  it('does not double a space either run already carries', () => {
    const first = item('Total ', { x: 0 });
    const second = item('Due', { x: 100 });
    expect(renderReadingOrder([first, second])).toBe('Total Due');
  });

  it('breaks the line on hasEOL', () => {
    expect(renderReadingOrder([item('one', { hasEOL: true }), item('two', { x: 200 })])).toBe(
      'one\ntwo'
    );
  });

  it('skips empty runs', () => {
    expect(renderReadingOrder([item(''), item('kept')])).toBe('kept');
  });

  it('keeps the line break an empty run carries', () => {
    // pdf.js often reports a break as its own `{ str: '', hasEOL: true }` run.
    // Dropping it glued the two lines together.
    const rendered = renderReadingOrder([
      item('line one', { x: 0 }),
      item('', { hasEOL: true, width: 0, x: 40 }),
      item('line two', { x: 0 }),
    ]);
    expect(rendered).toBe('line one\nline two');
  });

  it('does not let an empty run defeat the gap test for the next run', () => {
    // The marker's zero width must not become `previous`, or the space
    // between two visibly separated runs disappears.
    const first = item('Total', { x: 0 });
    const rendered = renderReadingOrder([
      first,
      item('', { width: 0, x: 500 }),
      item('Due', { x: first.width + 8 }),
    ]);
    expect(rendered).toBe('Total Due');
  });
});

describe('renderLayout', () => {
  it('pads columns so a two-column row stays aligned', () => {
    // 5pt per character, so x=100 is column 20.
    const rendered = renderLayout([
      item('Item', { x: 0, y: 700 }),
      item('Price', { x: 100, y: 700 }),
      item('Widget', { x: 0, y: 680 }),
      item('9.99', { x: 100, y: 680 }),
    ]);
    expect(rendered).toBe(['Item                Price', 'Widget              9.99'].join('\n'));
  });

  it('orders lines top-to-bottom even when the items arrive out of order', () => {
    const rendered = renderLayout([
      item('bottom', { x: 0, y: 100 }),
      item('top', { x: 0, y: 700 }),
    ]);
    expect(rendered).toBe('top\nbottom');
  });

  it('clusters runs whose baselines differ by less than half a line', () => {
    const rendered = renderLayout([
      item('same', { x: 0, y: 700 }),
      item('line', { x: 50, y: 697 }),
    ]);
    expect(rendered.split('\n')).toHaveLength(1);
  });

  it('separates overlapping runs with a single space instead of overwriting', () => {
    const rendered = renderLayout([item('abc', { x: 0, y: 700 }), item('def', { x: 1, y: 700 })]);
    expect(rendered).toBe('abc def');
  });

  it('caps how far a bogus coordinate can pad a line', () => {
    const rendered = renderLayout([
      item('a', { x: 0, y: 700 }),
      item('b', { x: 10_000_000, y: 700 }),
    ]);
    expect(rendered.length).toBeLessThanOrEqual(2001);
  });

  it('falls back to reading order when no run reports a width', () => {
    const rendered = renderLayout([
      item('a', { x: 0, y: 700, width: 0 }),
      item('b', { x: 50, y: 700, width: 0 }),
    ]);
    expect(rendered).toBe('a b');
  });

  it('returns an empty string for a page with no printable text', () => {
    expect(renderLayout([item('   ')])).toBe('');
  });
});

describe('clampPageRange', () => {
  it('defaults to the whole document', () => {
    expect(clampPageRange(5, undefined, undefined)).toEqual({ firstPage: 1, lastPage: 5 });
  });

  it('clamps both ends into the document', () => {
    // The upper clamp on the first page is defensive only — `extractPdfText`
    // rejects a first page past the end before it gets here.
    expect(clampPageRange(3, 9, 99)).toEqual({ firstPage: 3, lastPage: 3 });
    expect(clampPageRange(3, 0, 2)).toEqual({ firstPage: 1, lastPage: 2 });
  });

  it('never returns a last page before the first', () => {
    expect(clampPageRange(5, 4, 2)).toEqual({ firstPage: 4, lastPage: 4 });
  });
});

describe('extractPdfText', () => {
  it('returns one entry per page of the requested range', async () => {
    const result = await extractPdfText(tinyPdfBytes(), { firstPage: 2 });
    expect(result.totalPages).toBe(2);
    expect(result.firstPage).toBe(2);
    expect(result.pages).toEqual(['PAGE TWO']);
  });

  it('rejects a first page past the end instead of handing back the last one', async () => {
    await expect(extractPdfText(tinyPdfBytes(), { firstPage: 99 })).rejects.toThrow(
      'first page 99 is past the end of the document (2 pages)'
    );
  });

  it('leaves the input buffer intact for a second read', async () => {
    const bytes = tinyPdfBytes();
    await extractPdfText(bytes);
    // pdf.js detaches whatever buffer it is handed; the copy inside
    // extractPdfText is what keeps the VFS read buffer usable afterwards.
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect((await extractPdfText(bytes)).pages).toEqual(['PAGE ONE', 'PAGE TWO']);
  });
});
