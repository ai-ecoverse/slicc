import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPdftoppmCommand,
  formatPageFileName,
  parsePdftoppmArgs,
} from '../../../src/shell/supplemental-commands/pdftoppm-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

// Stand in for the rasterizer so the command tests exercise argument parsing,
// output naming, and VFS writes without a canvas or a binary PDF fixture.
// `pdf-raster.test.ts` covers the rendering side.
const raster = vi.hoisted(() => ({
  totalPages: 3,
  /** Records the options each renderPdfPageRange call received. */
  calls: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
}));

vi.mock('../../../src/shell/supplemental-commands/pdf-raster.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/shell/supplemental-commands/pdf-raster.js')>();
  return {
    ...actual,
    renderPdfPageRange: async (_data: Uint8Array, options: Record<string, unknown> = {}) => {
      raster.calls.push(options);
      if (raster.error) throw raster.error;
      const first = Math.max(1, (options.firstPage as number) ?? 1);
      const last = Math.min(raster.totalPages, (options.lastPage as number) ?? raster.totalPages);
      if (first > raster.totalPages) {
        throw new Error(`page ${first} out of range (1-${raster.totalPages})`);
      }
      const pages = [];
      for (let pageNumber = first; pageNumber <= last; pageNumber++) {
        pages.push({ pageNumber, bytes: new Uint8Array([pageNumber]), width: 10, height: 20 });
      }
      return { pages, totalPages: raster.totalPages };
    },
  };
});

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ncontent');

const okCtx = (overrides: Partial<IFileSystem> = {}) =>
  mockCommandContext({
    fs: {
      readFileBuffer: vi.fn().mockResolvedValue(PDF_BYTES),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
    cwd: '/workspace',
  });

const run = async (args: string[], ctx = okCtx(), name = 'pdftoppm') => {
  const cmd = createPdftoppmCommand(name);
  return cmd.execute(args, ctx);
};

beforeEach(() => {
  raster.totalPages = 3;
  raster.calls = [];
  raster.error = null;
});

describe('parsePdftoppmArgs', () => {
  it('defaults to PNG at the poppler default DPI', () => {
    expect(parsePdftoppmArgs(['doc.pdf'])).toMatchObject({
      inputPath: 'doc.pdf',
      outputRoot: undefined,
      format: 'png',
      dpi: 150,
      singleFile: false,
    });
  });

  it('takes an output prefix', () => {
    expect(parsePdftoppmArgs(['doc.pdf', 'page']).outputRoot).toBe('page');
  });

  it('accepts flags after the positionals', () => {
    expect(parsePdftoppmArgs(['doc.pdf', 'page', '-jpeg']).format).toBe('jpeg');
  });

  it('parses -jpeg', () => {
    expect(parsePdftoppmArgs(['-jpeg', 'doc.pdf']).format).toBe('jpeg');
  });

  it('lets a later -png override an earlier -jpeg', () => {
    expect(parsePdftoppmArgs(['-jpeg', '-png', 'doc.pdf']).format).toBe('png');
  });

  it('implies -jpeg from -jpegopt', () => {
    const parsed = parsePdftoppmArgs(['-jpegopt', 'quality=70', 'doc.pdf']);
    expect(parsed).toMatchObject({ format: 'jpeg', quality: 70 });
  });

  it('ignores unsupported -jpegopt keys alongside quality', () => {
    expect(parsePdftoppmArgs(['-jpegopt', 'optimize=y,quality=55', 'doc.pdf']).quality).toBe(55);
  });

  it('rejects a -jpegopt with no quality key', () => {
    expect(() => parsePdftoppmArgs(['-jpegopt', 'optimize=y', 'doc.pdf'])).toThrow(
      'unsupported -jpegopt: optimize=y'
    );
  });

  it('rejects an out-of-range -jpegopt quality', () => {
    expect(() => parsePdftoppmArgs(['-jpegopt', 'quality=200', 'doc.pdf'])).toThrow(
      'invalid -jpegopt quality: 200'
    );
  });

  it('parses -r, -f and -l', () => {
    expect(parsePdftoppmArgs(['-r', '300', '-f', '2', '-l', '5', 'doc.pdf'])).toMatchObject({
      dpi: 300,
      firstPage: 2,
      lastPage: 5,
    });
  });

  it('parses the scale-to family', () => {
    expect(
      parsePdftoppmArgs(['-scale-to', '1024', '-scale-to-x', '800', '-scale-to-y', '600', 'd.pdf'])
    ).toMatchObject({ scaleTo: 1024, scaleToX: 800, scaleToY: 600 });
  });

  it('parses -singlefile', () => {
    expect(parsePdftoppmArgs(['-singlefile', 'doc.pdf']).singleFile).toBe(true);
  });

  it('rejects an unsupported option', () => {
    expect(() => parsePdftoppmArgs(['-tiff', 'doc.pdf'])).toThrow('unsupported option -tiff');
  });

  it('rejects a missing flag argument', () => {
    expect(() => parsePdftoppmArgs(['doc.pdf', '-r'])).toThrow('missing argument for -r');
  });

  it('rejects a non-numeric DPI', () => {
    expect(() => parsePdftoppmArgs(['-r', 'high', 'doc.pdf'])).toThrow('invalid -r value: high');
  });

  it('rejects a zero DPI rather than dividing down to a zero-size canvas', () => {
    expect(() => parsePdftoppmArgs(['-r', '0', 'doc.pdf'])).toThrow('invalid -r value: 0');
  });

  it('rejects a negative page number', () => {
    expect(() => parsePdftoppmArgs(['-f', '-2', 'doc.pdf'])).toThrow(
      /invalid -f value|unsupported/
    );
  });

  it('rejects a fractional page number', () => {
    expect(() => parsePdftoppmArgs(['-f', '1.5', 'doc.pdf'])).toThrow('invalid -f value: 1.5');
  });

  it('rejects no input', () => {
    expect(() => parsePdftoppmArgs(['-png'])).toThrow('expected an input PDF');
  });

  it('rejects extra positionals', () => {
    expect(() => parsePdftoppmArgs(['a.pdf', 'out', 'extra'])).toThrow(
      'expected at most one input PDF and one output prefix'
    );
  });

  it('rejects an inverted page range', () => {
    expect(() => parsePdftoppmArgs(['-f', '5', '-l', '2', 'doc.pdf'])).toThrow(
      'invalid page range: 5-2'
    );
  });
});

describe('formatPageFileName', () => {
  it('does not pad when the last page is single-digit', () => {
    expect(formatPageFileName('out', 3, 9, 'png')).toBe('out-3.png');
  });

  it('pads to two digits when the last page is double-digit', () => {
    expect(formatPageFileName('out', 3, 12, 'png')).toBe('out-03.png');
  });

  it('pads to three digits for a long document', () => {
    expect(formatPageFileName('out', 7, 100, 'jpg')).toBe('out-007.jpg');
  });
});

describe('createPdftoppmCommand', () => {
  it('registers under the requested name', () => {
    expect(createPdftoppmCommand().name).toBe('pdftoppm');
    expect(createPdftoppmCommand('pdftocairo').name).toBe('pdftocairo');
  });

  it('prints help with no arguments', async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pdftoppm');
  });

  it('prints help for --help', async () => {
    expect((await run(['--help'])).stdout).toContain('usage: pdftoppm');
  });

  it('writes one PNG per page with the poppler naming scheme', async () => {
    const ctx = okCtx();
    const result = await run(['-png', 'doc.pdf', 'page'], ctx);
    expect(result.exitCode).toBe(0);
    const written = vi.mocked(ctx.fs.writeFile).mock.calls.map((call) => call[0]);
    expect(written).toEqual([
      '/workspace/page-1.png',
      '/workspace/page-2.png',
      '/workspace/page-3.png',
    ]);
  });

  it('lists the files it wrote on stdout', async () => {
    const result = await run(['doc.pdf', 'page']);
    expect(result.stdout).toBe('page-1.png\npage-2.png\npage-3.png\n');
  });

  it('writes the rendered bytes for each page', async () => {
    const ctx = okCtx();
    await run(['doc.pdf', 'page'], ctx);
    const bytes = vi
      .mocked(ctx.fs.writeFile)
      .mock.calls.map((call) => Array.from(call[1] as Uint8Array));
    expect(bytes).toEqual([[1], [2], [3]]);
  });

  it('pads page numbers once the document crosses ten pages', async () => {
    raster.totalPages = 12;
    const result = await run(['doc.pdf', 'page']);
    expect(result.stdout.split('\n')[0]).toBe('page-01.png');
    expect(result.stdout).toContain('page-12.png');
  });

  it('defaults the prefix to the input basename without its extension', async () => {
    const ctx = okCtx();
    await run(['/workspace/reports/q3.pdf'], ctx);
    expect(vi.mocked(ctx.fs.writeFile).mock.calls[0][0]).toBe('/workspace/q3-1.png');
  });

  it('writes .jpg for -jpeg', async () => {
    const result = await run(['-jpeg', 'doc.pdf', 'page']);
    expect(result.stdout).toContain('page-1.jpg');
  });

  it('passes the JPEG format and quality to the rasterizer', async () => {
    await run(['-jpeg', '-jpegopt', 'quality=60', 'doc.pdf', 'page']);
    expect(raster.calls[0]).toMatchObject({ format: 'jpeg', quality: 60 });
  });

  it('converts -r into a pdf.js scale', async () => {
    await run(['-r', '72', 'doc.pdf', 'page']);
    expect(raster.calls[0]).toMatchObject({ scale: 1 });
  });

  it('uses 150 DPI by default', async () => {
    await run(['doc.pdf', 'page']);
    expect(raster.calls[0].scale).toBeCloseTo(150 / 72, 6);
  });

  it('passes -scale-to as a long-edge fit, not a scale', async () => {
    await run(['-scale-to', '1024', 'doc.pdf', 'page']);
    expect(raster.calls[0]).toMatchObject({ longEdge: 1024 });
    expect(raster.calls[0].scale).toBeUndefined();
  });

  it('prefers -scale-to-x over -scale-to', async () => {
    await run(['-scale-to', '1024', '-scale-to-x', '800', 'doc.pdf', 'page']);
    expect(raster.calls[0]).toMatchObject({ width: 800 });
    expect(raster.calls[0].longEdge).toBeUndefined();
  });

  it('honours -f and -l', async () => {
    const result = await run(['-f', '2', '-l', '3', 'doc.pdf', 'page']);
    expect(result.stdout).toBe('page-2.png\npage-3.png\n');
  });

  it('writes exactly one unsuffixed file for -singlefile', async () => {
    const ctx = okCtx();
    const result = await run(['-singlefile', 'doc.pdf', 'cover'], ctx);
    expect(result.stdout).toBe('cover.png\n');
    expect(vi.mocked(ctx.fs.writeFile).mock.calls.map((call) => call[0])).toEqual([
      '/workspace/cover.png',
    ]);
  });

  it('renders the -f page for -singlefile, not always page 1', async () => {
    await run(['-singlefile', '-f', '3', 'doc.pdf', 'cover']);
    expect(raster.calls[0]).toMatchObject({ firstPage: 3, lastPage: 3 });
  });

  it('rejects a non-PDF input before rendering', async () => {
    const ctx = okCtx({ readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50])) });
    const result = await run(['notes.png', 'page'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('pdftoppm: notes.png: not a PDF file\n');
    expect(raster.calls).toHaveLength(0);
  });

  it('reports a missing input file', async () => {
    const ctx = okCtx({ readFileBuffer: vi.fn().mockRejectedValue(new Error('ENOENT')) });
    const result = await run(['missing.pdf'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('pdftoppm: ENOENT\n');
  });

  it('reports a parse error without touching the filesystem', async () => {
    const ctx = okCtx();
    const result = await run(['-tiff', 'doc.pdf'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('pdftoppm: unsupported option -tiff\n');
    expect(ctx.fs.readFileBuffer).not.toHaveBeenCalled();
  });

  it('surfaces a render failure as a non-zero exit', async () => {
    raster.error = new Error('bad xref table');
    const result = await run(['doc.pdf', 'page']);
    expect(result).toMatchObject({ exitCode: 1, stderr: 'pdftoppm: bad xref table\n' });
  });

  it('prefixes errors with the alias the user invoked', async () => {
    const result = await run(['-tiff', 'doc.pdf'], okCtx(), 'pdftocairo');
    expect(result.stderr).toBe('pdftocairo: unsupported option -tiff\n');
  });

  it('reports an out-of-range -f from the rasterizer', async () => {
    const result = await run(['-f', '9', 'doc.pdf', 'page']);
    expect(result).toMatchObject({ exitCode: 1, stderr: 'pdftoppm: page 9 out of range (1-3)\n' });
  });
});
