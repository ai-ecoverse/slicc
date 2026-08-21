/**
 * Tests for the `mktemp` overlay (#2267), ported from
 * [vercel-labs/just-bash#377](https://github.com/vercel-labs/just-bash/pull/377).
 *
 * The assertions track upstream's, because the point of the port is that
 * deleting this overlay when the builtin lands changes nothing a caller sees.
 * Two of them are ours: the default directory comes from `scratchDir`, so it
 * follows this runtime's per-unit `$TMPDIR` pin, and creation is
 * probe-then-create rather than atomic, so the mode is applied by a separate
 * `chmod` that must take the entry back when it fails.
 *
 * See `mktemp-builtin-tripwire.test.ts` for the guard that fails once the
 * builtin exists.
 */

import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createMktempCommand } from '../../../src/shell/supplemental-commands/mktemp-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

interface FakeFsSeed {
  files?: string[];
  dirs?: string[];
  /** Names occupied by a symlink — including dangling ones, which `stat` misses. */
  links?: string[];
  /** Fail `chmod` on any path, to exercise the take-it-back branch. */
  chmodFails?: boolean;
}

function errno(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code });
}

/**
 * A normalizing `resolvePath`, because the command asks for the parent of a
 * relative template as `resolvePath(cwd, '.')`. The shared mock's default
 * concatenates, producing `/workspace/.`, which no stub recognises as a
 * directory — the real VFS collapses it.
 */
function resolvePath(base: string, path: string): string {
  const segments = (path.startsWith('/') ? path : `${base}/${path}`).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

function fakeFs(seed: FakeFsSeed = {}) {
  const files = new Set(seed.files ?? []);
  const dirs = new Set(['/', '/tmp', '/workspace', ...(seed.dirs ?? [])]);
  const links = new Set(seed.links ?? []);
  const modes = new Map<string, number>();
  const removed: string[] = [];

  const fs: Partial<IFileSystem> = {
    resolvePath,
    lstat: vi.fn(async (path: string) => {
      if (links.has(path)) return { isDirectory: false, isSymbolicLink: true };
      if (dirs.has(path)) return { isDirectory: true, isSymbolicLink: false };
      if (files.has(path)) return { isDirectory: false, isSymbolicLink: false };
      throw errno('ENOENT', 'lstat', path);
    }) as unknown as IFileSystem['lstat'],
    stat: vi.fn(async (path: string) => {
      if (dirs.has(path)) return { isDirectory: true, isSymbolicLink: false };
      if (files.has(path)) return { isDirectory: false, isSymbolicLink: false };
      throw errno('ENOENT', 'stat', path);
    }) as unknown as IFileSystem['stat'],
    writeFile: vi.fn(async (path: string) => {
      files.add(path);
    }) as unknown as IFileSystem['writeFile'],
    mkdir: vi.fn(async (path: string) => {
      dirs.add(path);
    }) as unknown as IFileSystem['mkdir'],
    chmod: vi.fn(async (path: string, mode: number) => {
      if (seed.chmodFails) throw errno('EPERM', 'chmod', path);
      modes.set(path, mode);
    }) as unknown as IFileSystem['chmod'],
    rm: vi.fn(async (path: string) => {
      removed.push(path);
      files.delete(path);
      dirs.delete(path);
    }) as unknown as IFileSystem['rm'],
  };

  return { fs, files, dirs, links, modes, removed };
}

async function run(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; seed?: FakeFsSeed } = {}
) {
  const harness = fakeFs(options.seed);
  const ctx = mockCommandContext({
    cwd: options.cwd ?? '/workspace',
    env: new Map(Object.entries(options.env ?? {})),
    fs: harness.fs,
  });
  const result = await createMktempCommand().execute(args, ctx);
  return { ...harness, result, path: result.stdout.trim() };
}

describe('mktemp command', () => {
  describe('the default directory', () => {
    it('creates an empty file under /tmp and prints its absolute path', async () => {
      const { result, path, files } = await run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(path).toMatch(/^\/tmp\/tmp\.[0-9A-Za-z]{10}$/);
      expect(files.has(path)).toBe(true);
    });

    it('prefers the per-unit $TMPDIR pin over the /tmp fallback', async () => {
      const { path } = await run([], {
        env: { TMPDIR: '/tmp/cone/research' },
        seed: { dirs: ['/tmp/cone/research'] },
      });
      expect(path).toMatch(/^\/tmp\/cone\/research\/tmp\.[0-9A-Za-z]{10}$/);
    });

    it('treats a blank $TMPDIR as no opinion rather than as a directory', async () => {
      const { path } = await run([], { env: { TMPDIR: '  ' } });
      expect(path).toMatch(/^\/tmp\/tmp\./);
    });

    it('draws each name independently', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) seen.add((await run([])).path);
      expect(seen.size).toBe(20);
    });
  });

  describe('what gets created', () => {
    it('creates a file at mode 0600', async () => {
      const { path, modes, files } = await run([]);
      expect(files.has(path)).toBe(true);
      expect(modes.get(path)).toBe(0o600);
    });

    it('creates a directory at mode 0700 with -d', async () => {
      const { path, modes, dirs } = await run(['-d']);
      expect(dirs.has(path)).toBe(true);
      expect(modes.get(path)).toBe(0o700);
    });

    it('accepts --directory as well as -d', async () => {
      const { path, dirs } = await run(['--directory']);
      expect(dirs.has(path)).toBe(true);
    });

    it('takes the entry back when the mode cannot be applied', async () => {
      // A path returned as private but left readable is the failure mode this
      // command exists to avoid, so a failing chmod must not print a path.
      const { result, removed, files } = await run([], { seed: { chmodFails: true } });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("failed to create file via template 'tmp.XXXXXXXXXX'");
      expect(removed).toHaveLength(1);
      expect(files.size).toBe(0);
    });
  });

  describe('-u / --dry-run', () => {
    it('prints a candidate without creating anything', async () => {
      const { result, path, files, dirs } = await run(['-u']);
      expect(result.exitCode).toBe(0);
      expect(path).toMatch(/^\/tmp\/tmp\./);
      expect(files.has(path)).toBe(false);
      expect(dirs.has(path)).toBe(false);
    });

    it('accepts --dry-run as well as -u', async () => {
      const { result, files } = await run(['--dry-run']);
      expect(result.exitCode).toBe(0);
      expect(files.size).toBe(0);
    });

    it('still prints a candidate for a directory that does not exist', async () => {
      // GNU touches nothing under -u, so the missing-parent check must not run.
      const { result, path } = await run(['-u', '-p', '/nope']);
      expect(result.exitCode).toBe(0);
      expect(path).toMatch(/^\/nope\/tmp\./);
    });

    it('counts a name occupied by a dangling symlink as taken', async () => {
      // `exists()` resolves the link and reports a dangling one as absent, so
      // the probe uses lstat. Pin the candidate by leaving three X's worth of
      // room and occupying the whole namespace is impractical — instead assert
      // the probe consults lstat rather than exists.
      const { result, fs } = await run(['-u']);
      expect(result.exitCode).toBe(0);
      expect(fs.lstat).toHaveBeenCalled();
      expect(fs.stat).not.toHaveBeenCalled();
    });
  });

  describe('-p / --tmpdir', () => {
    it.each([
      ['-p as a separate argument', ['-p', '/tmp/scratch']],
      ['-pDIR attached', ['-p/tmp/scratch']],
      ['--tmpdir=DIR', ['--tmpdir=/tmp/scratch']],
      ['a cluster ending in p', ['-up', '/tmp/scratch']],
    ])('places the entry under DIR: %s', async (_label, args) => {
      const { path } = await run(args, { seed: { dirs: ['/tmp/scratch'] } });
      expect(path).toMatch(/^\/tmp\/scratch\/tmp\./);
    });

    it('reads a bare --tmpdir as "the default directory", not as a template', async () => {
      const { path } = await run(['--tmpdir', 'buildXXXXXX'], {
        env: { TMPDIR: '/tmp/cone' },
        seed: { dirs: ['/tmp/cone'] },
      });
      expect(path).toMatch(/^\/tmp\/cone\/build[0-9A-Za-z]{6}$/);
    });

    it('joins a relative template onto -p', async () => {
      const { path } = await run(['-p', '/tmp/scratch', 'buildXXXXXX'], {
        seed: { dirs: ['/tmp/scratch'] },
      });
      expect(path).toMatch(/^\/tmp\/scratch\/build[0-9A-Za-z]{6}$/);
    });

    it('rejects an absolute template combined with -p', async () => {
      const { result } = await run(['-p', '/tmp/scratch', '/tmp/buildXXXXXX']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "mktemp: invalid template, '/tmp/buildXXXXXX'; with --tmpdir, it may not be absolute\n"
      );
    });

    it('rejects -p without an argument', async () => {
      const { result } = await run(['-p']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: option requires an argument -- 'p'\n");
    });
  });

  describe('templates', () => {
    it('resolves a bare template against the cwd, GNU-style', async () => {
      const { result, path, files } = await run(['buildXXXXXX'], {
        cwd: '/workspace/app',
        seed: { dirs: ['/workspace/app'] },
      });
      expect(result.exitCode).toBe(0);
      expect(path).toMatch(/^build[0-9A-Za-z]{6}$/);
      expect(files.has(`/workspace/app/${path}`)).toBe(true);
    });

    it('honours a directory part in the template', async () => {
      const { path } = await run(['/tmp/scratch/buildXXXXXX'], {
        seed: { dirs: ['/tmp/scratch'] },
      });
      expect(path).toMatch(/^\/tmp\/scratch\/build[0-9A-Za-z]{6}$/);
    });

    it('replaces only the last run of X and keeps the text after it', async () => {
      const { path } = await run(['/tmp/fooXXXXbar'], { seed: { dirs: ['/tmp'] } });
      expect(path).toMatch(/^\/tmp\/foo[0-9A-Za-z]{4}bar$/);
    });

    it("rejects a template with too few X's", async () => {
      const { result } = await run(['buildXX']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: too few X's in template 'buildXX'\n");
    });

    it('rejects more than one template', async () => {
      const { result } = await run(['aXXXX', 'bXXXX']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('mktemp: too many templates\n');
    });

    it('does not read a letter inside a template as a short option', async () => {
      // `chartXXXX` contains an h; scanning it as a cluster would print help.
      const { result, path } = await run(['chartXXXX']);
      expect(result.exitCode).toBe(0);
      expect(path).toMatch(/^chart[0-9A-Za-z]{4}$/);
    });
  });

  describe('--suffix', () => {
    it('appends the suffix after the random characters', async () => {
      const { path } = await run(['--suffix=.json', 'dataXXXXXX']);
      expect(path).toMatch(/^data[0-9A-Za-z]{6}\.json$/);
    });

    it('accepts the suffix as a separate argument', async () => {
      const { path } = await run(['--suffix', '.json', 'dataXXXXXX']);
      expect(path).toMatch(/^data[0-9A-Za-z]{6}\.json$/);
    });

    it('requires the template to end in X', async () => {
      const { result } = await run(['--suffix=.json', 'dataXXXXXX.txt']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "mktemp: with --suffix, template 'dataXXXXXX.txt' must end in X\n"
      );
    });

    it('rejects a suffix containing a directory separator', async () => {
      const { result } = await run(['--suffix=/etc', 'dataXXXXXX']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: invalid suffix '/etc', contains directory separator\n");
    });

    it('rejects --suffix without an argument', async () => {
      const { result } = await run(['--suffix']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: option '--suffix' requires an argument\n");
    });
  });

  describe('-t (deprecated GNU form)', () => {
    it('places a bare name in $TMPDIR', async () => {
      const { path } = await run(['-t', 'buildXXXXXX'], {
        env: { TMPDIR: '/tmp/cone' },
        seed: { dirs: ['/tmp/cone'] },
      });
      expect(path).toMatch(/^\/tmp\/cone\/build[0-9A-Za-z]{6}$/);
    });

    it('prefers a non-empty $TMPDIR over -p, unlike every other branch', async () => {
      const { path } = await run(['-t', '-p', '/tmp/scratch', 'buildXXXXXX'], {
        env: { TMPDIR: '/tmp/cone' },
        seed: { dirs: ['/tmp/cone', '/tmp/scratch'] },
      });
      expect(path).toMatch(/^\/tmp\/cone\//);
    });

    it('falls back to -p when $TMPDIR is unset', async () => {
      const { path } = await run(['-t', '-p', '/tmp/scratch', 'buildXXXXXX'], {
        seed: { dirs: ['/tmp/scratch'] },
      });
      expect(path).toMatch(/^\/tmp\/scratch\//);
    });

    it('rejects a template containing a directory separator', async () => {
      const { result } = await run(['-t', 'sub/buildXXXXXX']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "mktemp: invalid template, 'sub/buildXXXXXX', contains directory separator\n"
      );
    });
  });

  describe('--help and --version', () => {
    it.each([['-h'], ['--help']])('prints usage for %s', async (flag) => {
      const { result } = await run([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: mktemp [OPTION]... [TEMPLATE]');
      expect(result.stdout).toContain('--suffix=SUFF');
    });

    it('reports the coreutils release whose behaviour it follows', async () => {
      const { result } = await run(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('mktemp (just-bash) 9.4\n');
    });

    it('reports an invalid option reached before --help', async () => {
      const { result } = await run(['--bad', '--help']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: unrecognized option '--bad'\n");
    });

    it('prints help when --help is reached before the invalid option', async () => {
      const { result } = await run(['--help', '--bad']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: mktemp');
    });

    it('treats --help after -- as a template, not a request for help', async () => {
      const { result } = await run(['--', '--help']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: too few X's in template '--help'\n");
    });

    it('treats --help after -p as the directory', async () => {
      const { result } = await run(['-p', '--help']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("failed to create file via template 'tmp.XXXXXXXXXX'");
    });

    it('rejects an attached value on --help', async () => {
      const { result } = await run(['--help=1']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: option '--help' doesn't allow an argument\n");
    });
  });

  describe('unknown options are an error, never ignored (#2255)', () => {
    it('rejects an unknown long option', async () => {
      const { result } = await run(['--wat']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: unrecognized option '--wat'\n");
    });

    it('rejects an unknown short option, naming the character', async () => {
      const { result } = await run(['-z']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: invalid option -- 'z'\n");
    });

    it('rejects an unknown character inside an otherwise valid cluster', async () => {
      const { result } = await run(['-dz']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("mktemp: invalid option -- 'z'\n");
    });
  });

  describe('creation failures', () => {
    it('rejects a destination directory that does not exist', async () => {
      // The VFS creates missing parents on write; GNU mktemp does not, so the
      // check happens here rather than surfacing as a surprise path.
      const { result, files } = await run(['-p', '/nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "mktemp: failed to create file via template 'tmp.XXXXXXXXXX': No such file or directory\n"
      );
      expect(files.size).toBe(0);
    });

    it('rejects a destination that is a file rather than a directory', async () => {
      const { result } = await run(['-p', '/tmp/notadir'], {
        seed: { files: ['/tmp/notadir'] },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No such file or directory');
    });

    it('-q suppresses the diagnostic but keeps the exit status', async () => {
      const { result } = await run(['-q', '-p', '/nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
    });

    it('accepts --quiet as well as -q', async () => {
      const { result } = await run(['--quiet', '-p', '/nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
    });

    it('retries a taken name instead of reusing it', async () => {
      // Pin the first candidate by occupying every name a 3-X template can
      // produce is impractical; instead make lstat report the first probe as
      // taken and assert a second candidate was tried.
      const harness = fakeFs();
      let probes = 0;
      const realLstat = harness.fs.lstat as IFileSystem['lstat'];
      harness.fs.lstat = (async (path: string) => {
        probes++;
        if (probes === 1) return { isDirectory: false, isSymbolicLink: false };
        return realLstat(path);
      }) as unknown as IFileSystem['lstat'];
      const ctx = mockCommandContext({
        cwd: '/workspace',
        env: new Map(),
        fs: harness.fs,
      });

      const result = await createMktempCommand().execute([], ctx);
      expect(result.exitCode).toBe(0);
      expect(probes).toBe(2);
      expect(harness.files.has(result.stdout.trim())).toBe(true);
    });

    it('does not mistake an unrelated error for a collision', async () => {
      // Diagnostics embed the caller's path, so an EEXIST *in the message* of
      // an unrelated failure must not be retried into a wrong-looking success.
      const harness = fakeFs();
      harness.fs.writeFile = (async () => {
        throw new Error('EACCES: permission denied, open EEXIST');
      }) as unknown as IFileSystem['writeFile'];
      const ctx = mockCommandContext({ cwd: '/workspace', env: new Map(), fs: harness.fs });

      const result = await createMktempCommand().execute([], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('EACCES: permission denied');
    });
  });
});
