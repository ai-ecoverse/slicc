import { describe, it, expect, vi } from 'vitest';
import { createPdftkCommand } from '../../../src/shell/supplemental-commands/pdftk-command.js';
import type { IFileSystem } from 'just-bash';

function createMockCtx(overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string }> = {}) {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    readFileBuffer: vi.fn().mockRejectedValue(new Error('file not found')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

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
