/**
 * PDF text extraction shared by `pdftotext` and `pdftk dump_data_utf8`.
 *
 * Sits next to `pdf-raster.ts` (the rendering half) and wraps the pdf.js build
 * `unpdf` bundles. We go through `extractTextItems` rather than `extractText`
 * for both modes: pdf.js emits one item per text run, and the inter-run space
 * is usually implied by the run's position rather than present in its string,
 * so a plain join glues words together ("TotalDue" for "Total  Due"). Working
 * from the positioned items lets us re-insert those spaces — and lets
 * `-layout` rebuild columns, which a joined string can no longer recover.
 */

import type { StructuredTextItem } from 'unpdf';

/** How a page's positioned text items are flattened back into a string. */
export type PdfTextMode =
  /** Content-stream order with gap-inferred spaces (poppler's default and `-raw`). */
  | 'reading'
  /** Preserve the on-page column layout by padding with spaces (poppler's `-layout`). */
  | 'layout';

export interface PdfTextOptions {
  mode?: PdfTextMode;
  /** 1-based first page to extract. Defaults to 1. */
  firstPage?: number;
  /** 1-based last page to extract. Clamped to the page count. Defaults to the last page. */
  lastPage?: number;
}

export interface PdfTextResult {
  /** Extracted text, one entry per page in the requested range. */
  pages: string[];
  /** Page count of the whole document, not of the requested range. */
  totalPages: number;
  /** 1-based number of `pages[0]`, after clamping. */
  firstPage: number;
}

let unpdfPromise: Promise<typeof import('unpdf')> | null = null;

async function getUnpdf() {
  if (!unpdfPromise) {
    unpdfPromise = import('unpdf');
  }
  return unpdfPromise;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * pdf.js reports a run's advance width but not the whitespace that separates
 * it from the next run. Treat a horizontal gap wider than a fifth of the font
 * size as a space — the same order of magnitude poppler uses, and small enough
 * to catch the tight inter-column gaps of a justified line.
 */
function needsSpace(previous: StructuredTextItem, item: StructuredTextItem): boolean {
  if (previous.str.endsWith(' ') || item.str.startsWith(' ')) return false;
  const gap = item.x - (previous.x + previous.width);
  return gap > Math.max(previous.fontSize, item.fontSize) * 0.2;
}

/** Content-order flattening: newline on `hasEOL`, space on a wide gap. */
export function renderReadingOrder(items: StructuredTextItem[]): string {
  let out = '';
  let previous: StructuredTextItem | undefined;
  for (const item of items) {
    if (item.str === '') continue;
    if (previous) {
      if (previous.hasEOL) out += '\n';
      else if (needsSpace(previous, item)) out += ' ';
    }
    out += item.str;
    previous = item;
  }
  return out;
}

/**
 * Widest line `renderLayout` will pad to. Bogus transformation matrices (and
 * fonts whose reported advance width is near zero) otherwise ask for a line
 * megabytes wide, which is neither useful nor survivable in the kernel worker.
 */
const MAX_LAYOUT_COLUMNS = 2000;

interface LayoutLine {
  y: number;
  items: StructuredTextItem[];
}

/** Cluster items into visual lines by baseline, tallest-first down the page. */
function groupIntoLines(items: StructuredTextItem[], tolerance: number): LayoutLine[] {
  const lines: LayoutLine[] = [];
  for (const item of items) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  // PDF user space grows upward, so descending y is top-to-bottom.
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function layoutLine(line: LayoutLine, originX: number, unit: number): string {
  let out = '';
  for (const item of line.items) {
    const column = Math.min(Math.round((item.x - originX) / unit), MAX_LAYOUT_COLUMNS);
    // Never overwrite text that is already placed: on collision fall back to a
    // single separating space, which is what poppler does for overlapping runs.
    if (column > out.length) out = out.padEnd(column, ' ');
    else if (out.length > 0 && !out.endsWith(' ')) out += ' ';
    out += item.str;
  }
  return out.trimEnd();
}

/**
 * Rebuild the page's column layout by padding with spaces, approximating
 * poppler's `-layout`. Real poppler works from glyph metrics; we only have
 * per-run boxes, so column positions are derived from the median character
 * advance across the page. Proportional text lands within a character or two
 * of its true column — enough to keep a table's columns apart, which is what
 * `-layout` is reached for.
 */
export function renderLayout(items: StructuredTextItem[]): string {
  const printable = items.filter((item) => item.str.trim() !== '');
  if (printable.length === 0) return '';

  const unit = median(
    printable.filter((item) => item.width > 0).map((item) => item.width / item.str.length)
  );
  if (!(unit > 0)) return renderReadingOrder(items);

  const originX = Math.min(...printable.map((item) => item.x));
  const tolerance = Math.max(median(printable.map((item) => item.height)) * 0.5, 1);
  return groupIntoLines(printable, tolerance)
    .map((line) => layoutLine(line, originX, unit))
    .join('\n');
}

/** Clamp a 1-based, possibly-undefined page range onto a document's page count. */
export function clampPageRange(
  totalPages: number,
  firstPage: number | undefined,
  lastPage: number | undefined
): { firstPage: number; lastPage: number } {
  const first = Math.max(1, Math.min(firstPage ?? 1, totalPages));
  const last = Math.max(first, Math.min(lastPage ?? totalPages, totalPages));
  return { firstPage: first, lastPage: last };
}

/** Extract per-page text from PDF bytes. */
export async function extractPdfText(
  data: Uint8Array,
  options: PdfTextOptions = {}
): Promise<PdfTextResult> {
  const unpdf = await getUnpdf();
  // pdf.js detaches the buffer it is handed and the VFS read buffer is reused
  // across calls, so hand it a private copy (same reason as `pdf-raster.ts`).
  const owned = new Uint8Array(data.byteLength);
  owned.set(data);

  const { totalPages, items } = await unpdf.extractTextItems(owned);
  const range = clampPageRange(totalPages, options.firstPage, options.lastPage);
  const render = options.mode === 'layout' ? renderLayout : renderReadingOrder;

  return {
    pages: items.slice(range.firstPage - 1, range.lastPage).map(render),
    totalPages,
    firstPage: range.firstPage,
  };
}
