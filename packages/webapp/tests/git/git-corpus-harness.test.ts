/**
 * Corpus-driven harness for the `git` supplemental command.
 *
 * Encodes the EXPECTED behaviour for every subcommand harvested from the
 * real-world tool-call catalogue (1,568 invocations across ~212 sessions)
 * plus the five regressions from issue #1033. Cases that currently fail are
 * the intended TDD red-phase bug inventory for the follow-up fix task.
 *
 * Offline only — clone/fetch/push assertions spy on isomorphic-git to verify
 * arg parsing without touching the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

// Wrap isomorphic-git so spies can rewire exports (the ESM namespace is frozen).
vi.mock('isomorphic-git', async (importOriginal) => ({ ...(await importOriginal()) }));

import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

let vfs: VirtualFS;
let git: GitCommands;
let dbCounter = 0;

beforeEach(async () => {
  const testId = dbCounter++;
  vfs = await VirtualFS.create({ dbName: `git-corpus-${testId}`, wipe: true });
  git = new GitCommands({
    fs: vfs,
    authorName: 'Corpus User',
    authorEmail: 'corpus@example.com',
    globalDbName: `git-corpus-global-${testId}`,
  });
});

/** Seed a fresh repo with one committed file so subcommands have history. */
async function seedRepo(dir = '/project'): Promise<void> {
  await git.execute(['init'], dir);
  await vfs.writeFile(`${dir}/file.txt`, 'line1\nline2\nline3\n');
  await git.execute(['add', 'file.txt'], dir);
  await git.execute(['commit', '-m', 'initial'], dir);
}

// ---------------------------------------------------------------------------
// Catalogue: each catalogued subcommand must NOT fall through to the default
// "not a git command" branch. Concrete behaviour assertions for the common
// flag combinations follow per-section.
// ---------------------------------------------------------------------------

describe('git corpus — subcommand catalogue (offline arg-parsing)', () => {
  it('init -b <branch> sets the default branch', async () => {
    const result = await git.execute(['init', '-b', 'main'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized empty Git repository');
  });

  it('add accepts pathspec, ".", and -A', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/a.txt', 'a');
    await vfs.writeFile('/project/b.txt', 'b');
    expect((await git.execute(['add', 'a.txt'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['add', '.'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['add', '-A'], '/project')).exitCode).toBe(0);
  });

  it('status accepts --short / --porcelain / -s', async () => {
    await git.execute(['init'], '/project');
    for (const flag of ['--short', '--porcelain', '-s']) {
      const r = await git.execute(['status', flag], '/project');
      expect(r.exitCode, `status ${flag}`).toBe(0);
    }
  });

  it('commit accepts -m / -qm / --allow-empty', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const r = await git.execute(['commit', '-m', 'msg'], '/project');
    expect(r.exitCode).toBe(0);
  });

  it('log accepts --oneline, --format, and -n', async () => {
    await seedRepo('/project');
    expect((await git.execute(['log', '--oneline'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['log', '--format', '%H'], '/project')).exitCode).toBe(0);
  });

  it('branch list / create / delete', async () => {
    await seedRepo('/project');
    expect((await git.execute(['branch', 'feature'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['branch'], '/project')).stdout).toContain('feature');
  });

  it('checkout switches branches and accepts -b', async () => {
    await seedRepo('/project');
    expect((await git.execute(['checkout', '-b', 'feat'], '/project')).exitCode).toBe(0);
  });

  it('diff accepts --stat / --name-only / --cached', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    expect((await git.execute(['diff'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['diff', '--name-only'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['diff', '--stat'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['diff', '--cached'], '/project')).exitCode).toBe(0);
  });

  it('show accepts <ref> and <ref>:<path>', async () => {
    await seedRepo('/project');
    const head = (await git.execute(['log', '--format', '%H', '-1'], '/project')).stdout.trim();
    expect((await git.execute(['show', head], '/project')).exitCode).toBe(0);
    expect((await git.execute(['show', `${head}:file.txt`], '/project')).exitCode).toBe(0);
  });

  it('remote -v and add', async () => {
    await seedRepo('/project');
    expect(
      (await git.execute(['remote', 'add', 'origin', 'https://example.com/x.git'], '/project'))
        .exitCode
    ).toBe(0);
    expect((await git.execute(['remote', '-v'], '/project')).exitCode).toBe(0);
  });

  it('config get/set works', async () => {
    await git.execute(['init'], '/project');
    await git.execute(['config', 'user.name', 'Alice'], '/project');
    const r = await git.execute(['config', 'user.name'], '/project');
    expect(r.stdout.trim()).toBe('Alice');
  });

  it('rev-parse --show-toplevel / --abbrev-ref HEAD', async () => {
    await seedRepo('/project');
    expect((await git.execute(['rev-parse', '--show-toplevel'], '/project')).stdout).toContain(
      '/project'
    );
    expect((await git.execute(['rev-parse', '--abbrev-ref', 'HEAD'], '/project')).exitCode).toBe(0);
  });

  it('tag list / create', async () => {
    await seedRepo('/project');
    expect((await git.execute(['tag', 'v1'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['tag'], '/project')).stdout).toContain('v1');
  });

  it('ls-files lists tracked files', async () => {
    await seedRepo('/project');
    expect((await git.execute(['ls-files'], '/project')).stdout).toContain('file.txt');
  });

  it('stash list works on a clean repo', async () => {
    await seedRepo('/project');
    expect((await git.execute(['stash', 'list'], '/project')).exitCode).toBe(0);
  });

  it('rm removes a tracked file', async () => {
    await seedRepo('/project');
    expect((await git.execute(['rm', 'file.txt'], '/project')).exitCode).toBe(0);
  });

  it('mv renames a tracked file', async () => {
    await seedRepo('/project');
    expect((await git.execute(['mv', 'file.txt', 'renamed.txt'], '/project')).exitCode).toBe(0);
  });

  it('reset unstages by default', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    expect((await git.execute(['reset'], '/project')).exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #1033 — explicit regression cases. Each one documents the EXPECTED
// behaviour; tests that fail here are the bug inventory for the fix task.
// ---------------------------------------------------------------------------

describe('git corpus — issue #1033 regressions', () => {
  // #1033-2 — global `-c <key>=<val>` config override must be recognized.
  it('#1033-2: git -c user.email=x@y.z commit ... is accepted (not "not a git command")', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'user.email=override@example.com', 'commit', '-m', 'msg'],
      '/project'
    );
    expect(result.stderr).not.toContain('is not a git command');
    expect(result.exitCode).toBe(0);
  });

  // #1033 (catalogue) — `-C <dir>` must run the subcommand in <dir>.
  it('#1033-C: git -C <dir> status runs in <dir>', async () => {
    await seedRepo('/project');
    // Invoke from a different cwd; -C should redirect.
    const result = await git.execute(['-C', '/project', 'status'], '/');
    expect(result.stderr).not.toContain('is not a git command');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('On branch');
  });

  // #1033 (catalogue) — `--no-pager` global flag must be a no-op.
  it('#1033-nopager: git --no-pager diff works like git diff', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed line\n');
    const result = await git.execute(['--no-pager', 'diff'], '/project');
    expect(result.stderr).not.toContain('is not a git command');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('diff --git');
  });

  // #1033-3 — `fetch --depth 1 origin main` must parse remote=`origin`,
  //           not the `1` value of `--depth`, AND the positional ref must
  //           round-trip through to isomorphic-git.
  it('#1033-3: git fetch --depth 1 origin main parses remote=origin AND ref=main', async () => {
    await git.execute(['init'], '/project');
    await git.execute(['remote', 'add', 'origin', 'https://example.com/x.git'], '/project');
    const fetchSpy = vi.spyOn(isoGit, 'fetch').mockResolvedValue({
      defaultBranch: 'main',
      fetchHead: null,
      fetchHeadDescription: null,
      headers: undefined,
      pruned: undefined,
    } as Awaited<ReturnType<typeof isoGit.fetch>>);
    try {
      const result = await git.execute(['fetch', '--depth', '1', 'origin', 'main'], '/project');
      expect(result.exitCode).toBe(0);
      expect(fetchSpy).toHaveBeenCalled();
      const call = fetchSpy.mock.calls[0]?.[0] as {
        remote?: string;
        ref?: string;
        depth?: number;
      };
      expect(call?.remote).toBe('origin');
      expect(call?.ref).toBe('main');
      expect(call?.depth).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // #1033-4 — `git fetch --help` (and checkout/clone --help) print help and
  //           NEVER execute a network/FS action.
  it('#1033-4: git fetch --help returns help text and performs NO fetch', async () => {
    const fetchSpy = vi
      .spyOn(isoGit, 'fetch')
      .mockResolvedValue({} as Awaited<ReturnType<typeof isoGit.fetch>>);
    try {
      const result = await git.execute(['fetch', '--help'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('fetch');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('#1033-4: git checkout --help returns help text and performs NO checkout', async () => {
    const checkoutSpy = vi.spyOn(isoGit, 'checkout').mockResolvedValue(undefined);
    const branchSpy = vi.spyOn(isoGit, 'branch').mockResolvedValue(undefined);
    try {
      const result = await git.execute(['checkout', '--help'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('checkout');
      expect(checkoutSpy).not.toHaveBeenCalled();
      expect(branchSpy).not.toHaveBeenCalled();
    } finally {
      checkoutSpy.mockRestore();
      branchSpy.mockRestore();
    }
  });

  it('#1033-4: git clone --help returns help text and performs NO clone', async () => {
    const cloneSpy = vi.spyOn(isoGit, 'clone').mockResolvedValue();
    try {
      const result = await git.execute(['clone', '--help'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('clone');
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  // #1033-5 — successful `checkout <branch>` must not leak isomorphic-git's
  //           "There are multiple errors..." MultipleGitError cosmetic noise.
  it('#1033-5: git checkout <branch> success produces no "multiple errors" stderr noise', async () => {
    await seedRepo('/project');
    await git.execute(['branch', 'feature'], '/project');
    const result = await git.execute(['checkout', 'feature'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toLowerCase()).not.toContain('multiple errors');
    expect(result.stdout).toContain("Switched to branch 'feature'");
  });

  // #1033-1 — clone failure into a nested/non-existent target dir must
  //           surface the real interpolated path, never the literal `<path>`
  //           placeholder, and must return a non-zero exitCode rather than
  //           throwing an unhandled rejection.
  it('#1033-1: git clone failure surfaces the real path, never literal "<path>"', async () => {
    const targetDir = '/non/existent/parent/myrepo';
    const cloneSpy = vi
      .spyOn(isoGit, 'clone')
      .mockRejectedValue(
        new Error("ENOENT: no such file or directory, mkdir '/__opfs__/slicc-fs<path>'")
      );
    try {
      const result = await git.execute(
        ['clone', 'https://github.com/example/repo.git', targetDir],
        '/workspace'
      );
      // Expected: handled error → non-zero exit with a real path in stderr.
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain('<path>');
      expect(result.stderr).toContain(targetDir);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  // #1033-5 (real repro) — when isomorphic-git throws MultipleGitError
  // (e.g. a dirty/conflicting working tree), the wrapper must NOT pass the
  // cosmetic "There are multiple errors..." message through. It must surface
  // each underlying per-file failure so the user can act on them.
  it('#1033-5: checkout MultipleGitError surfaces underlying errors, never the cosmetic noise', async () => {
    await seedRepo('/project');
    class FakeMultipleGitError extends Error {
      override name = 'MultipleGitError';
      errors: Error[];
      data: { errors: Error[] };
      constructor(errs: Error[]) {
        super('There are multiple errors that were thrown by the program');
        this.errors = errs;
        this.data = { errors: errs };
      }
    }
    const innerA = new Error("workdir contains uncommitted changes to 'a.txt'");
    const innerB = new Error("workdir contains uncommitted changes to 'b.txt'");
    const checkoutSpy = vi
      .spyOn(isoGit, 'checkout')
      .mockRejectedValue(new FakeMultipleGitError([innerA, innerB]));
    try {
      const result = await git.execute(['checkout', 'feature'], '/project');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).not.toContain('multiple errors');
      expect(result.stderr).toContain('a.txt');
      expect(result.stderr).toContain('b.txt');
      expect(result.stderr).toContain("checkout 'feature'");
    } finally {
      checkoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// push / pull — high-frequency in the catalogue, missing from the original
// harness. Offline-only: spies replace isomorphic-git so no network occurs.
// ---------------------------------------------------------------------------

describe('git corpus — push / pull offline arg-parsing', () => {
  it('push -u origin <branch> sends remote+ref through to isomorphic-git', async () => {
    await seedRepo('/project');
    await git.execute(['remote', 'add', 'origin', 'https://example.com/x.git'], '/project');
    const pushSpy = vi
      .spyOn(isoGit, 'push')
      .mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof isoGit.push>>);
    try {
      const result = await git.execute(['push', '-u', 'origin', 'main'], '/project');
      expect(result.exitCode).toBe(0);
      expect(pushSpy).toHaveBeenCalled();
      const call = pushSpy.mock.calls[0]?.[0] as {
        remote?: string;
        ref?: string;
        force?: boolean;
      };
      expect(call?.remote).toBe('origin');
      expect(call?.ref).toBe('main');
      expect(call?.force).toBe(false);
    } finally {
      pushSpy.mockRestore();
    }
  });

  it('push --help short-circuits BEFORE any push side effect', async () => {
    const pushSpy = vi
      .spyOn(isoGit, 'push')
      .mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof isoGit.push>>);
    try {
      const result = await git.execute(['push', '--help'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('push');
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      pushSpy.mockRestore();
    }
  });

  it('pull --ff-only origin <branch> sends remote+ref+fastForwardOnly through', async () => {
    await seedRepo('/project');
    await git.execute(['remote', 'add', 'origin', 'https://example.com/x.git'], '/project');
    const pullSpy = vi.spyOn(isoGit, 'pull').mockResolvedValue(undefined);
    try {
      const result = await git.execute(['pull', '--ff-only', 'origin', 'main'], '/project');
      expect(result.exitCode).toBe(0);
      expect(pullSpy).toHaveBeenCalled();
      const call = pullSpy.mock.calls[0]?.[0] as {
        remote?: string;
        ref?: string;
        fastForwardOnly?: boolean;
      };
      expect(call?.remote).toBe('origin');
      expect(call?.ref).toBe('main');
      expect(call?.fastForwardOnly).toBe(true);
    } finally {
      pullSpy.mockRestore();
    }
  });

  it('pull --help short-circuits BEFORE any pull side effect', async () => {
    const pullSpy = vi.spyOn(isoGit, 'pull').mockResolvedValue(undefined);
    try {
      const result = await git.execute(['pull', '--help'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('pull');
      expect(pullSpy).not.toHaveBeenCalled();
    } finally {
      pullSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// `git -c <key>=<val>` config overrides — values from the catalogue allowlist
// (user.email, user.name, init.defaultBranch, commit.gpgsign) must take
// effect for the single invocation. Unknown keys remain accepted no-ops.
// ---------------------------------------------------------------------------

describe('git corpus — -c <key>=<val> config overrides take effect', () => {
  // Verify via `git log --format` (which already reads back the persisted
  // commit object via isomorphic-git) instead of round-tripping through a
  // second isomorphic-git client — that keeps the test surface aligned with
  // the real shell-user verification path.
  const headEmail = async (dir: string): Promise<string> =>
    (await git.execute(['log', '--format', '%ae', '-n', '1'], dir)).stdout.trim();
  const headName = async (dir: string): Promise<string> =>
    (await git.execute(['log', '--format', '%an', '-n', '1'], dir)).stdout.trim();

  it('-c user.email overrides the author email used by commit', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'user.email=override@example.com', 'commit', '-m', 'override email'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(await headEmail('/project')).toBe('override@example.com');
    // Name falls back to the default since only email was overridden.
    expect(await headName('/project')).toBe('Corpus User');
  });

  it('-c user.name overrides the author name used by commit', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'user.name=Override Name', 'commit', '-m', 'override name'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(await headName('/project')).toBe('Override Name');
    expect(await headEmail('/project')).toBe('corpus@example.com');
  });

  it('multiple -c flags compose: user.name + user.email both apply', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '-m', 'both'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(await headName('/project')).toBe('Alice');
    expect(await headEmail('/project')).toBe('alice@example.com');
  });

  it('-c init.defaultBranch overrides the default branch used by init', async () => {
    const result = await git.execute(['-c', 'init.defaultBranch=trunk', 'init'], '/proj-trunk');
    expect(result.exitCode).toBe(0);
    const headRef = await vfs.readTextFile('/proj-trunk/.git/HEAD');
    expect(headRef.trim()).toBe('ref: refs/heads/trunk');
  });

  it('explicit --initial-branch wins over -c init.defaultBranch', async () => {
    const result = await git.execute(
      ['-c', 'init.defaultBranch=trunk', 'init', '-b', 'develop'],
      '/proj-explicit'
    );
    expect(result.exitCode).toBe(0);
    const headRef = await vfs.readTextFile('/proj-explicit/.git/HEAD');
    expect(headRef.trim()).toBe('ref: refs/heads/develop');
  });

  it('-c commit.gpgsign=false is accepted and is a safe no-op (we do not sign)', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'unsigned'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('is not a git command');
    // Identity remains the default — gpgsign is a no-op, not an identity override.
    expect(await headEmail('/project')).toBe('corpus@example.com');
  });

  it('unknown -c keys remain accepted no-ops (preserves prior behavior)', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'totally.unknown.key=whatever', 'commit', '-m', 'msg'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('is not a git command');
    expect(await headEmail('/project')).toBe('corpus@example.com');
  });

  it('overrides do not leak across invocations: next commit uses the default identity', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'first\n');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(
      ['-c', 'user.email=ephemeral@example.com', 'commit', '-m', 'with override'],
      '/project'
    );
    expect(await headEmail('/project')).toBe('ephemeral@example.com');

    await vfs.writeFile('/project/file.txt', 'second\n');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'no override'], '/project');
    expect(await headEmail('/project')).toBe('corpus@example.com');
  });

  // #1047 review (Minor) — real git lowercases `-c` section + variable names,
  // so `-c USER.email=…` / `-c User.Name=…` / `-c Init.DefaultBranch=…` must
  // resolve against the same allowlist as the lowercase forms.
  it('-c USER.email (uppercase section) overrides the commit author email', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'USER.email=upper@example.com', 'commit', '-m', 'upper section'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(await headEmail('/project')).toBe('upper@example.com');
  });

  it('-c User.Name (mixed case) overrides the commit author name', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    const result = await git.execute(
      ['-c', 'User.Name=Mixed Case', 'commit', '-m', 'mixed name'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(await headName('/project')).toBe('Mixed Case');
  });

  it('-c Init.DefaultBranch (mixed case) overrides the init default branch', async () => {
    const result = await git.execute(
      ['-c', 'Init.DefaultBranch=mainline', 'init'],
      '/proj-mixed-init'
    );
    expect(result.exitCode).toBe(0);
    const headRef = await vfs.readTextFile('/proj-mixed-init/.git/HEAD');
    expect(headRef.trim()).toBe('ref: refs/heads/mainline');
  });
});

// ---------------------------------------------------------------------------
// #1047 review (Major) — per-subcommand `--help` / `-h` short-circuit must be
// position-aware: only treat it as help when it appears as an UNCONSUMED flag,
// not when it is the VALUE of a preceding flag or follows a `--` separator.
// ---------------------------------------------------------------------------

describe('git corpus — #1047 position-aware --help short-circuit', () => {
  it('git log --grep --help filters the log (--help is the grep pattern, not a help request)', async () => {
    await seedRepo('/project');
    // Make a second commit whose message will match the literal "--help" pattern
    // so we can prove the grep ran rather than the help intercept firing.
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'mentions --help in the body'], '/project');

    const result = await git.execute(['log', '--grep', '--help', '--oneline'], '/project');
    expect(result.exitCode).toBe(0);
    // Real log output is a single line per commit; the help banner lists
    // multiple subcommands and would NOT mention the commit subject.
    expect(result.stdout).toContain('mentions --help');
    expect(result.stdout.toLowerCase()).not.toContain('available commands');
  });

  it('git commit -m --help commits with "--help" as the literal message', async () => {
    await seedRepo('/project');
    await vfs.writeFile('/project/file.txt', 'changed\n');
    await git.execute(['add', 'file.txt'], '/project');

    const result = await git.execute(['commit', '-m', '--help'], '/project');
    expect(result.exitCode).toBe(0);
    // Commit summary line includes the literal message, not the help banner.
    expect(result.stdout).toContain('--help');
    expect(result.stdout.toLowerCase()).not.toContain('available commands');

    // The commit landed with that exact message.
    const subject = (
      await git.execute(['log', '--format', '%s', '-n', '1'], '/project')
    ).stdout.trim();
    expect(subject).toBe('--help');
  });

  it('git checkout -- --help routes to file restoration (no help banner, no branch switch)', async () => {
    await seedRepo('/project');

    // `checkoutFiles` is the file-restoration path; `isoGit.checkout` is the
    // branch-switch path. Spy on the branch-switch path to prove the help
    // intercept didn't fire AND the branch-switch path wasn't taken either.
    // The actual restoration of the missing `--help` file will surface a
    // fatal-not-found from `git.readBlob` — that's fine, we only assert the
    // help banner is absent.
    const checkoutSpy = vi.spyOn(isoGit, 'checkout').mockResolvedValue(undefined);
    try {
      const result = await git.execute(['checkout', '--', '--help'], '/project');
      expect(result.stdout.toLowerCase()).not.toContain('available commands');
      expect(checkoutSpy).not.toHaveBeenCalled();
    } finally {
      checkoutSpy.mockRestore();
    }
  });

  it('bare git fetch --help still short-circuits BEFORE any network side effect (#1033-4 stays green)', async () => {
    const fetchSpy = vi
      .spyOn(isoGit, 'fetch')
      .mockResolvedValue({} as Awaited<ReturnType<typeof isoGit.fetch>>);
    try {
      const result = await git.execute(['fetch', '--help'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain('fetch');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
