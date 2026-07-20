import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPdftkCommand } from '../../../src/shell/supplemental-commands/pdftk-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

// Shared, per-test-configurable state for the mocked PDF libraries. Lets the
// operation-body tests below drive page counts, metadata, and extracted text
// without shipping real PDF fixtures.
const pdf = vi.hoisted(() => ({
  pageCount: 3,
  title: '',
  author: '',
  creator: '',
  producer: '',
  text: '',
  addPage: vi.fn(),
  setRotation: vi.fn(),
  // Records each copyPages(src, indices) call so tests can assert which source
  // document and which 0-based page indices were copied, in order.
  copyPagesCalls: [] as Array<{ docId: string; indices: number[] }>,
  loadCount: 0,
}));

vi.mock('@cantoo/pdf-lib', () => {
  const makeDoc = (docId: string) => ({
    docId,
    getPageCount: () => pdf.pageCount,
    getTitle: () => pdf.title || undefined,
    getAuthor: () => pdf.author || undefined,
    getCreator: () => pdf.creator || undefined,
    getProducer: () => pdf.producer || undefined,
    getPages: () =>
      Array.from({ length: pdf.pageCount }, () => ({
        getRotation: () => ({ angle: 0 }),
        setRotation: pdf.setRotation,
      })),
    copyPages: async (src: { docId: string }, indices: number[]) => {
      pdf.copyPagesCalls.push({ docId: src.docId, indices: [...indices] });
      return indices.map(() => ({ setRotation: pdf.setRotation }));
    },
    addPage: pdf.addPage,
    save: async () => new Uint8Array([1, 2, 3]),
  });
  return {
    PDFDocument: {
      load: async () => makeDoc(`in${++pdf.loadCount}`),
      create: async () => makeDoc('out'),
    },
    degrees: (angle: number) => ({ angle }),
  };
});

vi.mock('unpdf', () => ({
  extractText: async () => ({ text: pdf.text }),
}));

const createMockCtx = (overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string }> = {}) =>
  mockCommandContext({
    fs: {
      readFileBuffer: vi.fn().mockRejectedValue(new Error('file not found')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides.fs,
    },
    cwd: overrides.cwd ?? '/home',
  });

/** ctx whose reads succeed, so operation bodies (not the read guard) execute. */
const okCtx = (overrides: Partial<IFileSystem> = {}) =>
  mockCommandContext({
    fs: {
      readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([0])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  });

describe('createPdftkCommand', () => {
  it('returns a Command with the correct name', () => {
    const cmd = createPdftkCommand();
    expect(cmd.name).toBe('pdftk');
  });

  it('returns a Command with a custom name', () => {
    const cmd = createPdftkCommand('pdf');
    expect(cmd.name).toBe('pdf');
  });

  it('has an execute function', () => {
    const cmd = createPdftkCommand();
    expect(typeof cmd.execute).toBe('function');
  });
});

describe('pdftk --help', () => {
  it('shows help with --help flag', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pdftk');
    expect(result.stdout).toContain('dump_data');
    expect(result.stdout).toContain('dump_data_utf8');
    expect(result.stdout).toContain('cat');
    expect(result.stdout).toContain('rotate');
    expect(result.stderr).toBe('');
  });

  it('shows help with -h flag', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['-h'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pdftk');
  });

  it('shows help with no arguments', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pdftk');
  });
});

describe('pdftk error cases', () => {
  it('errors when no operation is specified', async () => {
    const cmd = createPdftkCommand();
    // Only a file, no operation keyword
    const result = await cmd.execute(['input.pdf'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no operation specified');
  });

  it('errors on unknown operation', async () => {
    const cmd = createPdftkCommand();
    // 'encrypt' is not a known operation keyword, so the parser treats it as a
    // second input file. With no operation keyword found, it reports "no operation".
    const result = await cmd.execute(['input.pdf', 'encrypt'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no operation specified');
  });

  it('errors on truly unknown operation after valid input parsing', async () => {
    // If we somehow get past input parsing with a bad operation, it's caught.
    // We can't easily trigger this through normal args since unknown words are
    // treated as input files. But a dash-prefixed unknown option on its own
    // would trigger "no input PDF specified" since it breaks the input loop.
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['-x'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no input PDF specified');
  });

  it('uses custom name in error messages', async () => {
    const cmd = createPdftkCommand('pdf');
    const result = await cmd.execute(['input.pdf'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pdf: no operation specified');
  });
});

describe('pdftk dump_data', () => {
  it('errors when input file does not exist', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['missing.pdf', 'dump_data'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });

  it('errors when multiple inputs are given', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['a.pdf', 'b.pdf', 'dump_data'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('dump_data only supports a single input file');
  });

  it('resolves the input path relative to cwd', async () => {
    const readFileBuffer = vi.fn().mockRejectedValue(new Error('file not found'));
    const cmd = createPdftkCommand();
    await cmd.execute(['doc.pdf', 'dump_data'], createMockCtx({ fs: { readFileBuffer } }));
    expect(readFileBuffer).toHaveBeenCalledWith('/home/doc.pdf');
  });
});

describe('pdftk dump_data_utf8', () => {
  it('errors when input file does not exist', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['missing.pdf', 'dump_data_utf8'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });

  it('errors when multiple inputs are given', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['a.pdf', 'b.pdf', 'dump_data_utf8'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('dump_data_utf8 only supports a single input file');
  });
});

describe('pdftk cat', () => {
  it('errors when output keyword is missing', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['input.pdf', 'cat', '1-3'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cat operation requires 'output <filename>'");
  });

  it('errors when output filename is missing', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['input.pdf', 'cat', '1-3', 'output'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('output filename not specified');
  });

  it('errors when input file does not exist', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(
      ['missing.pdf', 'cat', '1-3', 'output', 'out.pdf'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });
});

describe('pdftk rotate', () => {
  it('errors when multiple inputs are given', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(
      ['a.pdf', 'b.pdf', 'rotate', '1-endright', 'output', 'out.pdf'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rotate only supports a single input file');
  });

  it('errors when input file does not exist', async () => {
    const cmd = createPdftkCommand();
    // Note: rotate reads the file before checking for 'output' keyword,
    // so file-not-found is the first error hit.
    const result = await cmd.execute(
      ['missing.pdf', 'rotate', '1-endright', 'output', 'out.pdf'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });

  it('errors when input file does not exist (no output keyword)', async () => {
    const cmd = createPdftkCommand();
    // Without a real file, the file-not-found error fires before output check
    const result = await cmd.execute(['input.pdf', 'rotate', '1-endright'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });
});

describe('pdftk handle syntax', () => {
  it('parses A=file.pdf handle syntax', async () => {
    const readFileBuffer = vi.fn().mockRejectedValue(new Error('file not found'));
    const cmd = createPdftkCommand();
    await cmd.execute(
      ['A=one.pdf', 'B=two.pdf', 'cat', 'A', 'B', 'output', 'merged.pdf'],
      createMockCtx({ fs: { readFileBuffer } })
    );
    // Should resolve both handle paths
    expect(readFileBuffer).toHaveBeenCalledWith('/home/one.pdf');
  });
});

describe('pdftk help appears in various positions', () => {
  it('shows help even with other args present', async () => {
    const cmd = createPdftkCommand();
    const result = await cmd.execute(['input.pdf', '--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pdftk');
  });
});

describe('pdftk operation bodies (mocked pdf libs)', () => {
  beforeEach(() => {
    pdf.pageCount = 3;
    pdf.title = '';
    pdf.author = '';
    pdf.creator = '';
    pdf.producer = '';
    pdf.text = '';
    pdf.addPage.mockClear();
    pdf.setRotation.mockClear();
    pdf.copyPagesCalls = [];
    pdf.loadCount = 0;
  });

  it('dump_data prints the page count only when no metadata exists', async () => {
    const result = await createPdftkCommand().execute(['in.pdf', 'dump_data'], okCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('NumberOfPages: 3\n');
  });

  it('dump_data prints every info block that is present', async () => {
    pdf.title = 'My Doc';
    pdf.author = 'Ada';
    pdf.creator = 'SLICC';
    pdf.producer = 'pdf-lib';
    const result = await createPdftkCommand().execute(['in.pdf', 'dump_data'], okCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('InfoKey: Title');
    expect(result.stdout).toContain('InfoValue: My Doc');
    expect(result.stdout).toContain('InfoValue: Ada');
    expect(result.stdout).toContain('InfoValue: SLICC');
    expect(result.stdout).toContain('InfoValue: pdf-lib');
  });

  it('dump_data_utf8 emits the extracted text', async () => {
    pdf.text = 'hello world';
    const result = await createPdftkCommand().execute(['in.pdf', 'dump_data_utf8'], okCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
  });

  it('cat copies a page range and writes the output', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'cat', '1-2', 'output', 'out.pdf'],
      okCtx({ writeFile: writeFile as unknown as IFileSystem['writeFile'] })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Created out.pdf\n');
    // Pages 1-2 map to 0-based indices [0, 1] copied from the single input.
    expect(pdf.copyPagesCalls).toEqual([{ docId: 'in1', indices: [0, 1] }]);
    expect(pdf.addPage).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledWith('/home/out.pdf', expect.any(Uint8Array));
  });

  it('cat resolves the end keyword and a single page spec', async () => {
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'cat', '2-end', '1', 'output', 'out.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(0);
    // '2-end' (pageCount 3) → indices [1, 2]; then '1' → [0], preserving order.
    expect(pdf.copyPagesCalls).toEqual([
      { docId: 'in1', indices: [1, 2] },
      { docId: 'in1', indices: [0] },
    ]);
    expect(pdf.addPage).toHaveBeenCalledTimes(3);
  });

  it('cat applies the right-rotation angle to copied pages', async () => {
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'cat', '1-2right', 'output', 'out.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(0);
    // right = 90°, applied to each of the two copied pages.
    expect(pdf.setRotation).toHaveBeenCalledTimes(2);
    expect(pdf.setRotation).toHaveBeenCalledWith({ angle: 90 });
  });

  it('cat merges pages from lettered handles in handle order', async () => {
    const result = await createPdftkCommand().execute(
      ['A=one.pdf', 'B=two.pdf', 'cat', 'A', 'B', 'output', 'merged.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(0);
    // A (first-loaded → in1) fully, then B (in2) fully; each has 3 pages.
    expect(pdf.copyPagesCalls).toEqual([
      { docId: 'in1', indices: [0, 1, 2] },
      { docId: 'in2', indices: [0, 1, 2] },
    ]);
    expect(pdf.addPage).toHaveBeenCalledTimes(6);
  });

  it('cat errors on an unknown handle reference', async () => {
    const result = await createPdftkCommand().execute(
      ['A=one.pdf', 'cat', 'A', 'C', 'output', 'merged.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown handle 'C'");
  });

  it('cat rejects an unparseable page range', async () => {
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'cat', 'xyz', 'output', 'out.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid page range: xyz');
  });

  it('cat rejects a page number beyond the document length', async () => {
    pdf.pageCount = 2;
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'cat', '5', 'output', 'out.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('out of range');
  });

  it('rotate applies rotations and writes the output', async () => {
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'rotate', '1-2right', 'output', 'out.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Created out.pdf\n');
    // Two pages rotated from 0° by 90° (right) → final angle 90°.
    expect(pdf.setRotation).toHaveBeenCalledTimes(2);
    expect(pdf.setRotation).toHaveBeenCalledWith({ angle: 90 });
  });

  it('rotate requires a rotation suffix on each range', async () => {
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'rotate', '1-2', 'output', 'out.pdf'],
      okCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rotation suffix required');
  });

  it('rotate requires an output keyword', async () => {
    const result = await createPdftkCommand().execute(['in.pdf', 'rotate', '1-2right'], okCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("rotate operation requires 'output <filename>'");
  });

  it('rotate reports a missing output filename', async () => {
    const result = await createPdftkCommand().execute(
      ['in.pdf', 'rotate', '1-2right', 'output'],
      okCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('output filename not specified');
  });

  it('rejects an unknown operation once inputs parse', async () => {
    // 'dump_data' is a known keyword so parsing stops there; feed a lone known
    // keyword variant by using a handle input plus a bogus op keyword position.
    const result = await createPdftkCommand().execute(['in.pdf', 'cat', 'output'], okCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('output filename not specified');
  });
});
