import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

const BASE = 'line1\nline2\nline3\n';

describe('git merge-file', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `merge-file-test-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `merge-file-global-${testId}`,
    });
  });

  async function seed(current: string, base = BASE, other = BASE) {
    await vfs.writeFile('/cur', current);
    await vfs.writeFile('/base', base);
    await vfs.writeFile('/other', other);
  }

  it('auto-merges disjoint changes and overwrites <current> (exit 0)', async () => {
    await seed('CUR1\nline2\nline3\n', BASE, 'line1\nline2\nOTH3\n');
    const res = await git.execute(['merge-file', '/cur', '/base', '/other'], '/');
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe('');
    expect(await vfs.readTextFile('/cur')).toBe('CUR1\nline2\nOTH3\n');
  });

  it('produces conflict markers and exits with the conflict count', async () => {
    await seed('line1\nOURS2\nline3\n', BASE, 'line1\nTHEIRS2\nline3\n');
    const res = await git.execute(['merge-file', '/cur', '/base', '/other'], '/');
    expect(res.exitCode).toBe(1);
    const merged = await vfs.readTextFile('/cur');
    expect(merged).toContain('<<<<<<< /cur');
    expect(merged).toContain('=======');
    expect(merged).toContain('>>>>>>> /other');
    expect(merged).toContain('OURS2');
    expect(merged).toContain('THEIRS2');
    expect(res.stderr).toContain('warning');
  });

  it('--stdout prints the result and leaves <current> untouched', async () => {
    await seed('CUR1\nline2\nline3\n', BASE, 'line1\nline2\nOTH3\n');
    const res = await git.execute(['merge-file', '--stdout', '/cur', '/base', '/other'], '/');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('CUR1\nline2\nOTH3\n');
    expect(await vfs.readTextFile('/cur')).toBe('CUR1\nline2\nline3\n');
  });

  it('-p is an alias for --stdout', async () => {
    await seed('CUR1\nline2\nline3\n', BASE, 'line1\nline2\nOTH3\n');
    const res = await git.execute(['merge-file', '-p', '/cur', '/base', '/other'], '/');
    expect(res.stdout).toBe('CUR1\nline2\nOTH3\n');
    expect(await vfs.readTextFile('/cur')).toBe('CUR1\nline2\nline3\n');
  });

  it('-q / --quiet suppresses the conflict warning', async () => {
    await seed('line1\nOURS2\nline3\n', BASE, 'line1\nTHEIRS2\nline3\n');
    const res = await git.execute(['merge-file', '-q', '/cur', '/base', '/other'], '/');
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe('');
  });

  it('-L relabels the conflict markers (up to 3)', async () => {
    await seed('line1\nOURS2\nline3\n', BASE, 'line1\nTHEIRS2\nline3\n');
    const res = await git.execute(
      [
        'merge-file',
        '-p',
        '-L',
        'MINE',
        '-L',
        'ANCESTOR',
        '-L',
        'YOURS',
        '/cur',
        '/base',
        '/other',
      ],
      '/'
    );
    expect(res.stdout).toContain('<<<<<<< MINE');
    expect(res.stdout).toContain('>>>>>>> YOURS');
  });

  it('--diff3 includes the base section', async () => {
    await seed('line1\nOURS2\nline3\n', BASE, 'line1\nTHEIRS2\nline3\n');
    const res = await git.execute(['merge-file', '-p', '--diff3', '/cur', '/base', '/other'], '/');
    expect(res.stdout).toContain('||||||| /base');
    expect(res.stdout).toContain('line2');
  });

  it('--ours / --theirs / --union resolve without markers', async () => {
    const other = 'line1\nTHEIRS2\nline3\n';
    const ours = 'line1\nOURS2\nline3\n';

    await seed(ours, BASE, other);
    let res = await git.execute(['merge-file', '-p', '--ours', '/cur', '/base', '/other'], '/');
    expect(res.stdout).toBe(ours);
    expect(res.stdout).not.toContain('<<<<<<<');

    await seed(ours, BASE, other);
    res = await git.execute(['merge-file', '-p', '--theirs', '/cur', '/base', '/other'], '/');
    expect(res.stdout).toBe(other);

    await seed(ours, BASE, other);
    res = await git.execute(['merge-file', '-p', '--union', '/cur', '/base', '/other'], '/');
    expect(res.stdout).toContain('OURS2');
    expect(res.stdout).toContain('THEIRS2');
    expect(res.stdout).not.toContain('<<<<<<<');
  });

  it('errors with usage on wrong positional count (exit 255)', async () => {
    await seed(BASE);
    const res = await git.execute(['merge-file', '/cur', '/base'], '/');
    expect(res.exitCode).toBe(255);
    expect(res.stderr).toContain('usage:');
  });

  it('errors (exit 255) when a file is unreadable', async () => {
    await seed(BASE);
    const res = await git.execute(['merge-file', '/cur', '/base', '/missing'], '/');
    expect(res.exitCode).toBe(255);
    expect(res.stderr).toContain('error:');
  });

  it('errors (exit 255) with more than 3 -L labels', async () => {
    await seed(BASE);
    const res = await git.execute(
      ['merge-file', '-L', 'a', '-L', 'b', '-L', 'c', '-L', 'd', '/cur', '/base', '/other'],
      '/'
    );
    expect(res.exitCode).toBe(255);
    expect(res.stderr).toContain('too many labels');
  });

  it('git merge-file --help short-circuits without touching files', async () => {
    const res = await git.execute(['merge-file', '--help'], '/');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('merge-file');
  });
});
