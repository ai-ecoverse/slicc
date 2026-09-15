/**
 * #3137 — bundled git must not colour a non-TTY, and must honour `--no-color`
 * / `--color=never` / `-c color.ui=false` / `NO_COLOR` in the accepted position.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  colorWhenFromArgs,
  normalizeGitColorArgs,
  parseColorWhen,
  resolveGitColor,
} from '../../src/git/commands/color.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

const ESC = '\x1b';

describe('git color decision (#3137)', () => {
  describe('parseColorWhen', () => {
    it('maps git spellings', () => {
      expect(parseColorWhen(false)).toBe('never');
      expect(parseColorWhen(true)).toBe('always');
      expect(parseColorWhen('never')).toBe('never');
      expect(parseColorWhen('false')).toBe('never');
      expect(parseColorWhen('always')).toBe('always');
      expect(parseColorWhen('true')).toBe('always');
      expect(parseColorWhen('auto')).toBe('auto');
      expect(parseColorWhen('nope')).toBeUndefined();
    });
  });

  describe('colorWhenFromArgs', () => {
    it('reads --no-color, --color, and --color=<when>', () => {
      expect(colorWhenFromArgs(['diff', '--no-color', 'a', 'b'])).toBe('never');
      expect(colorWhenFromArgs(['diff', '--color=never', 'a', 'b'])).toBe('never');
      expect(colorWhenFromArgs(['diff', '--color=always', 'a', 'b'])).toBe('always');
      expect(colorWhenFromArgs(['diff', '--color', 'a', 'b'])).toBe('always');
      expect(colorWhenFromArgs(['--no-color', 'diff', 'a'])).toBe('never');
    });

    it('does not treat a token after bare --color as a when-word', () => {
      expect(colorWhenFromArgs(['diff', '--color', 'never'])).toBe('always');
      expect(colorWhenFromArgs(['diff', '--color', 'auto', 'a', 'b'])).toBe('always');
    });

    it('does not read --color=never when it is the value of -m', () => {
      expect(colorWhenFromArgs(['commit', '-m', '--color=never'])).toBeUndefined();
    });

    it('ignores a colour flag after --', () => {
      expect(colorWhenFromArgs(['diff', '--', '--no-color'])).toBeUndefined();
    });

    it('lets the last colour flag win', () => {
      expect(colorWhenFromArgs(['diff', '--color', '--no-color'])).toBe('never');
      expect(colorWhenFromArgs(['diff', '--no-color', '--color'])).toBe('always');
    });
  });

  describe('normalizeGitColorArgs', () => {
    it('rewrites --color=never so mri cannot steal a positional', () => {
      expect(
        normalizeGitColorArgs(['diff', '--color=never', '--no-index', 'a.md', 'b.md'])
      ).toEqual(['diff', '--no-color', '--no-index', 'a.md', 'b.md']);
    });

    it('drops --color=auto and leaves a path after bare --color', () => {
      expect(normalizeGitColorArgs(['diff', '--color=auto', 'a'])).toEqual(['diff', 'a']);
      expect(normalizeGitColorArgs(['diff', '--color', 'never', 'a', 'b'])).toEqual([
        'diff',
        '--color',
        'never',
        'a',
        'b',
      ]);
    });

    it('does not rewrite --color=never when it is the value of -m', () => {
      expect(normalizeGitColorArgs(['commit', '-m', '--color=never'])).toEqual([
        'commit',
        '-m',
        '--color=never',
      ]);
    });
  });

  describe('resolveGitColor', () => {
    it('defaults to auto: TTY on, redirect off', () => {
      expect(resolveGitColor({ noColorEnv: false, stdoutIsTTY: false })).toBe(false);
      expect(resolveGitColor({ noColorEnv: false, stdoutIsTTY: true })).toBe(true);
    });

    it('honours CLI over config and env', () => {
      expect(
        resolveGitColor({
          cliWhen: 'never',
          colorUi: 'always',
          noColorEnv: false,
          stdoutIsTTY: true,
        })
      ).toBe(false);
      expect(
        resolveGitColor({
          cliWhen: 'always',
          noColorEnv: true,
          stdoutIsTTY: false,
        })
      ).toBe(true);
    });

    it('honours color.ui and NO_COLOR when CLI is unset', () => {
      expect(
        resolveGitColor({
          colorUi: 'false',
          noColorEnv: false,
          stdoutIsTTY: true,
        })
      ).toBe(false);
      expect(
        resolveGitColor({
          noColorEnv: true,
          stdoutIsTTY: true,
        })
      ).toBe(false);
    });

    it('treats TERM=dumb as not a colouring TTY under auto', () => {
      expect(resolveGitColor({ noColorEnv: false, stdoutIsTTY: true, term: 'dumb' })).toBe(false);
    });
  });
});

describe('git commands honour colour suppression (#3137)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-3137-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-3137-global-${testId}`,
    });
  });

  async function seedNoIndexPair(): Promise<void> {
    await vfs.mkdir('/loose', { recursive: true });
    await vfs.writeFile('/loose/a.md', 'one\n- bullet\nthree\n');
    await vfs.writeFile('/loose/b.md', 'one\n- bullet extended\nthree\n');
  }

  async function seedRepoDiff(): Promise<void> {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'old\n');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');
    await vfs.writeFile('/project/file.txt', 'new\n');
  }

  it('emits no ESC on redirected git diff --no-index, and ^[+-] matches', async () => {
    await seedNoIndexPair();
    const result = await git.execute(['diff', '--no-index', 'a.md', 'b.md'], '/loose');
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toMatch(/^[-+]/m);
    expect(result.stdout).toMatch(/^-- bullet$/m);
    expect(result.stdout).toMatch(/^\+- bullet extended$/m);
  });

  it.each([
    { label: '--no-color', args: ['diff', '--no-color', '--no-index', 'a.md', 'b.md'] },
    { label: '--color=never', args: ['diff', '--color=never', '--no-index', 'a.md', 'b.md'] },
    {
      label: '-c color.ui=false',
      args: ['-c', 'color.ui=false', 'diff', '--no-index', 'a.md', 'b.md'],
    },
    { label: 'git --no-color diff', args: ['--no-color', 'diff', '--no-index', 'a.md', 'b.md'] },
  ])('emits no ESC with $label', async ({ args }) => {
    await seedNoIndexPair();
    const result = await git.execute(args, '/loose');
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toMatch(/^-- bullet$/m);
  });

  it('emits no ESC with NO_COLOR=1', async () => {
    await seedNoIndexPair();
    const result = await git.execute(['diff', '--no-index', 'a.md', 'b.md'], '/loose', {
      NO_COLOR: '1',
    });
    expect(result.stdout).not.toContain(ESC);
  });

  it('still colours a TTY under auto, and --color forces a redirect', async () => {
    await seedNoIndexPair();
    const tty = await git.execute(
      ['diff', '--no-index', 'a.md', 'b.md'],
      '/loose',
      undefined,
      undefined,
      { stdoutIsTTY: true }
    );
    expect(tty.stdout).toContain(`${ESC}[31m`);
    expect(tty.stdout).toContain(`${ESC}[32m`);

    const forced = await git.execute(['diff', '--color', '--no-index', 'a.md', 'b.md'], '/loose');
    expect(forced.stdout).toContain(`${ESC}[31m`);
  });

  it('does not colour redirected git diff / show / status / log', async () => {
    await seedRepoDiff();
    const diff = await git.execute(['diff'], '/project');
    expect(diff.stdout).not.toContain(ESC);
    expect(diff.stdout).toMatch(/^-old$/m);
    expect(diff.stdout).toMatch(/^\+new$/m);

    const show = await git.execute(['show', 'HEAD'], '/project');
    expect(show.stdout).not.toContain(ESC);
    expect(show.stdout).toContain('commit ');

    await vfs.writeFile('/project/extra.txt', 'untracked\n');
    const status = await git.execute(['status'], '/project');
    expect(status.stdout).not.toContain(ESC);
    expect(status.stdout).toContain('extra.txt');

    const log = await git.execute(['log', '-n', '1'], '/project');
    expect(log.stdout).not.toContain(ESC);
    expect(log.stdout).toContain('commit ');
  });

  it('redirected shell git diff --no-index has zero ESC and grep ^[+-] matches', async () => {
    await seedNoIndexPair();
    const shell = new AlmostBashShellHeadless({ fs: vfs, cwd: '/loose' });
    const run = await shell.executeCommand('git diff --no-index a.md b.md > out.txt');
    expect(run.exitCode, run.stderr).toBe(1);
    const out = await vfs.readFile('/loose/out.txt');
    expect(out).not.toContain(ESC);
    expect(out).toMatch(/^[-+]/m);
    expect(out).toMatch(/^-- bullet$/m);
    expect(out).toMatch(/^\+- bullet extended$/m);

    const grepped = await shell.executeCommand("grep -c '^[+-]' out.txt");
    expect(grepped.exitCode).toBe(0);
    expect(grepped.stdout.trim()).not.toBe('0');
  });

  it('keeps --color=never as the commit message of -m', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'content\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(['commit', '-m', '--color=never'], '/project');
    expect(result.exitCode, result.stderr).toBe(0);
    const log = await git.execute(['log', '--format', '%s', '-n', '1'], '/project');
    expect(log.stdout.trim()).toBe('--color=never');
  });
});
