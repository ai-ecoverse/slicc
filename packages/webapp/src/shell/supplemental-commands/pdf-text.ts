import type { StructuredTextItem } from 'unpdf';

export type PdfTextMode = 'reading' | 'layout';

export interface PdfTextOptions {
  mode?: PdfTextMode;

  firstPage?: number;

  lastPage?: number;
}

export interface PdfTextResult {
  pages: string[];

  totalPages: number;

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

function needsSpace(previous: StructuredTextItem, item: StructuredTextItem): boolean {
  if (previous.str.endsWith(' ') || item.str.startsWith(' ')) return false;
  const gap = item.x - (previous.x + previous.width);
  return gap > Math.max(previous.fontSize, item.fontSize) * 0.2;
}

export function renderReadingOrder(items: StructuredTextItem[]): string {
  let out = '';
  let previous: StructuredTextItem | undefined;

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

const MAX_LAYOUT_COLUMNS = 2000;

interface LayoutLine {
  y: number;
  items: StructuredTextItem[];
}

function groupIntoLines(items: StructuredTextItem[], tolerance: number): LayoutLine[] {
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

    if (column > out.length) out = out.padEnd(column, ' ');
    else if (out.length > 0 && !out.endsWith(' ')) out += ' ';
    out += item.str;
  }
  return out.trimEnd();
}

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

export function clampPageRange(
  totalPages: number,
  firstPage: number | undefined,
  lastPage: number | undefined
): { firstPage: number; lastPage: number } {
  const first = Math.max(1, Math.min(firstPage ?? 1, totalPages));
  const last = Math.max(first, Math.min(lastPage ?? totalPages, totalPages));
  return { firstPage: first, lastPage: last };
}

interface PdfJsTextItem {
  str?: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  dir?: string;
  hasEOL?: boolean;
}

function toStructuredItems(content: {
  items: unknown[];
  styles?: Record<string, { fontFamily?: string }>;
}): StructuredTextItem[] {
  const items: StructuredTextItem[] = [];
  for (const raw of content.items) {
    const item = raw as PdfJsTextItem;

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

export async function extractPdfText(
  data: Uint8Array,
  options: PdfTextOptions = {}
): Promise<PdfTextResult> {
  const unpdf = await getUnpdf();

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

    const pages: string[] = [];
    for (let pageNumber = range.firstPage; pageNumber <= range.lastPage; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(render(toStructuredItems(content)));
      page.cleanup?.();
    }

    return { pages, totalPages, firstPage: range.firstPage };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
