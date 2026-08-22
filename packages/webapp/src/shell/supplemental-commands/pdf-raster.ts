/**
 * PDF page rasterization shared by `pdftoppm` / `pdftocairo` and the
 * PDF-input path of `convert` / `magick`.
 *
 * Real ImageMagick and poppler both shell out to a native renderer
 * (Ghostscript / cairo) for this. We render with the pdf.js build that
 * `unpdf` already bundles for `pdftk dump_data_utf8`, drawing into an
 * `OffscreenCanvas` rather than `unpdf`'s `renderPageAsImage`:
 *
 * - `renderPageAsImage` picks `DOMCanvasFactory` off a `window` check, so it
 *   throws in the kernel worker where `AlmostBashShellHeadless` runs.
 * - It encodes via `canvas.toDataURL()`, which `OffscreenCanvas` does not
 *   implement, and only ever emits PNG. Going through `convertToBlob` gets
 *   JPEG (and its quality knob) for free instead of a PNG round-trip.
 */

/** poppler's `pdftoppm` default resolution. */
export const DEFAULT_PDF_DPI = 150;

/**
 * ImageMagick's default PDF rasterization density, which differs from
 * poppler's. Confirmed against the Ghostscript invocation real ImageMagick
 * builds for a PDF input: `-r72x72`. It is why `-density 150` is the standard
 * advice for a readable `convert doc.pdf out.png`.
 */
export const IMAGEMAGICK_DEFAULT_DPI = 72;

/** PDF user-space units are 1/72 inch, so DPI maps to a pdf.js scale directly. */
export function dpiToScale(dpi: number): number {
  return dpi / 72;
}

export type RasterFormat = 'png' | 'jpeg';

export interface RasterOptions {
  /** Render scale; ignored when `width` or `height` is set. Defaults to 1. */
  scale?: number;
  /** Fit the page to this pixel width (poppler's `-scale-to-x`). */
  width?: number;
  /** Fit the page to this pixel height (poppler's `-scale-to-y`). */
  height?: number;
  /**
   * Fit the page's long edge to this many pixels (poppler's `-scale-to`).
   * Resolved per page, since a document can mix portrait and landscape.
   */
  longEdge?: number;
  format?: RasterFormat;
  /** JPEG quality, 0-100. Ignored for PNG. */
  quality?: number;
}

export interface RasterizedPage {
  pageNumber: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * `%PDF-` header check. Some producers emit leading junk before the header,
 * which is why we scan a prefix window instead of only offset 0 — the same
 * tolerance pdf.js itself applies.
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 1024));
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let start = 0; start + header.length <= window.length; start++) {
    let matched = true;
    for (let i = 0; i < header.length; i++) {
      if (window[start + i] !== header[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * pdf.js `BaseCanvasFactory` implemented over `OffscreenCanvas`, so
 * rasterization works in the kernel worker and the extension offscreen
 * document as well as the hosted leader tab.
 */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.ceil(width)),
      Math.max(1, Math.ceil(height))
    );
    const context = canvas.getContext('2d');
    if (!context) throw new Error('failed to acquire 2d context for PDF rendering');
    return { canvas, context };
  }

  reset(canvasAndContext: { canvas: OffscreenCanvas | null }, width: number, height: number): void {
    if (!canvasAndContext.canvas) throw new Error('canvas is not specified');
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
  }

  destroy(canvasAndContext: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }): void {
    if (!canvasAndContext.canvas) return;
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

let unpdfPromise: Promise<typeof import('unpdf')> | null = null;

async function getUnpdf() {
  if (!unpdfPromise) {
    unpdfPromise = import('unpdf');
  }
  return unpdfPromise;
}

function requireOffscreenCanvas(): void {
  // Every cone-hosting float runs the shell in a browser DedicatedWorker, so
  // OffscreenCanvas is normally present. This guard is for bare-Node
  // embeddings and tests, where unpdf's Node path would need the optional
  // `@napi-rs/canvas` peer SLICC does not ship: fail with a clear message
  // rather than deep inside pdf.js, mirroring `v86-command.ts`'s screenshot
  // guard.
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('PDF rasterization requires OffscreenCanvas, unavailable in this runtime');
  }
}

/**
 * Load a PDF once and hand the proxy to `callback`. Callers rendering several
 * pages should go through this rather than `renderPdfPage` per page — parsing
 * dominates the cost for multi-page documents.
 */
async function withDocument<T>(
  data: Uint8Array,
  callback: (pdf: Awaited<ReturnType<typeof import('unpdf')['getDocumentProxy']>>) => Promise<T>
): Promise<T> {
  const unpdf = await getUnpdf();
  // pdf.js transfers/detaches the buffer it is handed. The VFS read buffer is
  // reused across calls, so give it a private copy.
  const owned = new Uint8Array(data.byteLength);
  owned.set(data);
  const pdf = await unpdf.getDocumentProxy(owned, {
    CanvasFactory: OffscreenCanvasFactory,
  } as unknown as Parameters<typeof unpdf.getDocumentProxy>[1]);
  try {
    return await callback(pdf);
  } finally {
    // pdf.js dropped `PDFDocumentProxy.destroy()` in favour of tearing the
    // document down through its loading task; that also terminates the backing
    // worker, which the proxy-level call never did on its own.
    await pdf.loadingTask.destroy();
  }
}

export async function getPdfPageCount(data: Uint8Array): Promise<number> {
  return withDocument(data, async (pdf) => pdf.numPages);
}

export function resolveScale(
  viewportWidth: number,
  viewportHeight: number,
  options: RasterOptions
): number {
  if (options.width) return options.width / viewportWidth;
  if (options.height) return options.height / viewportHeight;
  if (options.longEdge) return options.longEdge / Math.max(viewportWidth, viewportHeight);
  return options.scale ?? 1;
}

async function encodeCanvas(
  canvas: OffscreenCanvas,
  format: RasterFormat,
  quality: number | undefined
): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob(
    format === 'jpeg'
      ? { type: 'image/jpeg', quality: Math.min(1, Math.max(0, (quality ?? 90) / 100)) }
      : { type: 'image/png' }
  );
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderOne(
  pdf: Awaited<ReturnType<typeof import('unpdf')['getDocumentProxy']>>,
  pageNumber: number,
  options: RasterOptions
): Promise<RasterizedPage> {
  if (pageNumber < 1 || pageNumber > pdf.numPages) {
    throw new Error(`page ${pageNumber} out of range (1-${pdf.numPages})`);
  }
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = resolveScale(base.width, base.height, options);
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new Error(`invalid render scale: ${scale}`);
  }
  const viewport = page.getViewport({ scale });
  const factory = new OffscreenCanvasFactory();
  const { canvas, context } = factory.create(viewport.width, viewport.height);
  try {
    // JPEG has no alpha; without a white backdrop a transparent PDF page
    // encodes as black rather than paper.
    if ((options.format ?? 'png') === 'jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    } as unknown as Parameters<typeof page.render>[0]).promise;
    const bytes = await encodeCanvas(canvas, options.format ?? 'png', options.quality);
    return { pageNumber, bytes, width: canvas.width, height: canvas.height };
  } finally {
    page.cleanup?.();
    factory.destroy({ canvas, context });
  }
}

/** Rasterize a single 1-based page. */
export async function renderPdfPage(
  data: Uint8Array,
  pageNumber: number,
  options: RasterOptions = {}
): Promise<RasterizedPage> {
  requireOffscreenCanvas();
  return withDocument(data, (pdf) => renderOne(pdf, pageNumber, options));
}

export interface RasterRangeOptions extends RasterOptions {
  /** 1-based first page; defaults to 1. */
  firstPage?: number;
  /** 1-based last page; clamped to the page count, as poppler does. */
  lastPage?: number;
}

/** Range bounds, resolved against the real page count once the document opens. */
export interface RasterRange {
  firstPage: number;
  lastPage: number;
  totalPages: number;
}

/**
 * Rasterize a page range, parsing the document once and handing each page to
 * `onPage` as soon as it is encoded.
 *
 * Streaming rather than returning an array is load-bearing: a few hundred
 * pages of scanned A4 at 150 DPI is easily gigabytes of PNG, and accumulating
 * them would exhaust the kernel worker before anything reached the VFS. The
 * caller writes and drops each page, so only one is live at a time. `onPage`
 * also receives the resolved range, since output naming generally depends on
 * the last page number, which is not knowable until the document opens.
 *
 * Pages render sequentially: pdf.js serializes work per document anyway.
 *
 * `-l` past the end clamps rather than erroring (poppler's behaviour), but a
 * `-f` past the end is a real mistake and reports one.
 */
export async function renderPdfPageRange(
  data: Uint8Array,
  options: RasterRangeOptions = {},
  onPage?: (page: RasterizedPage, range: RasterRange) => Promise<void> | void
): Promise<RasterRange> {
  requireOffscreenCanvas();
  return withDocument(data, async (pdf) => {
    const totalPages = pdf.numPages;
    const firstPage = Math.max(1, options.firstPage ?? 1);
    const lastPage = Math.min(totalPages, options.lastPage ?? totalPages);
    if (firstPage > totalPages) {
      throw new Error(`page ${firstPage} out of range (1-${totalPages})`);
    }
    const range: RasterRange = { firstPage, lastPage, totalPages };
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
      await onPage?.(await renderOne(pdf, pageNumber, options), range);
    }
    return range;
  });
}
