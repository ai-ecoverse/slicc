import { describe, expect, it } from 'vitest';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import {
  defaultTextPath,
  joinPages,
  parsePdftotextArgs,
} from '../../../src/shell/supplemental-commands/pdftotext/run.js';
import { createPdftotextCommand } from '../../../src/shell/supplemental-commands/pdftotext-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';
import { pdfHarness } from '../helpers/pdf-fixtures.js';

describe('pdftotext registration', () => {
  it('is registered with the shell, so it is not "command not found"', () => {
    // The bug this command was written for: an agent reached for `pdftotext`,
    // got nothing, and fell back to `pdftk ... uncompress`.
    const names = createSupplementalCommands().map((command) => command.name);
    expect(names).toContain('pdftotext');
  });
});

describe('parsePdftotextArgs', () => {
  it('defaults to reading order with no output file', () => {
    expect(parsePdftotextArgs(['doc.pdf'])).toMatchObject({
      inputPath: 'doc.pdf',
      outputPath: undefined,
      mode: 'reading',
      eol: 'unix',
      noPageBreaks: false,
      quiet: false,
    });
  });

  it('treats a lone dash as the stdout sentinel, not a flag', () => {
    expect(parsePdftotextArgs(['doc.pdf', '-']).outputPath).toBe('-');
  });

  it('parses the poppler flags', () => {
    expect(
      parsePdftotextArgs(['-layout', '-f', '2', '-l', '4', '-nopgbrk', '-q', 'doc.pdf', 'out.txt'])
    ).toMatchObject({
      mode: 'layout',
      firstPage: 2,
      lastPage: 4,
      noPageBreaks: true,
      quiet: true,
      outputPath: 'out.txt',
    });
  });

  it('lets -raw fall back to reading order', () => {
    expect(parsePdftotextArgs(['-layout', '-raw', 'doc.pdf']).mode).toBe('reading');
  });

  it('accepts UTF-8 spellings for -enc and rejects other encodings', () => {
    expect(() => parsePdftotextArgs(['-enc', 'utf-8', 'doc.pdf'])).not.toThrow();
    expect(() => parsePdftotextArgs(['-enc', 'Latin1', 'doc.pdf'])).toThrow(/only UTF-8/);
  });

  it('parses -eol styles and rejects unknown ones', () => {
    expect(parsePdftotextArgs(['-eol', 'dos', 'doc.pdf']).eol).toBe('dos');
    expect(() => parsePdftotextArgs(['-eol', 'ebcdic', 'doc.pdf'])).toThrow(/invalid -eol/);
  });

  it('rejects an unknown flag rather than treating it as the input path', () => {
    expect(() => parsePdftotextArgs(['-x', 'doc.pdf'])).toThrow('unsupported option -x');
    // poppler's flags are single-dash; the GNU spelling is a typo, not a synonym.
    expect(() => parsePdftotextArgs(['--layout', 'doc.pdf'])).toThrow(
      'unsupported option --layout'
    );
    expect(() => parsePdftotextArgs(['doc.pdf', '-htmlmeta'])).toThrow(
      'unsupported option -htmlmeta'
    );
  });

  it('rejects malformed page numbers, inverted ranges, and unknown flags', () => {
    expect(() => parsePdftotextArgs(['-f', 'two', 'doc.pdf'])).toThrow(/invalid -f value/);
    expect(() => parsePdftotextArgs(['-f', '0', 'doc.pdf'])).toThrow(/invalid -f value/);
    expect(() => parsePdftotextArgs(['-l'])).toThrow(/missing argument for -l/);
    expect(() => parsePdftotextArgs(['-f', '5', '-l', '2', 'doc.pdf'])).toThrow(
      /invalid page range/
    );
    expect(() => parsePdftotextArgs(['-bbox', 'doc.pdf'])).toThrow(/unsupported option -bbox/);
    expect(() => parsePdftotextArgs([])).toThrow(/expected an input PDF/);
    expect(() => parsePdftotextArgs(['a.pdf', 'b.txt', 'c'])).toThrow(/at most one/);
  });
});

describe('defaultTextPath', () => {
  it('swaps a .pdf extension for .txt', () => {
    expect(defaultTextPath('report.pdf')).toBe('report.txt');
    expect(defaultTextPath('REPORT.PDF')).toBe('REPORT.txt');
    expect(defaultTextPath('reports/q1.2024.pdf')).toBe('reports/q1.2024.txt');
  });

  it('appends .txt when there is no .pdf extension', () => {
    expect(defaultTextPath('scan')).toBe('scan.txt');
  });
});

describe('joinPages', () => {
  it('separates pages with a form feed and terminates each with a newline', () => {
    expect(joinPages(['one', 'two'], false)).toBe('one\n\ftwo\n');
  });

  it('omits the form feed under -nopgbrk', () => {
    expect(joinPages(['one', 'two'], true)).toBe('one\ntwo\n');
  });

  it('does not double a newline the page already ends with', () => {
    expect(joinPages(['one\n'], true)).toBe('one\n');
  });
});

describe('pdftotext --help', () => {
  it('prints usage with no arguments and for -h/--help', async () => {
    const cmd = createPdftotextCommand();
    for (const args of [[], ['-h'], ['doc.pdf', '--help']]) {
      const result = await cmd.execute(args, mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: pdftotext');
    }
  });

  it('points at pdftoppm for scanned PDFs, which have no text layer', async () => {
    const result = await createPdftotextCommand().execute(['-h'], mockCommandContext());
    expect(result.stdout).toContain('pdftoppm');
  });
});

describe('pdftotext extraction (real pdf.js)', () => {
  it('writes text to stdout for "-"', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['doc.pdf', '-'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('PAGE ONE\n\fPAGE TWO\n');
  });

  it('defaults the output file to <input>.txt and names it on stdout', async () => {
    const harness = pdfHarness();
    const result = await createPdftotextCommand().execute(['doc.pdf'], harness.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('doc.txt\n');
    expect(harness.read('/home/doc.txt')).toBe('PAGE ONE\n\fPAGE TWO\n');
  });

  it('stays silent under -q', async () => {
    const harness = pdfHarness();
    const result = await createPdftotextCommand().execute(
      ['-q', 'doc.pdf', 'out.txt'],
      harness.ctx
    );
    expect(result.stdout).toBe('');
    expect(harness.read('/home/out.txt')).toContain('PAGE ONE');
  });

  it('honours -f/-l page ranges', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['-f', '2', 'doc.pdf', '-'], ctx);
    expect(result.stdout).toBe('PAGE TWO\n');
  });

  it('clamps a last page beyond the end of the document', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['-l', '99', 'doc.pdf', '-'], ctx);
    expect(result.stdout).toBe('PAGE ONE\n\fPAGE TWO\n');
  });

  it('drops the form feed under -nopgbrk', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['-nopgbrk', 'doc.pdf', '-'], ctx);
    expect(result.stdout).toBe('PAGE ONE\nPAGE TWO\n');
  });

  it('rewrites line endings for -eol dos', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['-eol', 'dos', 'doc.pdf', '-'], ctx);
    expect(result.stdout).toBe('PAGE ONE\r\n\fPAGE TWO\r\n');
  });

  it('extracts under -layout as well', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['-layout', 'doc.pdf', '-'], ctx);
    expect(result.stdout).toContain('PAGE ONE');
  });
});

describe('pdftotext errors', () => {
  it('reports a parse error without touching the filesystem', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['-bbox', 'doc.pdf'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('pdftotext: unsupported option -bbox\n');
  });

  it('rejects a file that is not a PDF', async () => {
    const { ctx } = pdfHarness({ '/home/notes.txt': 'plain text' });
    const result = await createPdftotextCommand().execute(['notes.txt', '-'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a PDF file');
  });

  it('surfaces a missing input file', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand().execute(['missing.pdf', '-'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });

  it('uses the registered name in error messages', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftotextCommand('pdf2txt').execute(['-bbox', 'doc.pdf'], ctx);
    expect(result.stderr).toContain('pdf2txt: unsupported option');
  });
});
