/**
 * `patch` was advertised on the homepage and at /man/patch but answered 127
 * (#2819). These run the real shell over a real VirtualFS, because the whole
 * point of the command is that it edits files in the VFS.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import {
  PatchUsageError,
  parsePatchArgs,
} from '../../../src/shell/supplemental-commands/patch/args.js';
import {
  resolveTarget,
  stripComponents,
} from '../../../src/shell/supplemental-commands/patch/run.js';

let dbCounter = 0;
let vfs: VirtualFS;
let shell: AlmostBashShellHeadless;

const ORIGINAL = ['alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n';
const PATCH = [
  '--- a/note.txt',
  '+++ b/note.txt',
  '@@ -1,4 +1,4 @@',
  ' alpha',
  '-beta',
  '+BETA',
  ' gamma',
  ' delta',
  '',
].join('\n');

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `patch-cmd-${dbCounter++}`, wipe: true });
  await vfs.mkdir('/workspace', { recursive: true });
  await vfs.writeFile('/workspace/note.txt', ORIGINAL);
  await vfs.writeFile('/workspace/change.patch', PATCH);
  shell = new AlmostBashShellHeadless({ fs: vfs });
});

describe('patch registration', () => {
  it('is registered, so `patch` is not "command not found"', () => {
    expect(createSupplementalCommands().map((command) => command.name)).toContain('patch');
  });

  it('answers --version instead of 127', async () => {
    const result = await shell.executeCommand('patch --version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^patch \(SLICC\) \d/);
  });

  it('is listed by `commands` and found by `which`', async () => {
    expect((await shell.executeCommand('commands')).stdout).toContain('patch');
    const which = await shell.executeCommand('which patch');
    expect(which.exitCode).toBe(0);
    expect(which.stdout).toContain('patch');
  });
});

describe('patch — applying', () => {
  it('applies a patch piped on stdin', async () => {
    const result = await shell.executeCommand('cd /workspace && patch < change.patch');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('patching file note.txt');
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe(ORIGINAL.replace('beta', 'BETA'));
  });

  it('reads the patch from -i', async () => {
    const result = await shell.executeCommand('cd /workspace && patch -i change.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/note.txt')).toContain('BETA');
  });

  it('reads the patch from the second operand', async () => {
    const result = await shell.executeCommand('cd /workspace && patch note.txt change.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/note.txt')).toContain('BETA');
  });

  it('round-trips a diff this shell produced itself', async () => {
    await vfs.writeFile('/workspace/edited.txt', ORIGINAL.replace('gamma', 'GAMMA'));
    const result = await shell.executeCommand(
      'cd /workspace && diff -u note.txt edited.txt > d.patch; patch note.txt d.patch'
    );
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/note.txt')).toContain('GAMMA');
  });

  it('undoes itself with -R', async () => {
    await shell.executeCommand('cd /workspace && patch < change.patch');
    const result = await shell.executeCommand('cd /workspace && patch -R < change.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe(ORIGINAL);
  });

  it('writes nothing under --dry-run', async () => {
    const result = await shell.executeCommand('cd /workspace && patch --dry-run < change.patch');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('checking file note.txt');
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe(ORIGINAL);
  });

  it('says nothing on success under -s', async () => {
    const result = await shell.executeCommand('cd /workspace && patch -s < change.patch');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('strips leading components with -p1', async () => {
    await vfs.mkdir('/workspace/src', { recursive: true });
    await vfs.writeFile('/workspace/src/note.txt', ORIGINAL);
    await vfs.writeFile(
      '/workspace/deep.patch',
      PATCH.replace('a/note.txt', 'a/src/note.txt').replace('b/note.txt', 'b/src/note.txt')
    );
    const result = await shell.executeCommand('cd /workspace && patch -p1 < deep.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/src/note.txt')).toContain('BETA');
  });

  it('creates a file the patch adds', async () => {
    await vfs.writeFile(
      '/workspace/new.patch',
      ['--- /dev/null', '+++ b/added.txt', '@@ -0,0 +1,2 @@', '+first', '+second', ''].join('\n')
    );
    const result = await shell.executeCommand('cd /workspace && patch < new.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/added.txt')).toBe('first\nsecond\n');
  });

  it('removes a file the patch deletes', async () => {
    await vfs.writeFile('/workspace/gone.txt', 'bye\n');
    await vfs.writeFile(
      '/workspace/del.patch',
      ['--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', ''].join('\n')
    );
    const result = await shell.executeCommand('cd /workspace && patch < del.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.exists('/workspace/gone.txt')).toBe(false);
  });

  it('patches several files from one diff', async () => {
    await vfs.writeFile('/workspace/one.txt', 'one\n');
    await vfs.writeFile('/workspace/two.txt', 'two\n');
    await vfs.writeFile(
      '/workspace/multi.patch',
      [
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1 +1 @@',
        '-one',
        '+ONE',
        '--- a/two.txt',
        '+++ b/two.txt',
        '@@ -1 +1 @@',
        '-two',
        '+TWO',
        '',
      ].join('\n')
    );
    const result = await shell.executeCommand('cd /workspace && patch < multi.patch');
    expect(result.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/one.txt')).toBe('ONE\n');
    expect(await vfs.readTextFile('/workspace/two.txt')).toBe('TWO\n');
  });
});

describe('patch — failures', () => {
  it('rejects a hunk it cannot place, writes a .rej, and exits 1', async () => {
    await vfs.writeFile('/workspace/note.txt', 'nothing\nlike\nthe\npatch\n');
    const result = await shell.executeCommand('cd /workspace && patch < change.patch');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Hunk #1 FAILED');
    expect(result.stderr).toContain('saving rejects to file note.txt.rej');
    expect(await vfs.readTextFile('/workspace/note.txt.rej')).toContain('+BETA');
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe('nothing\nlike\nthe\npatch\n');
  });

  it('exits 2 when the target file does not exist', async () => {
    await vfs.rm('/workspace/note.txt');
    const result = await shell.executeCommand('cd /workspace && patch -p1 < change.patch');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("can't find file to patch");
  });

  it('exits 2 on input that holds no diff', async () => {
    const result = await shell.executeCommand('cd /workspace && echo hello | patch');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('garbage');
  });

  it('exits 2 on empty input rather than reporting success', async () => {
    const result = await shell.executeCommand("cd /workspace && printf '' | patch");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('empty patch input');
  });

  it('exits 2 on an unknown flag instead of treating it as a file name', async () => {
    const result = await shell.executeCommand('cd /workspace && patch --froward < change.patch');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unrecognized option '--froward'");
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe(ORIGINAL);
  });

  it('prints usage for --help without touching anything', async () => {
    const result = await shell.executeCommand('cd /workspace && patch --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: patch');
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe(ORIGINAL);
  });
});

describe('parsePatchArgs', () => {
  it('defaults to auto strip, fuzz 2, and no reversal', () => {
    expect(parsePatchArgs([])).toMatchObject({
      strip: null,
      fuzz: 2,
      reverse: false,
      dryRun: false,
      silent: false,
      mode: 'apply',
    });
  });

  it('accepts attached and detached values alike', () => {
    expect(parsePatchArgs(['-p1']).strip).toBe(1);
    expect(parsePatchArgs(['-p', '2']).strip).toBe(2);
    expect(parsePatchArgs(['--strip=3']).strip).toBe(3);
    expect(parsePatchArgs(['--strip', '4']).strip).toBe(4);
    expect(parsePatchArgs(['-F0']).fuzz).toBe(0);
    expect(parsePatchArgs(['--fuzz', '1']).fuzz).toBe(1);
    expect(parsePatchArgs(['-i', 'x.diff']).patchFile).toBe('x.diff');
    expect(parsePatchArgs(['--input=x.diff']).patchFile).toBe('x.diff');
  });

  it('bundles short boolean flags, as GNU patch does', () => {
    expect(parsePatchArgs(['-Rs'])).toMatchObject({ reverse: true, silent: true });
    expect(parsePatchArgs(['-sR'])).toMatchObject({ reverse: true, silent: true });
    expect(parsePatchArgs(['-R', '-s'])).toMatchObject({ reverse: true, silent: true });
  });

  it('lets a value flag take the rest of its cluster, or the next argument', () => {
    expect(parsePatchArgs(['-Rp1'])).toMatchObject({ reverse: true, strip: 1 });
    expect(parsePatchArgs(['-sp', '2'])).toMatchObject({ silent: true, strip: 2 });
    expect(parsePatchArgs(['-si', 'x.diff'])).toMatchObject({ silent: true, patchFile: 'x.diff' });
  });

  it('answers help from inside a bundle', () => {
    expect(parsePatchArgs(['-sh']).mode).toBe('help');
  });

  it('rejects a bundle containing an unknown letter', () => {
    expect(() => parsePatchArgs(['-Rz'])).toThrow(/unrecognized option '-z'/);
  });

  it('reads the two operands as FILE and PATCHFILE', () => {
    expect(parsePatchArgs(['note.txt', 'change.patch'])).toMatchObject({
      originalFile: 'note.txt',
      patchFile: 'change.patch',
    });
  });

  it('stops flag parsing at --', () => {
    expect(parsePatchArgs(['--', '-weird-name']).originalFile).toBe('-weird-name');
  });

  it('refuses a negative or non-numeric -p', () => {
    expect(() => parsePatchArgs(['-p', 'x'])).toThrow(PatchUsageError);
    expect(() => parsePatchArgs(['-p', '-1'])).toThrow(PatchUsageError);
  });

  it('refuses a flag that needs a value and has none', () => {
    expect(() => parsePatchArgs(['-i'])).toThrow(PatchUsageError);
    expect(() => parsePatchArgs(['--strip'])).toThrow(PatchUsageError);
  });

  it('refuses a third operand', () => {
    expect(() => parsePatchArgs(['a', 'b', 'c'])).toThrow(PatchUsageError);
  });
});

describe('stripComponents', () => {
  it('drops the requested number of leading components', () => {
    expect(stripComponents('a/src/x.ts', 1)).toBe('src/x.ts');
    expect(stripComponents('a/src/x.ts', 0)).toBe('a/src/x.ts');
    expect(stripComponents('/a/src/x.ts', 1)).toBe('src/x.ts');
  });

  it('returns null when there are not enough components, or for /dev/null', () => {
    expect(stripComponents('x.ts', 1)).toBeNull();
    expect(stripComponents('/dev/null', 0)).toBeNull();
  });
});

describe('resolveTarget', () => {
  const patch = { oldName: 'a/src/x.ts', newName: 'b/src/x.ts', hunks: [] };

  it('prefers a candidate that exists on disk', async () => {
    const target = await resolveTarget(patch, null, {
      exists: async (path) => path === '/w/src/x.ts',
      resolve: (path) => `/w/${path}`,
    });
    expect(target).toBe('src/x.ts');
  });

  it('falls back to a candidate whose parent directory exists', async () => {
    const created = { oldName: '/dev/null', newName: 'b/src/new.ts', hunks: [] };
    const target = await resolveTarget(created, null, {
      exists: async (path) => path === '/w/src',
      resolve: (path) => `/w/${path}`,
    });
    expect(target).toBe('src/new.ts');
  });

  it('falls back to the basename when nothing matches', async () => {
    const target = await resolveTarget(patch, null, {
      exists: async () => false,
      resolve: (path) => `/w/${path}`,
    });
    expect(target).toBe('x.ts');
  });

  it('uses the deletion side when the patch removes a file', async () => {
    const deleted = { oldName: 'a/gone.txt', newName: '/dev/null', hunks: [] };
    const target = await resolveTarget(deleted, 1, {
      exists: async () => false,
      resolve: (path) => `/w/${path}`,
    });
    expect(target).toBe('gone.txt');
  });
});
