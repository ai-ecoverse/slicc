import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PDF_DPI,
  dpiToScale,
  getPdfPageCount,
  isPdfBytes,
  renderPdfPage,
  renderPdfPageRange,
  resolveScale,
} from '../../../src/shell/supplemental-commands/pdf-raster.js';

// Shared, per-test-configurable stand-in for the pdf.js document unpdf
// resolves. Lets the render tests drive page counts and page geometry without
// shipping binary PDF fixtures or a real canvas.
const doc = vi.hoisted(() => ({
  numPages: 3,
  /** Page size in PDF user space (612x792 = US Letter portrait). */
  pageSize: { width: 612, height: 792 },
  renderCalls: [] as Array<{ width: number; height: number }>,
  destroyed: 0,
  cleaned: 0,
  initParams: null as Record<string, unknown> | null,
  /** Test hook so ordering assertions can observe the render call itself. */
  onRender: null as (() => void) | null,
}));

vi.mock('unpdf', () => ({
  getDocumentProxy: async (_data: Uint8Array, options: Record<string, unknown>) => {
    doc.initParams = options;
    return {
      get numPages() {
        return doc.numPages;
      },
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: doc.pageSize.width * scale,
          height: doc.pageSize.height * scale,
        }),
        render: ({ viewport }: { viewport: { width: number; height: number } }) => {
          doc.renderCalls.push({ width: viewport.width, height: viewport.height });
          doc.onRender?.();
          return { promise: Promise.resolve() };
        },
        cleanup: () => {
          doc.cleaned++;
        },
      }),
      destroy: async () => {
        doc.destroyed++;
      },
    };
  },
}));

/** Minimal OffscreenCanvas good enough for the rasterizer's use of it. */
class FakeOffscreenCanvas {
  static blobs: Array<{ type: string; quality?: number }> = [];
  width: number;
  height: number;
  fills: Array<[number, number, number, number]> = [];
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      canvas: this,
      fillStyle: '',
      fillRect: (x: number, y: number, w: number, h: number) => {
        this.fills.push([x, y, w, h]);
      },
    };
  }
  convertToBlob(options: { type: string; quality?: number }) {
    FakeOffscreenCanvas.blobs.push(options);
    return Promise.resolve({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('isPdfBytes', () => {
  it('accepts a document starting with the PDF header', () => {
    expect(isPdfBytes(utf8('%PDF-1.7\n...'))).toBe(true);
  });

  it('accepts a header preceded by junk, as pdf.js does', () => {
    expect(isPdfBytes(utf8('\n\n   garbage %PDF-1.4'))).toBe(true);
  });

  it('rejects a PNG', () => {
    expect(isPdfBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      false
    );
  });

  it('rejects an empty buffer', () => {
    expect(isPdfBytes(new Uint8Array())).toBe(false);
  });

  it('rejects a header past the 1KB scan window', () => {
    const bytes = new Uint8Array(2048);
    bytes.set(utf8('%PDF-1.7'), 1100);
    expect(isPdfBytes(bytes)).toBe(false);
  });

  it('does not match a truncated header split across the window edge', () => {
    expect(isPdfBytes(utf8('%PDF'))).toBe(false);
  });
});

describe('dpiToScale', () => {
  it('maps 72 DPI to 1:1 with PDF user space', () => {
    expect(dpiToScale(72)).toBe(1);
  });

  it('maps the poppler default to just over 2x', () => {
    expect(dpiToScale(DEFAULT_PDF_DPI)).toBeCloseTo(2.0833, 4);
  });
});

describe('resolveScale', () => {
  it('defaults to 1', () => {
    expect(resolveScale(612, 792, {})).toBe(1);
  });

  it('honours an explicit scale', () => {
    expect(resolveScale(612, 792, { scale: 3 })).toBe(3);
  });

  it('fits an explicit width', () => {
    expect(resolveScale(612, 792, { width: 1224 })).toBe(2);
  });

  it('fits an explicit height', () => {
    expect(resolveScale(612, 792, { height: 396 })).toBe(0.5);
  });

  it('fits the long edge of a portrait page by height', () => {
    expect(resolveScale(612, 792, { longEdge: 1584 })).toBe(2);
  });

  it('fits the long edge of a landscape page by width', () => {
    expect(resolveScale(792, 612, { longEdge: 1584 })).toBe(2);
  });

  it('prefers width over height and long edge', () => {
    expect(resolveScale(612, 792, { width: 612, height: 100, longEdge: 100 })).toBe(1);
  });
});

describe('rasterization runtime guard', () => {
  const original = Reflect.get(globalThis, 'OffscreenCanvas');

  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
    else Reflect.set(globalThis, 'OffscreenCanvas', original);
  });

  it('reports a clear error when OffscreenCanvas is unavailable', async () => {
    Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
    await expect(renderPdfPage(utf8('%PDF-1.7'), 1)).rejects.toThrow(
      /requires OffscreenCanvas, unavailable in this runtime/
    );
    await expect(renderPdfPageRange(utf8('%PDF-1.7'))).rejects.toThrow(
      /requires OffscreenCanvas, unavailable in this runtime/
    );
  });
});

describe('renderPdfPage', () => {
  beforeEach(() => {
    doc.numPages = 3;
    doc.pageSize = { width: 612, height: 792 };
    doc.renderCalls = [];
    doc.destroyed = 0;
    doc.cleaned = 0;
    doc.initParams = null;
    FakeOffscreenCanvas.blobs = [];
    Reflect.set(globalThis, 'OffscreenCanvas', FakeOffscreenCanvas);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  });

  const pdf = () => new TextEncoder().encode('%PDF-1.7');

  it('renders at the requested scale and returns the encoded bytes', async () => {
    const page = await renderPdfPage(pdf(), 1, { scale: 2 });
    expect(doc.renderCalls).toEqual([{ width: 1224, height: 1584 }]);
    expect(page).toMatchObject({ pageNumber: 1, width: 1224, height: 1584 });
    expect(Array.from(page.bytes)).toEqual([1, 2, 3]);
  });

  it('passes an OffscreenCanvas-backed factory to pdf.js', async () => {
    await renderPdfPage(pdf(), 1);
    expect(doc.initParams?.CanvasFactory).toBeTypeOf('function');
  });

  it('encodes PNG by default', async () => {
    await renderPdfPage(pdf(), 1);
    expect(FakeOffscreenCanvas.blobs).toEqual([{ type: 'image/png' }]);
  });

  it('encodes JPEG with the quality mapped to the 0-1 canvas range', async () => {
    await renderPdfPage(pdf(), 1, { format: 'jpeg', quality: 80 });
    expect(FakeOffscreenCanvas.blobs).toEqual([{ type: 'image/jpeg', quality: 0.8 }]);
  });

  it('defaults JPEG quality to 90', async () => {
    await renderPdfPage(pdf(), 1, { format: 'jpeg' });
    expect(FakeOffscreenCanvas.blobs).toEqual([{ type: 'image/jpeg', quality: 0.9 }]);
  });

  it('clamps an out-of-range JPEG quality into the canvas range', async () => {
    await renderPdfPage(pdf(), 1, { format: 'jpeg', quality: 400 });
    expect(FakeOffscreenCanvas.blobs).toEqual([{ type: 'image/jpeg', quality: 1 }]);
  });

  it('rejects a page number past the end', async () => {
    await expect(renderPdfPage(pdf(), 4)).rejects.toThrow('page 4 out of range (1-3)');
  });

  it('rejects a page number below 1', async () => {
    await expect(renderPdfPage(pdf(), 0)).rejects.toThrow('page 0 out of range (1-3)');
  });

  it('rejects a non-finite scale rather than allocating a huge canvas', async () => {
    await expect(renderPdfPage(pdf(), 1, { scale: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /invalid render scale/
    );
  });

  it('rejects a zero scale', async () => {
    await expect(renderPdfPage(pdf(), 1, { scale: 0 })).rejects.toThrow(/invalid render scale/);
  });

  it('destroys the document proxy even when rendering fails', async () => {
    await expect(renderPdfPage(pdf(), 99)).rejects.toThrow();
    expect(doc.destroyed).toBe(1);
  });

  it('releases the page and canvas after a successful render', async () => {
    await renderPdfPage(pdf(), 1);
    expect(doc.cleaned).toBe(1);
    expect(doc.destroyed).toBe(1);
  });
});

describe('JPEG transparency backdrop', () => {
  beforeEach(() => {
    doc.numPages = 1;
    doc.renderCalls = [];
    FakeOffscreenCanvas.blobs = [];
    Reflect.set(globalThis, 'OffscreenCanvas', FakeOffscreenCanvas);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  });

  it('fills white before rendering JPEG, so transparent pages are not black', async () => {
    // The fill has to happen before page.render, or it would paint over the page.
    const order: string[] = [];
    class OrderedCanvas extends FakeOffscreenCanvas {
      getContext() {
        return {
          canvas: this,
          fillStyle: '',
          fillRect: () => order.push('fill'),
        };
      }
    }
    Reflect.set(globalThis, 'OffscreenCanvas', OrderedCanvas);
    doc.onRender = () => order.push('render');
    try {
      await renderPdfPage(new TextEncoder().encode('%PDF-1.7'), 1, { format: 'jpeg' });
    } finally {
      doc.onRender = null;
    }
    expect(order).toEqual(['fill', 'render']);
  });

  it('fills the full canvas, not a fixed rect', async () => {
    const canvases: FakeOffscreenCanvas[] = [];
    class TrackingCanvas extends FakeOffscreenCanvas {
      constructor(width: number, height: number) {
        super(width, height);
        canvases.push(this);
      }
    }
    Reflect.set(globalThis, 'OffscreenCanvas', TrackingCanvas);
    await renderPdfPage(new TextEncoder().encode('%PDF-1.7'), 1, { format: 'jpeg', scale: 2 });
    expect(canvases[0].fills).toEqual([[0, 0, 1224, 1584]]);
  });

  it('does not fill a backdrop for PNG, preserving transparency', async () => {
    const canvases: FakeOffscreenCanvas[] = [];
    class TrackingCanvas extends FakeOffscreenCanvas {
      constructor(width: number, height: number) {
        super(width, height);
        canvases.push(this);
      }
    }
    Reflect.set(globalThis, 'OffscreenCanvas', TrackingCanvas);
    await renderPdfPage(new TextEncoder().encode('%PDF-1.7'), 1, { format: 'png' });
    expect(canvases[0].fills).toEqual([]);
  });
});

describe('renderPdfPageRange', () => {
  beforeEach(() => {
    doc.numPages = 5;
    doc.pageSize = { width: 612, height: 792 };
    doc.renderCalls = [];
    doc.destroyed = 0;
    FakeOffscreenCanvas.blobs = [];
    Reflect.set(globalThis, 'OffscreenCanvas', FakeOffscreenCanvas);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  });

  const pdf = () => new TextEncoder().encode('%PDF-1.7');

  it('renders every page by default and reports the total', async () => {
    const { pages, totalPages } = await renderPdfPageRange(pdf());
    expect(totalPages).toBe(5);
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses the document once for the whole range', async () => {
    await renderPdfPageRange(pdf());
    expect(doc.destroyed).toBe(1);
  });

  it('honours first and last page bounds', async () => {
    const { pages } = await renderPdfPageRange(pdf(), { firstPage: 2, lastPage: 4 });
    expect(pages.map((page) => page.pageNumber)).toEqual([2, 3, 4]);
  });

  it('clamps a last page past the end rather than erroring', async () => {
    const { pages } = await renderPdfPageRange(pdf(), { lastPage: 99 });
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('errors on a first page past the end', async () => {
    await expect(renderPdfPageRange(pdf(), { firstPage: 9 })).rejects.toThrow(
      'page 9 out of range (1-5)'
    );
  });

  it('resolves the long edge per page, so mixed orientations both fit', async () => {
    const { pages } = await renderPdfPageRange(pdf(), { firstPage: 1, lastPage: 1, longEdge: 792 });
    expect(pages[0]).toMatchObject({ width: 612, height: 792 });
  });
});

describe('getPdfPageCount', () => {
  beforeEach(() => {
    doc.numPages = 7;
    doc.destroyed = 0;
  });

  it('returns the page count without needing a canvas', async () => {
    Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
    await expect(getPdfPageCount(new TextEncoder().encode('%PDF-1.7'))).resolves.toBe(7);
  });

  it('destroys the document proxy it opened', async () => {
    await getPdfPageCount(new TextEncoder().encode('%PDF-1.7'));
    expect(doc.destroyed).toBe(1);
  });
});
