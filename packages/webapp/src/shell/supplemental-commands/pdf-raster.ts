export const DEFAULT_PDF_DPI = 150;

export const IMAGEMAGICK_DEFAULT_DPI = 72;

export function dpiToScale(dpi: number): number {
  return dpi / 72;
}

export type RasterFormat = 'png' | 'jpeg';

export interface RasterOptions {
  scale?: number;

  width?: number;

  height?: number;

  longEdge?: number;
  format?: RasterFormat;

  quality?: number;
}

export interface RasterizedPage {
  pageNumber: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 1024));
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d];
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
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('PDF rasterization requires OffscreenCanvas, unavailable in this runtime');
  }
}

async function withDocument<T>(
  data: Uint8Array,
  callback: (pdf: Awaited<ReturnType<typeof import('unpdf')['getDocumentProxy']>>) => Promise<T>
): Promise<T> {
  const unpdf = await getUnpdf();

  const owned = new Uint8Array(data.byteLength);
  owned.set(data);
  const pdf = await unpdf.getDocumentProxy(owned, {
    CanvasFactory: OffscreenCanvasFactory,
  } as unknown as Parameters<typeof unpdf.getDocumentProxy>[1]);
  try {
    return await callback(pdf);
  } finally {
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

export async function renderPdfPage(
  data: Uint8Array,
  pageNumber: number,
  options: RasterOptions = {}
): Promise<RasterizedPage> {
  requireOffscreenCanvas();
  return withDocument(data, (pdf) => renderOne(pdf, pageNumber, options));
}

export interface RasterRangeOptions extends RasterOptions {
  firstPage?: number;

  lastPage?: number;
}

export interface RasterRange {
  firstPage: number;
  lastPage: number;
  totalPages: number;
}

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
