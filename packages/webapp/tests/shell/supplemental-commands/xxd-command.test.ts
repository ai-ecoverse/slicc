import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createXxdCommand } from '../../../src/shell/supplemental-commands/xxd-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const BIN = new Uint8Array([0x00, 0xff, 0x41, 0x80, 0x7f, 0x0a, 0xc3, 0x28]);
const binLatin1 = String.fromCharCode(...BIN);

function makeFs(files: Record<string, Uint8Array> = {}) {
  const writes: Record<string, string | Uint8Array> = {};
  const fs: Partial<IFileSystem> = {
    readFileBuffer: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error('ENOENT');
    }),
    writeFile: vi.fn(async (p: string, data: string | Uint8Array) => {
      writes[p] = data;
    }),
  };
  return { fs, writes };
}

const run = (args: string[], opts: Parameters<typeof mockCommandContext>[0] = {}) =>
  createXxdCommand().execute(args, mockCommandContext(opts));

describe('createXxdCommand', () => {
  it('has the correct name', () => {
    expect(createXxdCommand().name).toBe('xxd');
  });

  it('produces the canonical hex dump for a known buffer', async () => {
    const r = await run([], { stdin: 'hello' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('00000000: 6865 6c6c 6f                             hello\n');
  });

  it('dumps a multi-line buffer with offset, hex columns and ascii gutter', async () => {
    const r = await run([], { stdin: 'The quick brown fox\n' });
    expect(r.stdout).toBe(
      '00000000: 5468 6520 7175 6963 6b20 6272 6f77 6e20  The quick brown \n' +
        '00000010: 666f 780a                                fox.\n'
    );
  });

  it('produces identical output from stdin and from an infile', async () => {
    const stdinRes = await run([], { stdin: 'hello' });
    const { fs } = makeFs({ '/home/in.bin': new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) });
    const fileRes = await createXxdCommand().execute(['in.bin'], mockCommandContext({ fs }));
    expect(fileRes.stdout).toBe(stdinRes.stdout);
  });

  it('supports -p plain output and round-trips with -r -p', async () => {
    const plain = await run(['-p'], { stdin: 'The quick brown fox\n' });
    expect(plain.stdout).toBe('54686520717569636b2062726f776e20666f780a\n');
    const back = await run(['-r', '-p'], { stdin: plain.stdout });
    expect(back.stdout).toBe('The quick brown fox\n');
  });

  it('reverts a canonical default-format dump back to the original bytes', async () => {
    const dump = await run([], { stdin: 'hello' });
    const back = await run(['-r'], { stdin: dump.stdout });
    expect(back.stdout).toBe('hello');
  });

  it('supports -u uppercase hex', async () => {
    const r = await run(['-u'], { stdin: 'hello' });
    expect(r.stdout).toBe('00000000: 6865 6C6C 6F                             hello\n');
  });

  it('supports -c custom column count', async () => {
    const r = await run(['-c', '8'], { stdin: 'hello' });
    expect(r.stdout).toBe('00000000: 6865 6c6c 6f         hello\n');
  });

  it('supports -g custom group size including -g 0', async () => {
    const g0 = await run(['-g', '0'], { stdin: 'hello' });
    expect(g0.stdout).toBe('00000000: 68656c6c6f                        hello\n');
    const g4 = await run(['-g', '4'], { stdin: 'hello' });
    expect(g4.stdout).toBe('00000000: 68656c6c 6f                          hello\n');
  });

  it('supports -l length limit', async () => {
    const r = await run(['-l', '5'], { stdin: 'The quick brown fox\n' });
    expect(r.stdout).toBe('00000000: 5468 6520 71                             The q\n');
  });

  it('supports -s seek offset with decimal and 0x forms', async () => {
    const expected = '00000004: 7175 6963 6b20 6272 6f77 6e20 666f 780a  quick brown fox.\n';
    const dec = await run(['-s', '4'], { stdin: 'The quick brown fox\n' });
    const hex = await run(['-s', '0x4'], { stdin: 'The quick brown fox\n' });
    expect(dec.stdout).toBe(expected);
    expect(hex.stdout).toBe(expected);
  });

  it('supports -i C-include output shape (array + _len)', async () => {
    const { fs } = makeFs({ '/home/xx.bin': new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) });
    const r = await createXxdCommand().execute(['-i', 'xx.bin'], mockCommandContext({ fs }));
    expect(r.stdout).toBe(
      'unsigned char xx_bin[] = {\n  0x68, 0x65, 0x6c, 0x6c, 0x6f\n};\n' +
        'unsigned int xx_bin_len = 5;\n'
    );
    const stdinInc = await run(['-i'], { stdin: 'hello' });
    expect(stdinInc.stdout).toBe('  0x68, 0x65, 0x6c, 0x6c, 0x6f\n');
  });

  it('preserves arbitrary binary bytes through default dump and -p/-r round-trip', async () => {
    const dflt = await run([], { stdin: binLatin1 });
    expect(dflt.stdout).toBe('00000000: 00ff 4180 7f0a c328                      ..A....(\n');

    const plain = await run(['-p'], { stdin: binLatin1 });
    expect(plain.stdout).toBe('00ff41807f0ac328\n');

    const backPlain = await run(['-r', '-p'], { stdin: plain.stdout });
    expect(backPlain.stdout).toBe(binLatin1);

    const backCanon = await run(['-r'], { stdin: dflt.stdout });
    expect(backCanon.stdout).toBe(binLatin1);
  });

  it('exits 0 on --help / -h and prints usage', async () => {
    const long = await run(['--help']);
    expect(long.exitCode).toBe(0);
    expect(long.stdout).toContain('usage: xxd');
    const short = await run(['-h']);
    expect(short.exitCode).toBe(0);
    expect(short.stdout).toContain('usage: xxd');
  });

  it('exits non-zero on an unknown flag', async () => {
    const r = await run(['-z'], { stdin: 'hello' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('xxd: invalid option -z\n');
  });

  it('writes the dump text to an outfile in the VFS', async () => {
    const { fs, writes } = makeFs({
      '/home/in.bin': new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    });
    const r = await createXxdCommand().execute(['in.bin', 'out.hex'], mockCommandContext({ fs }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(writes['/home/out.hex']).toBe(
      '00000000: 6865 6c6c 6f                             hello\n'
    );
  });

  it('writes reverted bytes to an outfile in the VFS', async () => {
    const dumpText = '00000000: 00ff 4180 7f0a c328                      ..A....(\n';
    const { fs, writes } = makeFs({
      '/home/dump.hex': new Uint8Array([...dumpText].map((c) => c.charCodeAt(0))),
    });
    const r = await createXxdCommand().execute(
      ['-r', 'dump.hex', 'out.bin'],
      mockCommandContext({ fs })
    );
    expect(r.exitCode).toBe(0);
    expect(Array.from(writes['/home/out.bin'] as Uint8Array)).toEqual(Array.from(BIN));
  });
});
