/**
 * Tests for the interim `mktemp` shim (#2267). The behaviour that matters
 * for this runtime is the default directory: `$TMPDIR` first, then the
 * caller's own scratch root, so a scoop never receives a `/tmp` path it is
 * not allowed to write.
 */

import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createMktempCommand } from '../../../src/shell/supplemental-commands/mktemp-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

function context(options: { env?: Record<string, string>; existing?: string[] } = {}) {
  const created = new Set(options.existing ?? []);
  const dirs = new Set<string>();
  const ctx = mockCommandContext({
    cwd: '/workspace',
    env: new Map(Object.entries(options.env ?? {})),
    fs: {
      exists: vi.fn(async (path: string) => created.has(path)) as unknown as IFileSystem['exists'],
      writeFile: vi.fn(async (path: string) => {
        created.add(path);
      }) as unknown as IFileSystem['writeFile'],
      mkdir: vi.fn(async (path: string) => {
        created.add(path);
        dirs.add(path);
      }) as unknown as IFileSystem['mkdir'],
    },
  });
  return { ctx, created, dirs };
}

async function run(args: string[], options?: Parameters<typeof context>[0]) {
  const harness = context(options);
  const result = await createMktempCommand().execute(args, harness.ctx);
  return { ...harness, result };
}

describe('mktemp command', () => {
  it('creates an empty file under /tmp and prints its absolute path', async () => {
    const { result, created } = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const path = result.stdout.trim();
    expect(path).toMatch(/^\/tmp\/tmp\.[A-Za-z0-9]{10}$/);
    expect(created.has(path)).toBe(true);
  });

  it('prefers $TMPDIR over the /tmp fallback', async () => {
    const { result } = await run([], { env: { TMPDIR: '/scoops/research/tmp/' } });
    expect(result.stdout.trim()).toMatch(/^\/scoops\/research\/tmp\/tmp\.[A-Za-z0-9]{10}$/);
  });

  it('ignores an empty $TMPDIR', async () => {
    const { result } = await run([], { env: { TMPDIR: '  ' } });
    expect(result.stdout.trim()).toMatch(/^\/tmp\//);
  });

  it('falls back to the scoop scratch root when $TMPDIR is unset', async () => {
    const { result } = await run([], { env: { HOME: '/scoops/research/home' } });
    expect(result.stdout.trim()).toMatch(/^\/scoops\/research\/tmp\/tmp\.[A-Za-z0-9]{10}$/);
  });

  it('keeps /tmp for a cone-style HOME', async () => {
    const { result } = await run([], { env: { HOME: '/home/lars' } });
    expect(result.stdout.trim()).toMatch(/^\/tmp\//);
  });

  it('returns a different name on every call', async () => {
    const first = await run([]);
    const second = await run([]);
    expect(first.result.stdout).not.toBe(second.result.stdout);
  });

  it.each(['-d', '--directory'])('%s creates a directory', async (flag) => {
    const { result, dirs } = await run([flag]);
    expect(result.exitCode).toBe(0);
    expect(dirs.has(result.stdout.trim())).toBe(true);
  });

  it.each(['-u', '--dry-run'])('%s prints a name without creating anything', async (flag) => {
    const { result, created } = await run([flag]);
    expect(result.exitCode).toBe(0);
    expect(created.size).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\/tmp\/tmp\./);
  });

  it.each([
    ['-p', ['-p', '/shared']],
    ['-pDIR', ['-p/shared']],
    ['--tmpdir=', ['--tmpdir=/shared']],
  ])('%s places the entry under the given directory', async (_label, args) => {
    const { result } = await run(args);
    expect(result.stdout.trim()).toMatch(/^\/shared\/tmp\./);
  });

  it('--tmpdir without a value uses the default temp directory', async () => {
    const { result } = await run(['--tmpdir'], { env: { TMPDIR: '/scoops/research/tmp' } });
    expect(result.stdout.trim()).toMatch(/^\/scoops\/research\/tmp\/tmp\./);
  });

  it('-p without an argument is a usage error', async () => {
    const { result } = await run(['-p']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("option requires an argument -- 'p'");
  });

  it('expands the trailing X run of a template, relative to the cwd', async () => {
    const { result, created } = await run(['build-XXXXXX']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\/workspace\/build-[A-Za-z0-9]{6}$/);
    expect(created.has(result.stdout.trim())).toBe(true);
  });

  it('honours a template with a directory part', async () => {
    const { result } = await run(['/shared/run-XXXX']);
    expect(result.stdout.trim()).toMatch(/^\/shared\/run-[A-Za-z0-9]{4}$/);
  });

  it('joins a relative template onto -p', async () => {
    const { result } = await run(['-p', '/shared', 'nested/run-XXXXXX']);
    expect(result.stdout.trim()).toMatch(/^\/shared\/nested\/run-[A-Za-z0-9]{6}$/);
  });

  it('rejects a template with fewer than three trailing X', async () => {
    const { result, created } = await run(['build-XX']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("too few X's in template 'build-XX'");
    expect(created.size).toBe(0);
  });

  it('rejects a second template', async () => {
    const { result } = await run(['a-XXXXXX', 'b-XXXXXX']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('too many templates');
  });

  it.each(['--suffix=.txt', '-t', '--bogus'])(
    'exits non-zero on the unrecognized flag %s (#2255)',
    async (flag) => {
      const { result, created } = await run([flag]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`unrecognized option '${flag}'`);
      expect(created.size).toBe(0);
    }
  );

  it('retries past a colliding candidate', async () => {
    const { ctx } = context();
    const exists = vi
      .fn<(path: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    (ctx.fs as { exists: unknown }).exists = exists;
    const result = await createMktempCommand().execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(exists).toHaveBeenCalledTimes(2);
  });

  it('reports a creation failure with a non-zero exit', async () => {
    const { ctx } = context();
    (ctx.fs as { writeFile: unknown }).writeFile = vi.fn(async () => {
      throw new Error("EACCES: sudo: approval denied '/tmp/tmp.abc'");
    });
    const result = await createMktempCommand().execute([], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to create file via template');
    expect(result.stderr).toContain('EACCES');
  });

  it.each(['-q', '--quiet'])('%s suppresses the creation diagnostic', async (flag) => {
    const { ctx } = context();
    (ctx.fs as { writeFile: unknown }).writeFile = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const result = await createMktempCommand().execute([flag], ctx);
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 1 });
  });

  it.each(['-h', '--help'])('%s prints usage and documents the default', async (flag) => {
    const { result } = await run([flag]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: mktemp');
    expect(result.stdout).toContain('$TMPDIR');
    expect(result.stdout).toContain('/scoops/<folder>/tmp');
  });
});
