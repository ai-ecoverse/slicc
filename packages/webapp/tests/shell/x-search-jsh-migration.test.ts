/**
 * Tests for the M3 globals-migration feature: the shipped `x_search.jsh`
 * is loaded from the on-disk vfs-root payload into a real `.jsh` realm
 * to prove it no longer relies on the removed bare globals (notably
 * `exec`), and a representative new `.jsh` exercises the full set of
 * `require('sliccy:...')` access patterns end-to-end through the same
 * runtime path that ships in production.
 *
 * Fulfills VAL-GLOBALS-012, VAL-GLOBALS-013, VAL-CROSS-010.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createInProcessJsRealmFactory } from '../../src/kernel/realm/realm-inprocess.js';
import { executeJsCode, executeJshFile } from '../../src/shell/jsh-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const X_SEARCH_PATH = resolve(repoRoot, 'packages/vfs-root/workspace/skills/x-search/x_search.jsh');

function makeFs(files: Record<string, string> = {}): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const fs: IFileSystem = {
    async readFile(p: string): Promise<string> {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async readFileBuffer(p: string): Promise<Uint8Array> {
      return new TextEncoder().encode(await fs.readFile(p));
    },
    async writeFile(p: string, c: string | Uint8Array): Promise<void> {
      store.set(p, typeof c === 'string' ? c : new TextDecoder().decode(c));
    },
    async appendFile(p: string, c: string | Uint8Array): Promise<void> {
      store.set(
        p,
        (store.get(p) || '') + (typeof c === 'string' ? c : new TextDecoder().decode(c))
      );
    },
    async exists(p: string): Promise<boolean> {
      return store.has(p);
    },
    async stat(p: string): Promise<FsStat> {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: (store.get(p) || '').length,
        mtime: new Date(),
      };
    },
    async mkdir(): Promise<void> {},
    async readdir(): Promise<string[]> {
      return [];
    },
    async rm(p: string): Promise<void> {
      store.delete(p);
    },
    async cp(): Promise<void> {},
    async mv(): Promise<void> {},
    resolvePath(base: string, p: string): string {
      if (p.startsWith('/')) return p;
      if (p === '.') return base;
      return base === '/' ? `/${p}` : `${base}/${p}`;
    },
    getAllPaths(): string[] {
      return [...store.keys()];
    },
    async chmod(): Promise<void> {},
    async symlink(): Promise<void> {},
    async link(): Promise<void> {},
    async readlink(): Promise<string> {
      return '';
    },
    async lstat(p: string): Promise<FsStat> {
      return fs.stat(p);
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
    async utimes(): Promise<void> {},
  };
  return fs;
}

function makeCtx(
  opts: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    exec?: CommandContext['exec'];
  } = {}
): CommandContext {
  const ctx: CommandContext = {
    fs: makeFs(opts.files ?? {}),
    cwd: '/workspace',
    env: new Map<string, string>(Object.entries(opts.env ?? {})),
    stdin: unsafeBytesFromLatin1(''),
  };
  if (opts.exec) ctx.exec = opts.exec;
  return ctx;
}

describe("VAL-GLOBALS-013: shipped x_search.jsh loads via require('sliccy:exec')", () => {
  it('imports exec via sliccy:exec and uses process.exit (no bare exit/global exec)', () => {
    const source = readFileSync(X_SEARCH_PATH, 'utf-8');
    expect(source).toContain("require('sliccy:exec')");
    // Bare `exit(...)` (without `process.` prefix) must be gone.
    expect(source).not.toMatch(/(^|[^.\w])exit\s*\(/m);
    // `process.exit` is the supported termination path.
    expect(source).toContain('process.exit');
  });

  it('--help prints usage and exits 0 with no bare-global ReferenceError', async () => {
    const source = readFileSync(X_SEARCH_PATH, 'utf-8');
    const path = '/workspace/skills/x-search/x_search.jsh';
    const ctx = makeCtx({ files: { [path]: source } });
    const result = await executeJshFile(path, ['--help'], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).not.toContain('exec is not defined');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: x_search');
    expect(result.stdout).toContain('--from');
    expect(result.stdout).toContain('--since');
  });

  it('-h prints usage and exits 0 (short flag parity)', async () => {
    const source = readFileSync(X_SEARCH_PATH, 'utf-8');
    const path = '/workspace/skills/x-search/x_search.jsh';
    const ctx = makeCtx({ files: { [path]: source } });
    const result = await executeJshFile(path, ['-h'], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: x_search');
  });

  it('missing query exits non-zero with a clear error (no ReferenceError)', async () => {
    const source = readFileSync(X_SEARCH_PATH, 'utf-8');
    const path = '/workspace/skills/x-search/x_search.jsh';
    const ctx = makeCtx({ files: { [path]: source } });
    const result = await executeJshFile(path, [], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).toContain('missing query');
    expect(result.exitCode).not.toBe(0);
  });
});

describe('VAL-GLOBALS-012: a new sliccy: .jsh runs end-to-end', () => {
  it("a script using require('sliccy:exec') and require('sliccy:color') runs to completion", async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/val-globals.jsh': [
          "const { exec } = require('sliccy:exec');",
          "const c = require('sliccy:color');",
          "const r = await exec('echo jsh-ok');",
          'console.log(c.green(r.stdout.trim()));',
        ].join('\n'),
      },
      exec: (async (command) => ({
        stdout: command.includes('echo') ? `${command.split(' ').slice(1).join(' ')}\n` : '',
        stderr: '',
        exitCode: 0,
      })) as CommandContext['exec'],
    });
    const result = await executeJshFile('/workspace/val-globals.jsh', [], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('jsh-ok');
  });

  it('a .jsh exercising several sliccy: modules (time, fmt, pool, cli) runs end-to-end', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/multi.jsh': [
          "const time = require('sliccy:time');",
          "const fmt = require('sliccy:fmt');",
          "const pool = require('sliccy:pool');",
          "const cli = require('sliccy:cli');",
          "console.log('dur=' + time.parseDuration('1h'));",
          "console.log('trunc=' + fmt.trunc('hello world', 8));",
          'const out = await pool(2, [1, 2, 3], async (n) => n * 10);',
          "console.log('pool=' + out.join(','));",
          'cli.out({ ok: true });',
        ].join('\n'),
      },
    });
    const result = await executeJshFile('/workspace/multi.jsh', [], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dur=3600000');
    expect(result.stdout).toContain('trunc=hello w');
    expect(result.stdout).toContain('pool=10,20,30');
    expect(result.stdout).toContain('"ok": true');
  });
});

describe('VAL-CROSS-010: hard-cut bare global is gone; sliccy:exec reaches the capability', () => {
  it("bare `exec` is no longer defined (typeof prints 'undefined' from script)", async () => {
    const ctx = makeCtx();
    const result = await executeJsCode('console.log(typeof exec)', ['node'], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('undefined');
  });

  it('bare `exec(...)` invocation throws ReferenceError with non-zero exit', async () => {
    const ctx = makeCtx({
      exec: (async () => ({ stdout: '', stderr: '', exitCode: 0 })) as CommandContext['exec'],
    });
    const result = await executeJsCode("await exec('echo hi')", ['node'], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ReferenceError');
    expect(result.stderr).toContain('exec');
  });

  it("require('sliccy:exec').exec('echo hi') reaches the capability", async () => {
    const ctx = makeCtx({
      exec: (async (cmd) => ({
        stdout: cmd.includes('echo') ? `${cmd.split(' ').slice(1).join(' ')}\n` : '',
        stderr: '',
        exitCode: 0,
      })) as CommandContext['exec'],
    });
    const result = await executeJsCode(
      "const r = await require('sliccy:exec').exec('echo hi'); console.log(r.stdout.trim());",
      ['node'],
      ctx,
      undefined,
      { realmFactory: createInProcessJsRealmFactory() }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it("destructured `const { exec } = require('sliccy:exec')` reaches the capability", async () => {
    const ctx = makeCtx({
      exec: (async (cmd) => ({
        stdout: cmd.includes('echo') ? `${cmd.split(' ').slice(1).join(' ')}\n` : '',
        stderr: '',
        exitCode: 0,
      })) as CommandContext['exec'],
    });
    const result = await executeJsCode(
      "const { exec } = require('sliccy:exec'); const r = await exec('echo destructured'); console.log(r.stdout.trim());",
      ['node'],
      ctx,
      undefined,
      { realmFactory: createInProcessJsRealmFactory() }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('destructured');
  });
});
