import type { IFileSystem } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConvertCommand,
  splitSceneSelector,
} from '../../../src/shell/supplemental-commands/convert-command.js';
import * as magickWasm from '../../../src/shell/supplemental-commands/magick-wasm.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

// Stand in for the rasterizer. `pdf-raster.test.ts` covers the rendering side;
// these tests cover the seam — PDF detection, scene selection, `-density`, and
// the handoff of the rasterized bytes into ImageMagick.
const raster = vi.hoisted(() => ({
  calls: [] as Array<{ pageNumber: number; options: Record<string, unknown> }>,
  error: null as Error | null,
}));

/** A real 1x1 PNG, so magick-wasm has something valid to decode. */
const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (char) => char.charCodeAt(0)
);

vi.mock('../../../src/shell/supplemental-commands/pdf-raster.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/shell/supplemental-commands/pdf-raster.js')>();
  return {
    ...actual,
    renderPdfPage: async (
      _data: Uint8Array,
      pageNumber: number,
      options: Record<string, unknown> = {}
    ) => {
      raster.calls.push({ pageNumber, options });
      if (raster.error) throw raster.error;
      return { pageNumber, bytes: ONE_PIXEL_PNG, width: 1, height: 1 };
    },
  };
});

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ncontent');

/**
 * magick-wasm cannot initialize under Vitest (its loader only accepts
 * http/https), so stub it the way `convert-command.test.ts` does and record
 * the bytes `convert` hands it to decode.
 */
function installMagickMock(): { readBytes: Uint8Array[] } {
  const readBytes: Uint8Array[] = [];
  const image = {
    write: (_format: string, callback: (data: Uint8Array) => void) => {
      callback(new Uint8Array([9, 9, 9]));
    },
    resize: vi.fn(),
    thumbnail: vi.fn(),
    rotate: vi.fn(),
    quality: 0,
    backgroundColor: null,
  };
  vi.spyOn(magickWasm, 'getMagick').mockResolvedValue({
    ImageMagick: {
      read: async (bytes: Uint8Array, callback: (image: unknown) => Promise<void>) => {
        readBytes.push(new Uint8Array(bytes));
        await callback(image);
      },
    },
    MagickGeometry: class {
      constructor(readonly value: string) {}
    },
    MagickFormat: { JPEG: 'JPEG', PNG: 'PNG' },
    initializeImageMagick: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof magickWasm.getMagick>>);
  return { readBytes };
}

const ctxWith = (bytes: Uint8Array, overrides: Partial<IFileSystem> = {}) =>
  mockCommandContext({
    fs: {
      readFileBuffer: vi.fn().mockResolvedValue(bytes),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
    cwd: '/workspace',
  });

const run = (args: string[], ctx = ctxWith(PDF_BYTES)) => createConvertCommand().execute(args, ctx);

beforeEach(() => {
  raster.calls = [];
  raster.error = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('splitSceneSelector', () => {
  it('splits a bracketed scene index off the path', () => {
    expect(splitSceneSelector('doc.pdf[2]')).toEqual({ path: 'doc.pdf', scene: 2 });
  });

  it('reads scene 0', () => {
    expect(splitSceneSelector('doc.pdf[0]')).toEqual({ path: 'doc.pdf', scene: 0 });
  });

  it('leaves a plain path alone', () => {
    expect(splitSceneSelector('doc.pdf')).toEqual({ path: 'doc.pdf' });
  });

  it('leaves a non-numeric bracket suffix alone, so real filenames survive', () => {
    expect(splitSceneSelector('report[final].png')).toEqual({ path: 'report[final].png' });
  });

  it('leaves a negative index alone rather than reading it as a scene', () => {
    expect(splitSceneSelector('doc.pdf[-1]')).toEqual({ path: 'doc.pdf[-1]' });
  });

  it('handles a bracketed directory component in the path', () => {
    expect(splitSceneSelector('/a[1]/doc.pdf[3]')).toEqual({ path: '/a[1]/doc.pdf', scene: 3 });
  });
});

describe('convert with a PDF input', () => {
  it('rasterizes a PDF and writes the output image', async () => {
    installMagickMock();
    const ctx = ctxWith(PDF_BYTES);
    const result = await run(['doc.pdf', 'out.png'], ctx);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(ctx.fs.writeFile).mock.calls[0][0]).toBe('/workspace/out.png');
  });

  it('hands ImageMagick the rasterized page, not the raw PDF bytes', async () => {
    const { readBytes } = installMagickMock();
    await run(['doc.pdf', 'out.png']);
    expect(Array.from(readBytes[0])).toEqual(Array.from(ONE_PIXEL_PNG));
  });

  it('reads the PDF path with the scene selector stripped', async () => {
    const ctx = ctxWith(PDF_BYTES);
    await run(['doc.pdf[2]', 'out.png'], ctx);
    expect(vi.mocked(ctx.fs.readFileBuffer)).toHaveBeenCalledWith('/workspace/doc.pdf');
  });

  it('maps the 0-based scene selector onto a 1-based pdf.js page', async () => {
    await run(['doc.pdf[2]', 'out.png']);
    expect(raster.calls[0].pageNumber).toBe(3);
  });

  it('defaults to the first page when no scene is given', async () => {
    await run(['doc.pdf', 'out.png']);
    expect(raster.calls[0].pageNumber).toBe(1);
  });

  it('rasterizes at 150 DPI by default, matching ImageMagick', async () => {
    await run(['doc.pdf', 'out.png']);
    expect(raster.calls[0].options.scale).toBeCloseTo(150 / 72, 6);
  });

  it('honours -density before the input', async () => {
    await run(['-density', '72', 'doc.pdf', 'out.png']);
    expect(raster.calls[0].options.scale).toBeCloseTo(1, 6);
  });

  it('honours -density after the input', async () => {
    await run(['doc.pdf', '-density', '288', 'out.png']);
    expect(raster.calls[0].options.scale).toBeCloseTo(4, 6);
  });

  it('lets the last -density win', async () => {
    await run(['-density', '72', 'doc.pdf', '-density', '144', 'out.png']);
    expect(raster.calls[0].options.scale).toBeCloseTo(2, 6);
  });

  it('accepts ImageMagick WxH density syntax', async () => {
    await run(['-density', '144x144', 'doc.pdf', 'out.png']);
    expect(raster.calls[0].options.scale).toBeCloseTo(2, 6);
  });

  it('rejects a non-numeric density', async () => {
    const result = await run(['-density', 'high', 'doc.pdf', 'out.png']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('convert: Invalid density: high\n');
  });

  it('rejects a zero density rather than rendering a zero-size page', async () => {
    const result = await run(['-density', '0', 'doc.pdf', 'out.png']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid density: 0');
  });

  it('renders to PNG regardless of the output format, letting magick re-encode', async () => {
    await run(['doc.pdf', 'out.jpg']);
    expect(raster.calls[0].options.format).toBe('png');
  });

  it('applies operations to the rasterized page', async () => {
    installMagickMock();
    const ctx = ctxWith(PDF_BYTES);
    const result = await run(['doc.pdf', '-resize', '2x2', 'out.png'], ctx);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(ctx.fs.writeFile).mock.calls[0][0]).toBe('/workspace/out.png');
  });

  it('does not treat -density as an ImageMagick raster operation', async () => {
    installMagickMock();
    const result = await run(['-density', '150', 'doc.pdf', 'out.png']);
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a rasterization failure as a non-zero exit', async () => {
    raster.error = new Error('bad xref table');
    const result = await run(['doc.pdf', 'out.png']);
    expect(result).toMatchObject({ exitCode: 1, stderr: 'convert: bad xref table\n' });
  });

  it('leaves non-PDF inputs untouched by the rasterizer', async () => {
    installMagickMock();
    const ctx = ctxWith(ONE_PIXEL_PNG);
    const result = await run(['in.png', 'out.png'], ctx);
    expect(result.exitCode).toBe(0);
    expect(raster.calls).toHaveLength(0);
  });

  it('documents PDF input in --help', async () => {
    const result = await run(['--help']);
    expect(result.stdout).toContain('-density');
    expect(result.stdout).toContain('PDF inputs are rasterized');
  });
});
