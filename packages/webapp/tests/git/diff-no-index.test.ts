/**
 * `git diff --no-index` (issue #2950).
 *
 * The expectations here were taken from real `git diff --no-index` on the host
 * (git 2.50.1), minus the `index` / `new file mode` header lines SLICC's diff
 * output omits everywhere. The whole point of the mode is that it works with no
 * repository at all, so every case below runs from a cwd that was never
 * `git init`ed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { pprintRename } from '../../src/git/commands/diff-no-index.js';
import { GitCommands } from '../../src/git/git-commands.js';

/** Diff output is colored; assertions compare the plain text. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point.
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('git diff --no-index', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  /** A cwd that is NOT inside a git repository, with two three-line files. */
  const CWD = '/loose';

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-no-index-test-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-no-index-global-${testId}`,
    });
    await vfs.mkdir(CWD, { recursive: true });
    await vfs.writeFile(`${CWD}/d1.txt`, 'a\nb\nc\n');
    await vfs.writeFile(`${CWD}/d2.txt`, 'a\nX\nc\n');
  });

  it('diffs two files with no repository in sight', async () => {
    expect(await vfs.exists(`${CWD}/.git`)).toBe(false);

    const result = await git.execute(['diff', '--no-index', 'd1.txt', 'd2.txt'], CWD);

    expect(plain(result.stdout)).toBe(
      [
        'diff --git a/d1.txt b/d2.txt',
        '--- a/d1.txt',
        '+++ b/d2.txt',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+X',
        ' c',
        '',
      ].join('\n')
    );
    expect(result.stderr).toBe('');
    // `--no-index` implies `--exit-code`.
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 with no output when the two files are identical', async () => {
    await vfs.writeFile(`${CWD}/d3.txt`, 'a\nb\nc\n');

    const result = await git.execute(['diff', '--no-index', 'd1.txt', 'd3.txt'], CWD);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports a missing path instead of an empty diff', async () => {
    const result = await git.execute(['diff', '--no-index', 'd1.txt', 'nope.txt'], CWD);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe("error: Could not access 'nope.txt'\n");
    expect(result.exitCode).toBe(1);
  });

  it('names the left operand when both paths are missing', async () => {
    const result = await git.execute(['diff', '--no-index', 'no1', 'no2'], CWD);

    expect(result.stderr).toBe("error: Could not access 'no1'\n");
    expect(result.exitCode).toBe(1);
  });

  it('--name-only prints the b-side path', async () => {
    const result = await git.execute(
      ['diff', '--no-index', '--name-only', 'd1.txt', 'd2.txt'],
      CWD
    );

    expect(result.stdout).toBe('d2.txt\n');
    expect(result.exitCode).toBe(1);
  });

  it('--stat labels the row with the rename-compressed form', async () => {
    const result = await git.execute(['diff', '--no-index', '--stat', 'd1.txt', 'd2.txt'], CWD);

    expect(plain(result.stdout)).toBe(
      [' d1.txt => d2.txt |    2 +-', ' 1 file changed, 1 insertion(+), 1 deletion(-)', ''].join(
        '\n'
      )
    );
    expect(result.exitCode).toBe(1);
  });

  it('honors -U<n> for the context width', async () => {
    await vfs.writeFile(`${CWD}/long1.txt`, 'a\nb\nc\nd\ne\n');
    await vfs.writeFile(`${CWD}/long2.txt`, 'a\nb\nX\nd\ne\n');

    const wide = await git.execute(['diff', '--no-index', 'long1.txt', 'long2.txt'], CWD);
    expect(plain(wide.stdout)).toContain('@@ -1,5 +1,5 @@');

    const narrow = await git.execute(['diff', '--no-index', '-U1', 'long1.txt', 'long2.txt'], CWD);
    expect(plain(narrow.stdout)).toContain('@@ -2,3 +2,3 @@');
    // `-U1` must not be mistaken for a positional and swallow an operand.
    expect(narrow.stderr).toBe('');
    expect(narrow.exitCode).toBe(1);
  });

  it('strips the leading slash of an absolute operand, as git does', async () => {
    const result = await git.execute(['diff', '--no-index', `${CWD}/d1.txt`, `${CWD}/d2.txt`], '/');

    expect(plain(result.stdout)).toContain('diff --git a/loose/d1.txt b/loose/d2.txt');
    expect(plain(result.stdout)).toContain('--- a/loose/d1.txt');
    expect(plain(result.stdout)).toContain('+++ b/loose/d2.txt');
  });

  it('treats /dev/null as an empty file, heading the patch as an addition', async () => {
    const result = await git.execute(['diff', '--no-index', '/dev/null', 'd2.txt'], CWD);

    expect(plain(result.stdout)).toBe(
      [
        'diff --git a/d2.txt b/d2.txt',
        '--- /dev/null',
        '+++ b/d2.txt',
        '@@ -0,0 +1,3 @@',
        '+a',
        '+X',
        '+c',
        '',
      ].join('\n')
    );
    expect(result.exitCode).toBe(1);
  });

  it('reports binary pairs instead of emitting decoded garbage', async () => {
    await vfs.writeFile(`${CWD}/b1.bin`, new Uint8Array([0x61, 0x00, 0x62, 0x0a]));
    await vfs.writeFile(`${CWD}/b2.bin`, new Uint8Array([0x61, 0x00, 0x63, 0x0a]));

    const result = await git.execute(['diff', '--no-index', 'b1.bin', 'b2.bin'], CWD);

    expect(plain(result.stdout)).toBe(
      ['diff --git a/b1.bin b/b2.bin', 'Binary files a/b1.bin and b/b2.bin differ', ''].join('\n')
    );
    expect(result.exitCode).toBe(1);

    const stat = await git.execute(['diff', '--no-index', '--stat', 'b1.bin', 'b2.bin'], CWD);
    expect(plain(stat.stdout)).toBe(
      [
        ' b1.bin => b2.bin | Bin 4 -> 4 bytes',
        // git suppresses a zero clause only when the OTHER one is non-zero.
        ' 1 file changed, 0 insertions(+), 0 deletions(-)',
        '',
      ].join('\n')
    );
  });

  describe('a missing trailing newline', () => {
    it('is a real hunk, not exit 1 with empty output', async () => {
      await vfs.writeFile(`${CWD}/eol.txt`, 'a\nb\n');
      await vfs.writeFile(`${CWD}/noeol.txt`, 'a\nb');

      const result = await git.execute(['diff', '--no-index', 'eol.txt', 'noeol.txt'], CWD);

      expect(plain(result.stdout)).toBe(
        [
          'diff --git a/eol.txt b/noeol.txt',
          '--- a/eol.txt',
          '+++ b/noeol.txt',
          '@@ -1,2 +1,2 @@',
          ' a',
          '-b',
          '+b',
          '\\ No newline at end of file',
          '',
        ].join('\n')
      );
      expect(result.exitCode).toBe(1);
    });

    it('marks a shared incomplete last line once, on the context line', async () => {
      await vfs.writeFile(`${CWD}/g1.txt`, 'x\nb');
      await vfs.writeFile(`${CWD}/g2.txt`, 'y\nb');

      const result = await git.execute(['diff', '--no-index', 'g1.txt', 'g2.txt'], CWD);

      expect(plain(result.stdout)).toBe(
        [
          'diff --git a/g1.txt b/g2.txt',
          '--- a/g1.txt',
          '+++ b/g2.txt',
          '@@ -1,2 +1,2 @@',
          '-x',
          '+y',
          ' b',
          '\\ No newline at end of file',
          '',
        ].join('\n')
      );
    });

    it('counts toward --stat', async () => {
      await vfs.writeFile(`${CWD}/f2.txt`, 'a\nb');

      const result = await git.execute(['diff', '--no-index', '--stat', 'd1.txt', 'f2.txt'], CWD);

      expect(plain(result.stdout)).toBe(
        [
          ' d1.txt => f2.txt |    3 +--',
          ' 1 file changed, 1 insertion(+), 2 deletions(-)',
          '',
        ].join('\n')
      );
    });
  });

  it('rejects anything other than exactly two paths', async () => {
    for (const args of [['d1.txt'], ['d1.txt', 'd2.txt', 'd1.txt']]) {
      const result = await git.execute(['diff', '--no-index', ...args], CWD);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('usage: git diff --no-index [<options>] <path> <path>\n');
      expect(result.exitCode).toBe(129);
    }
  });

  describe('directories', () => {
    beforeEach(async () => {
      await vfs.mkdir(`${CWD}/A/sub`, { recursive: true });
      await vfs.mkdir(`${CWD}/B/sub`, { recursive: true });
      await vfs.writeFile(`${CWD}/A/f1.txt`, 'a\nb\nc\n');
      await vfs.writeFile(`${CWD}/B/f1.txt`, 'a\nX\nc\n');
      await vfs.writeFile(`${CWD}/A/onlya.txt`, 'only-a\n');
      await vfs.writeFile(`${CWD}/B/onlyb.txt`, 'only-b\n');
      // Identical on both sides: git prints nothing for it.
      await vfs.writeFile(`${CWD}/A/sub/s.txt`, 'same\n');
      await vfs.writeFile(`${CWD}/B/sub/s.txt`, 'same\n');
    });

    it('walks both trees and renders adds, deletes, and modifications', async () => {
      const result = await git.execute(['diff', '--no-index', 'A', 'B'], CWD);

      expect(plain(result.stdout)).toBe(
        [
          'diff --git a/A/f1.txt b/B/f1.txt',
          '--- a/A/f1.txt',
          '+++ b/B/f1.txt',
          '@@ -1,3 +1,3 @@',
          ' a',
          '-b',
          '+X',
          ' c',
          'diff --git a/A/onlya.txt b/A/onlya.txt',
          '--- a/A/onlya.txt',
          '+++ /dev/null',
          '@@ -1 +0,0 @@',
          '-only-a',
          'diff --git a/B/onlyb.txt b/B/onlyb.txt',
          '--- /dev/null',
          '+++ b/B/onlyb.txt',
          '@@ -0,0 +1 @@',
          '+only-b',
          '',
        ].join('\n')
      );
      expect(result.exitCode).toBe(1);
    });

    it('--name-only prints /dev/null for a deletion', async () => {
      const result = await git.execute(['diff', '--no-index', '--name-only', 'A', 'B'], CWD);

      expect(result.stdout).toBe('B/f1.txt\n/dev/null\nB/onlyb.txt\n');
      expect(result.exitCode).toBe(1);
    });

    it('--stat compresses the shared path components', async () => {
      const result = await git.execute(['diff', '--no-index', '--stat', 'A', 'B'], CWD);

      expect(plain(result.stdout)).toBe(
        [
          ' {A => B}/f1.txt          |    2 +-',
          ' A/onlya.txt => /dev/null |    1 -',
          ' /dev/null => B/onlyb.txt |    1 +',
          ' 3 files changed, 2 insertions(+), 2 deletions(-)',
          '',
        ].join('\n')
      );
    });

    it('exits 0 for two identical trees', async () => {
      await vfs.mkdir(`${CWD}/C/sub`, { recursive: true });
      await vfs.writeFile(`${CWD}/C/s.txt`, 'same\n');
      await vfs.mkdir(`${CWD}/D/sub`, { recursive: true });
      await vfs.writeFile(`${CWD}/D/s.txt`, 'same\n');

      const result = await git.execute(['diff', '--no-index', 'C', 'D'], CWD);

      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('joins a directory operand with the other side’s basename', async () => {
      const result = await git.execute(['diff', '--no-index', 'A', 'B/f1.txt'], CWD);

      expect(plain(result.stdout)).toContain('diff --git a/A/f1.txt b/B/f1.txt');
      expect(result.exitCode).toBe(1);
    });

    it('reports the joined path when the directory has no such file', async () => {
      const result = await git.execute(['diff', '--no-index', 'd1.txt', 'A'], CWD);

      expect(result.stderr).toBe("error: Could not access 'A/d1.txt'\n");
      expect(result.exitCode).toBe(1);
    });
  });
});

describe('pprintRename', () => {
  it('brackets only the component that changed', () => {
    expect(pprintRename('A/f1.txt', 'B/f1.txt')).toBe('{A => B}/f1.txt');
    expect(pprintRename('x/y/f.txt', 'x/z/f.txt')).toBe('x/{y => z}/f.txt');
  });

  it('falls back to the full pair when no whole component is shared', () => {
    expect(pprintRename('d1.txt', 'd2.txt')).toBe('d1.txt => d2.txt');
    expect(pprintRename('A/onlya.txt', '/dev/null')).toBe('A/onlya.txt => /dev/null');
  });

  it('returns the path unchanged when both sides are equal', () => {
    expect(pprintRename('a/b.txt', 'a/b.txt')).toBe('a/b.txt');
  });
});
