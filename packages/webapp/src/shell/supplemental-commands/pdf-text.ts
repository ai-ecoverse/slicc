/**
 * PDF text extraction shared by `pdftotext` and `pdftk dump_data_utf8`.
 *
 * Sits next to `pdf-raster.ts` (the rendering half) and wraps the pdf.js build
 * `unpdf` bundles. Both modes work from POSITIONED text runs rather than
 * unpdf's joined `extractText`: pdf.js emits one item per text run, and the
 * inter-run space is usually implied by the run's position rather than present
 * in its string, so a plain join glues words together ("TotalDue" for
 * "Total  Due"). The positions let us re-insert those spaces — and let
 * `-layout` rebuild columns, which a joined string can no longer recover.
 *
 * The document proxy is driven directly rather than through unpdf's
 * `extractTextItems` helper, which only ever runs the WHOLE document and
 * retains every page's runs: a narrow `-f`/`-l` range would otherwise still
 * build the lot inside the kernel worker.
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
  /** 1-based first page to extract. Defaults to 1; past the end is an error. */
  firstPage?: number;
  /** 1-based last page to extract. Clamped to the page count. Defaults to the last page. */
  lastPage?: number;
}

export interface PdfTextResult {
  /** Extracted text, one entry per page in the requested range. */
  pages: string[];
  /** Page count of the whole document, not of the requested range. */
  totalPages: number;
  /** 1-based number of `pages[0]`. */
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
  // pdf.js often reports a line break as its own empty `{ str: '', hasEOL:
  // true }` run. Skipping empty runs outright would throw that break away and
  // silently join the two lines, so the signal is carried forward instead of
  // letting the marker become `previous` (its zero width would also defeat the
  // gap test for the next run).
  let pendingLineBreak = false;
  for (const item of items) {
    if (item.str === '') {
      pendingLineBreak ||= item.hasEOL;
      continue;
    }
    if (previous) {
      if (pendingLineBreak || previous.hasEOL) out += '\n';
      else if (needsSpace(previous, item)) out += ' ';
    }
    pendingLineBreak = false;
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

/**
 * Cluster items into visual lines by baseline, top-to-bottom.
 *
 * Sort first and sweep, rather than scanning the open lines per item: a
 * `find` per run is quadratic in run count, and a page dense enough to matter
 * would hang the kernel worker rather than fail in a bounded way.
 */
function groupIntoLines(items: StructuredTextItem[], tolerance: number): LayoutLine[] {
  // PDF user space grows upward, so descending y is top-to-bottom.
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines: LayoutLine[] = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - item.y) <= tolerance) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
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

/**
 * Clamp a 1-based, possibly-undefined page range onto a document's page count.
 *
 * Only the LAST page is clamped in practice — `extractPdfText` rejects a first
 * page past the end before calling this, the same split `renderPdfPageRange`
 * makes: silently handing back the final page is not what `-f 99` asked for.
 */
export function clampPageRange(
  totalPages: number,
  firstPage: number | undefined,
  lastPage: number | undefined
): { firstPage: number; lastPage: number } {
  const first = Math.max(1, Math.min(firstPage ?? 1, totalPages));
  const last = Math.max(first, Math.min(lastPage ?? totalPages, totalPages));
  return { firstPage: first, lastPage: last };
}

/** The pdf.js text run shape, before it is mapped onto `StructuredTextItem`. */
interface PdfJsTextItem {
  str?: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  dir?: string;
  hasEOL?: boolean;
}

/**
 * Map a page's raw pdf.js text content onto positioned items.
 *
 * Same projection `unpdf`'s `extractTextItems` performs; we do it here because
 * that helper only ever runs the WHOLE document (`Promise.all` over every
 * page, every page's items retained), so `-f 1 -l 1` on a thousand-page scan
 * would still build the lot in the kernel worker.
 */
function toStructuredItems(content: {
  items: unknown[];
  styles?: Record<string, { fontFamily?: string }>;
}): StructuredTextItem[] {
  const items: StructuredTextItem[] = [];
  for (const raw of content.items) {
    const item = raw as PdfJsTextItem;
    // Marked-content entries carry no `str` and are not text.
    if (item.str == null) continue;
    const [, , c, d, e, f] = item.transform;
    items.push({
      str: item.str,
      x: e,
      y: f,
      width: item.width,
      height: item.height,
      fontSize: Math.hypot(c, d),
      fontFamily: (item.fontName && content.styles?.[item.fontName]?.fontFamily) || '',
      dir: item.dir ?? 'ltr',
      hasEOL: item.hasEOL ?? false,
    });
  }
  return items;
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

  const pdf = await unpdf.getDocumentProxy(owned);
  try {
    const totalPages = pdf.numPages;
    if (options.firstPage !== undefined && options.firstPage > totalPages) {
      throw new Error(
        `first page ${options.firstPage} is past the end of the document (${totalPages} pages)`
      );
    }
    const range = clampPageRange(totalPages, options.firstPage, options.lastPage);
    const render = options.mode === 'layout' ? renderLayout : renderReadingOrder;

    // Sequential, releasing each page as we go: a wide range on a large scan
    // otherwise holds every page's runs at once, and this runs in the kernel
    // worker (same reason `pdf-raster.ts` streams its pages out).
    const pages: string[] = [];
    for (let pageNumber = range.firstPage; pageNumber <= range.lastPage; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(render(toStructuredItems(content)));
      page.cleanup?.();
    }

    return { pages, totalPages, firstPage: range.firstPage };
  } finally {
    // pdf.js tears the document down through its loading task, which also
    // terminates the backing worker (`PDFDocumentProxy.destroy()` is gone).
    await pdf.loadingTask.destroy();
  }
}
