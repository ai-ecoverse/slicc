import 'fake-indexeddb/auto';
import { Bash } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import {
  peekBytes,
  searchableInputLimit,
} from '../../../src/shell/supplemental-commands/rg/run.js';
import { createRgCommand } from '../../../src/shell/supplemental-commands/rg-command.js';

const SMALL_LIMITS = { maxLiveBytes: 800, maxInputBytes: 800 };
const ENFORCED = searchableInputLimit(SMALL_LIMITS);

function bashWithOverlay(files: Record<string, string | Uint8Array>): Bash {
  return new Bash({
    files,
    customCommands: [createRgCommand()],
    executionLimits: SMALL_LIMITS,
  });
}

describe('searchableInputLimit', () => {
  it('is min(maxInputBytes, floor(maxLiveBytes / 2)) — the 2× live reserve', () => {
    expect(
      searchableInputLimit({ maxLiveBytes: 512 * 1024 * 1024, maxInputBytes: 512 * 1024 * 1024 })
    ).toBe(256 * 1024 * 1024);
    expect(searchableInputLimit(SMALL_LIMITS)).toBe(400);
  });
});

describe('just-bash rg byte-limit abort (why the overlay exists)', () => {
  it('unwinds the script so a later echo never runs', async () => {
    const b = new Bash({
      files: { '/d/a.txt': `${'n'.repeat(500)}\n` },
      executionLimits: SMALL_LIMITS,
    });
    const result = await b.exec('rg n /d; echo AFTER');
    expect(result.stdout).not.toContain('AFTER');
    expect(result.stderr).toMatch(/limit exceeded/);
  });
});

describe('rg overlay (#3106)', () => {
  it('over-limit rg exits non-zero, writes stderr, and the next echo still runs', async () => {
    const b = bashWithOverlay({ '/d/a.txt': `${'n'.repeat(ENFORCED + 1)}\n` });
    const result = await b.exec('rg n /d > /out.txt 2> /err.txt; echo RG:$?; echo AFTER');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).toContain(`RG:2`);
    expect(await b.fs.readFile('/err.txt')).toBe(
      `rg: searchable input size limit exceeded (${ENFORCED} bytes)\n`
    );
    expect((await b.fs.readFile('/out.txt')).length).toBe(0);
  });

  it('reported limit matches the trip point', async () => {
    const under = bashWithOverlay({ '/d/a.txt': 'n'.repeat(ENFORCED) });
    const underResult = await under.exec('rg n /d > /out.txt 2> /err.txt; echo AFTER');
    expect(underResult.stdout).toContain('AFTER');
    expect(await under.fs.readFile('/err.txt')).toBe('');
    expect(underResult.stdout).not.toContain('limit exceeded');

    const over = bashWithOverlay({ '/d/a.txt': 'n'.repeat(ENFORCED + 1) });
    const overResult = await over.exec('rg n /d > /out.txt 2> /err.txt; echo AFTER');
    expect(overResult.stdout).toContain('AFTER');
    expect(await over.fs.readFile('/err.txt')).toContain(`(${ENFORCED} bytes)`);
  });

  it('ordinary no-match still exits 1 without aborting the script', async () => {
    const b = bashWithOverlay({ '/d/a.txt': 'hello\n' });
    const result = await b.exec(
      'rg zzz-no-such-string /d > /out.txt 2> /err.txt; echo RG:$?; echo AFTER'
    );
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).toContain('RG:1');
    expect(await b.fs.readFile('/err.txt')).toBe('');
  });

  it('missing path is a normal non-zero exit, not an abort', async () => {
    const b = bashWithOverlay({ '/d/a.txt': 'hello\n' });
    const result = await b.exec('rg x /nope/nope; echo AFTER');
    expect(result.stdout).toContain('AFTER');
  });

  it('does not count binary-skipped files toward the budget', async () => {
    const binary = new Uint8Array(ENFORCED + 50);
    binary[0] = 0;
    const b = bashWithOverlay({
      '/d/big.bin': binary,
      '/d/hit.txt': 'needle\n',
    });
    const result = await b.exec('rg needle /d; echo AFTER');
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).toContain('needle');
    expect(result.stderr).not.toMatch(/limit exceeded/);
  });

  it('counts binaries when -a/--text is set', async () => {
    const binary = new Uint8Array(ENFORCED + 50);
    binary[0] = 0;
    binary.set(new TextEncoder().encode('needle'), 1);
    const b = bashWithOverlay({ '/d/big.bin': binary });
    const result = await b.exec('rg -a needle /d > /out.txt 2> /err.txt; echo AFTER');
    expect(result.stdout).toContain('AFTER');
    expect(await b.fs.readFile('/err.txt')).toContain(`(${ENFORCED} bytes)`);
  });

  it('does not count --max-filesize skips toward the budget', async () => {
    const b = bashWithOverlay({
      '/d/big.txt': `${'n'.repeat(ENFORCED + 1)}\n`,
      '/d/hit.txt': 'needle\n',
    });
    const result = await b.exec(`rg --max-filesize 20 needle /d; echo AFTER`);
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).toContain('needle');
    expect(result.stderr).not.toMatch(/limit exceeded/);
  });

  it('searches a leading-dash pattern after --', async () => {
    const b = bashWithOverlay({ '/d/a.txt': '-foo lives here\n' });
    const result = await b.exec('rg -- -foo /d');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('-foo');
  });

  it('lists multiple files under -0/--null without treating the listing as one name', async () => {
    const b = bashWithOverlay({
      '/d/a.txt': 'needle\n',
      '/d/b.txt': 'needle\n',
    });
    const result = await b.exec('rg -0 needle /d');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('needle');
  });

  it('keeps a mixed missing-path search from succeeding as exit 0', async () => {
    const b = bashWithOverlay({ '/d/hit.txt': 'needle\n' });
    const result = await b.exec('rg needle /d /nope/nope');
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(1);
  });

  it('prints the filename when the original operand is a directory with one file', async () => {
    const b = bashWithOverlay({ '/d/hit.txt': 'needle\n' });
    const result = await b.exec('rg needle /d');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/hit\.txt/);
  });
});

describe('rg overlay through AlmostBashShellHeadless', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-rg-overlay-${dbCounter++}`,
      wipe: true,
    });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it('over-limit rg in a script still runs the following echo (dispatch wrap)', async () => {
    await fs.mkdir('/d', { recursive: true });
    await fs.writeFile('/d/a.txt', `${'n'.repeat(ENFORCED + 1)}\n`);
    const shell = new AlmostBashShellHeadless({ fs, executionLimits: SMALL_LIMITS });
    const result = await shell.executeCommand(
      'rg n /d > /out.txt 2> /err.txt; echo RG:$?; echo AFTER'
    );
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).toContain('RG:2');
    expect(await fs.readFile('/err.txt', { encoding: 'utf-8' })).toContain(`(${ENFORCED} bytes)`);
  });

  it('ordinary no-match still exits 1 without aborting', async () => {
    await fs.mkdir('/d', { recursive: true });
    await fs.writeFile('/d/a.txt', 'hello\n');
    const shell = new AlmostBashShellHeadless({ fs, executionLimits: SMALL_LIMITS });
    const result = await shell.executeCommand(
      'rg zzz-no-such-string /d > /out.txt 2> /err.txt; echo RG:$?; echo AFTER'
    );
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).toContain('RG:1');
  });

  it('stdin -c no-match is empty stdout, exit 1 (dispatch wrap)', async () => {
    await fs.mkdir('/d', { recursive: true });
    await fs.writeFile('/d/m.txt', 'hello\nworld\n');
    const shell = new AlmostBashShellHeadless({ fs, executionLimits: SMALL_LIMITS });
    const result = await shell.executeCommand(
      'cat /d/m.txt | rg -c ZZZ > /out.txt 2> /err.txt; echo RG:$?'
    );
    expect(result.stdout).toContain('RG:1');
    expect(await fs.readFile('/out.txt', { encoding: 'utf-8' })).toBe('');
    expect(await fs.readFile('/err.txt', { encoding: 'utf-8' })).toBe('');
  });

  it('peeks only the binary-detection window via readFileRange', async () => {
    await fs.mkdir('/d', { recursive: true });
    const binary = new Uint8Array(40_000);
    binary[0] = 0;
    await fs.writeFile('/d/big.bin', binary);
    await fs.writeFile('/d/hit.txt', 'needle\n');
    const shell = new AlmostBashShellHeadless({ fs, executionLimits: SMALL_LIMITS });
    const result = await shell.executeCommand('rg needle /d');
    expect(result.stdout).toContain('needle');
  });
});

describe('just-bash rg -c stdin zero (why the overlay exists)', () => {
  it('prints 0 on stdin no-match but nothing for a file argument', async () => {
    const b = new Bash({
      files: { '/m.txt': 'hello\nworld\n' },
    });
    const file = await b.exec('rg -c ZZZ /m.txt');
    expect(file.exitCode).toBe(1);
    expect(file.stdout).toBe('');

    const stdin = await b.exec('cat /m.txt | rg -c ZZZ');
    expect(stdin.exitCode).toBe(1);
    expect(stdin.stdout).toBe('0\n');
  });
});

describe('rg overlay -c / --count-matches (#3138)', () => {
  const files = { '/m.txt': 'hello\nworld\n', '/n.txt': 'nope\n' };

  it('file no-match: empty stdout, exit 1', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('rg -c ZZZ /m.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('stdin no-match: empty stdout, exit 1', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg -c ZZZ');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('file match: count, exit 0', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('rg -c hello /m.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('stdin match: count, exit 0', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg -c hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('--count stdin no-match: empty stdout, exit 1', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg --count ZZZ');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('--count-matches stdin no-match: empty stdout, exit 1', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg --count-matches ZZZ');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('--count-matches stdin match: count, exit 0', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg --count-matches hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('clustered -ic stdin no-match still omits the zero', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg -ic ZZZ');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('multi-file still omits zeros and prints only matching files', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('rg -c hello /m.txt /n.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('m.txt:1');
    expect(result.stdout).not.toContain('n.txt');
    expect(result.stdout).not.toMatch(/(^|\n)0(\n|$)/);
  });

  it('--include-zero on stdin keeps the explicit zero count', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('cat /m.txt | rg -c --include-zero ZZZ');
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe('0');
  });

  it('--include-zero on a file argument still prints 0', async () => {
    const b = bashWithOverlay(files);
    const result = await b.exec('rg -c --include-zero ZZZ /m.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe('0');
  });

  it('pipe + || echo 0 yields a single measured-or-fallback zero', async () => {
    const b = bashWithOverlay(files);
    const file = await b.exec('n=$(rg -c ZZZ /m.txt || echo 0); echo N=$n');
    expect(file.stdout).toBe('N=0\n');
    const stdin = await b.exec('n=$(cat /m.txt | rg -c ZZZ || echo 0); echo N=$n');
    expect(stdin.stdout).toBe('N=0\n');
  });
});

describe('peekBytes', () => {
  it('uses readFileRange for the 8 KiB window and does not full-read', async () => {
    const readFileRange = vi.fn(async (_path: string, start: number, end: number) => {
      expect(start).toBe(0);
      expect(end).toBe(8192);
      return new Uint8Array([0, 1, 2]);
    });
    const readFileBuffer = vi.fn(async () => {
      throw new Error('must not full-read');
    });
    const bytes = await peekBytes({ readFileRange, readFileBuffer } as never, '/big.bin', 8192);
    expect(bytes).toEqual(new Uint8Array([0, 1, 2]));
    expect(readFileRange).toHaveBeenCalledTimes(1);
    expect(readFileBuffer).not.toHaveBeenCalled();
  });
});
