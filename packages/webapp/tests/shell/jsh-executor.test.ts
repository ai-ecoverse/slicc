import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { executeJsCode, executeJshFile } from '../../src/shell/jsh-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/** Minimal in-memory IFileSystem for tests */
function createMockFs(files: Record<string, string> = {}): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));

  const fs: IFileSystem = {
    async readFile(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(content);
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      store.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async appendFile(path: string, content: string | Uint8Array): Promise<void> {
      const existing = store.get(path) || '';
      store.set(
        path,
        existing + (typeof content === 'string' ? content : new TextDecoder().decode(content))
      );
    },
    async exists(path: string): Promise<boolean> {
      return store.has(path);
    },
    async stat(path: string): Promise<FsStat> {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: (store.get(path) || '').length,
        mtime: new Date(),
      };
    },
    async mkdir(): Promise<void> {
      /* noop for tests */
    },
    async readdir(path: string): Promise<string[]> {
      const entries: string[] = [];
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split('/')[0];
          if (name && !entries.includes(name)) entries.push(name);
        }
      }
      return entries;
    },
    async rm(path: string): Promise<void> {
      store.delete(path);
    },
    async cp(): Promise<void> {
      /* noop */
    },
    async mv(): Promise<void> {
      /* noop */
    },
    resolvePath(base: string, path: string): string {
      if (path.startsWith('/')) return path;
      if (path === '.') return base;
      const combined = base === '/' ? `/${path}` : `${base}/${path}`;
      // Normalize .. and .
      const parts = combined.split('/');
      const resolved: string[] = [];
      for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p !== '.' && p !== '') resolved.push(p);
      }
      return '/' + resolved.join('/');
    },
    getAllPaths(): string[] {
      return [...store.keys()];
    },
    async chmod(): Promise<void> {
      /* noop */
    },
    async symlink(): Promise<void> {
      /* noop */
    },
    async link(): Promise<void> {
      /* noop */
    },
    async readlink(): Promise<string> {
      return '';
    },
    async lstat(path: string): Promise<FsStat> {
      return fs.stat(path);
    },
    async realpath(path: string): Promise<string> {
      return path;
    },
    async utimes(): Promise<void> {
      /* noop */
    },
  };
  return fs;
}

function createMockCtx(
  files: Record<string, string> = {},
  envVars: Record<string, string> = {},
  execFn?: (
    command: string,
    options: { cwd?: string }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  stdin = ''
): CommandContext {
  const env = new Map<string, string>(Object.entries(envVars));
  const ctx: CommandContext = {
    fs: createMockFs(files),
    cwd: '/workspace',
    env,
    stdin: unsafeBytesFromLatin1(stdin),
  };
  if (execFn) {
    ctx.exec = execFn as CommandContext['exec'];
  }
  return ctx;
}

describe('executeJshFile', () => {
  it('returns 127 for missing script file', async () => {
    const ctx = createMockCtx();
    const result = await executeJshFile('/nonexistent.jsh', [], ctx);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('cannot find script');
  });

  it('executes a simple console.log script', async () => {
    const ctx = createMockCtx({
      '/workspace/hello.jsh': 'console.log("Hello, World!");',
    });
    const result = await executeJshFile('/workspace/hello.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Hello, World!\n');
    expect(result.stderr).toBe('');
  });

  it('sets process.argv correctly', async () => {
    const ctx = createMockCtx({
      '/workspace/args.jsh': 'console.log(JSON.stringify(process.argv));',
    });
    const result = await executeJshFile('/workspace/args.jsh', ['foo', 'bar'], ctx);
    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(result.stdout.trim());
    expect(argv[0]).toBe('node');
    expect(argv[1]).toBe('/workspace/args.jsh');
    expect(argv[2]).toBe('foo');
    expect(argv[3]).toBe('bar');
  });

  it('provides process.env from shell environment', async () => {
    const ctx = createMockCtx(
      { '/workspace/env.jsh': 'console.log(process.env.MY_VAR);' },
      { MY_VAR: 'hello_env' }
    );
    const result = await executeJshFile('/workspace/env.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello_env');
  });

  it('provides process.versions.node / version / platform / arch (#2200)', async () => {
    // Packages feature-detect on these at require time — esbuild's Node entry
    // does `process.versions.node.split('.')` at module scope, which threw
    // `Cannot read properties of undefined (reading 'node')` while they were
    // absent. `.split('.')` here IS that check.
    const ctx = createMockCtx({
      '/workspace/ident.jsh': [
        'const [major] = process.versions.node.split(".");',
        'console.log(JSON.stringify({',
        '  major: Number(major),',
        '  version: process.version,',
        '  platform: process.platform,',
        '  arch: process.arch,',
        '}));',
      ].join('\n'),
    });
    const result = await executeJshFile('/workspace/ident.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    const ident = JSON.parse(result.stdout.trim());
    expect(ident.major).toBeGreaterThanOrEqual(20);
    expect(ident.version).toMatch(/^v\d+\.\d+\.\d+/);
    // Must agree with the `os` shim (`helpers/node-os.ts`).
    expect(ident.platform).toBe('linux');
    expect(ident.arch).toBe('x64');
  });

  it('provides process.cwd()', async () => {
    const ctx = createMockCtx({
      '/workspace/cwd.jsh': 'console.log(process.cwd());',
    });
    const result = await executeJshFile('/workspace/cwd.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/workspace');
  });

  it('handles process.exit() with code', async () => {
    const ctx = createMockCtx({
      '/workspace/exit.jsh': 'console.log("before"); process.exit(42); console.log("after");',
    });
    const result = await executeJshFile('/workspace/exit.jsh', [], ctx);
    expect(result.exitCode).toBe(42);
    expect(result.stdout).toContain('before');
    expect(result.stdout).not.toContain('after');
  });

  it('handles process.exit(0)', async () => {
    const ctx = createMockCtx({
      '/workspace/exit0.jsh': 'process.exit(0);',
    });
    const result = await executeJshFile('/workspace/exit0.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
  });

  it('captures stderr from console.error', async () => {
    const ctx = createMockCtx({
      '/workspace/err.jsh': 'console.error("oops"); console.log("ok");',
    });
    const result = await executeJshFile('/workspace/err.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.stderr).toBe('oops\n');
  });

  it('captures stderr from console.warn', async () => {
    const ctx = createMockCtx({
      '/workspace/warn.jsh': 'console.warn("warning!");',
    });
    const result = await executeJshFile('/workspace/warn.jsh', [], ctx);
    expect(result.stderr).toBe('warning!\n');
  });

  it("require('fs').readFile reads from the VFS", async () => {
    const ctx = createMockCtx({
      '/workspace/reader.jsh':
        'const fs = require("fs"); const content = await fs.readFile("data.txt"); console.log(content);',
      '/workspace/data.txt': 'file contents here',
    });
    const result = await executeJshFile('/workspace/reader.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('file contents here');
  });

  it("require('fs').writeFile writes to the VFS", async () => {
    const ctx = createMockCtx({
      '/workspace/writer.jsh':
        'const fs = require("fs"); await fs.writeFile("out.txt", "written!"); console.log("done");',
    });
    const result = await executeJshFile('/workspace/writer.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    // Verify the file was written via the mock fs
    const content = await ctx.fs.readFile('/workspace/out.txt');
    expect(content).toBe('written!');
  });

  it("require('fs').exists returns the VFS existence flag", async () => {
    const ctx = createMockCtx({
      '/workspace/check.jsh':
        'const fs = require("fs"); console.log(await fs.exists("data.txt")); console.log(await fs.exists("nope.txt"));',
      '/workspace/data.txt': 'exists',
    });
    const result = await executeJshFile('/workspace/check.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true\nfalse\n');
  });

  it("require('fs').readDir lists VFS entries", async () => {
    const ctx = createMockCtx({
      '/workspace/lsdir.jsh':
        'const fs = require("fs"); const entries = await fs.readDir("."); console.log(entries.sort().join(","));',
      '/workspace/a.txt': 'a',
      '/workspace/b.txt': 'b',
    });
    const result = await executeJshFile('/workspace/lsdir.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    // Should list files in /workspace
    expect(result.stdout.trim()).toContain('a.txt');
    expect(result.stdout.trim()).toContain('b.txt');
  });

  it('returns exitCode 1 on runtime error', async () => {
    const ctx = createMockCtx({
      '/workspace/error.jsh': 'throw new Error("boom");',
    });
    const result = await executeJshFile('/workspace/error.jsh', [], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('supports process.stdout.write', async () => {
    const ctx = createMockCtx({
      '/workspace/write.jsh': 'process.stdout.write("no newline");',
    });
    const result = await executeJshFile('/workspace/write.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('no newline');
  });

  it('supports process.stderr.write', async () => {
    const ctx = createMockCtx({
      '/workspace/errwrite.jsh': 'process.stderr.write("err msg");',
    });
    const result = await executeJshFile('/workspace/errwrite.jsh', [], ctx);
    expect(result.stderr).toBe('err msg');
  });

  it('provides module and exports objects', async () => {
    const ctx = createMockCtx({
      '/workspace/mod.jsh': 'module.exports.foo = 42; console.log(typeof module.exports.foo);',
    });
    const result = await executeJshFile('/workspace/mod.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('number');
  });

  it('require throws for non-pre-scanned dynamic specifiers', async () => {
    const ctx = createMockCtx({
      '/workspace/req.jsh':
        'try { const x = require(String("dynamic-pkg")); console.log("unexpected: " + x); } catch(e) { console.log(e.message); }',
    });
    const result = await executeJshFile('/workspace/req.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    // Hard-switched loader: a dynamic specifier with no graph edge throws the
    // Node `Cannot find module` error with the install hint, never a CDN path.
    expect(result.stdout).toContain(
      "Cannot find module 'dynamic-pkg' (run: ipk install dynamic-pkg)"
    );
  });

  it('require throws helpful error for modules that are not installed', async () => {
    const ctx = createMockCtx({
      '/workspace/req-err.jsh':
        'try { const x = require("this-package-definitely-does-not-exist-xyz123"); console.log("got: " + typeof x); } catch(e) { console.log(e.message); }',
    });
    const result = await executeJshFile('/workspace/req-err.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Cannot find module 'this-package-definitely-does-not-exist-xyz123' (run: ipk install this-package-definitely-does-not-exist-xyz123)"
    );
  });

  // The CJS require hard-switch resolves every specifier from the installed
  // node_modules graph (host-resolved over the `module` RPC). There is no CDN
  // download path; an uninstalled module hard-errors with the install hint
  // (covered by the negative tests above).

  it('require("fs") returns the fs bridge', async () => {
    const ctx = createMockCtx({
      '/workspace/req-fs.jsh': `
        const myFs = require('fs');
        console.log(typeof myFs.readFile);
        console.log(typeof myFs.writeFile);
        console.log(typeof myFs.exists);
      `,
    });
    const result = await executeJshFile('/workspace/req-fs.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('function');
  });

  it('require("node:fs") strips prefix and returns fs bridge', async () => {
    const ctx = createMockCtx({
      '/workspace/req-nodefs.jsh': `
        const myFs = require('node:fs');
        console.log(typeof myFs.readFile);
      `,
    });
    const result = await executeJshFile('/workspace/req-nodefs.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('function');
  });

  it('require("process") returns the process shim', async () => {
    const ctx = createMockCtx({
      '/workspace/req-process.jsh': `
        const proc = require('process');
        console.log(typeof proc.cwd);
        console.log(typeof proc.env);
      `,
    });
    const result = await executeJshFile('/workspace/req-process.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('function');
    expect(result.stdout).toContain('object');
  });

  it('require("http") throws clear browser-unavailable error', async () => {
    const ctx = createMockCtx({
      '/workspace/req-http.jsh': `
        try {
          const http = require('http');
        } catch(e) {
          console.log(e.message);
        }
      `,
    });
    const result = await executeJshFile('/workspace/req-http.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not available in the browser');
  });

  it('require("node:os") strips prefix and returns the os shim', async () => {
    const ctx = createMockCtx({
      '/workspace/req-os.jsh': `
        const os = require('node:os');
        console.log(os.tmpdir(), os.platform());
      `,
    });
    const result = await executeJshFile('/workspace/req-os.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/tmp');
    expect(result.stdout).toContain('linux');
  });

  it('require("node:crypto") strips prefix and returns the Web Crypto bridge', async () => {
    const ctx = createMockCtx({
      '/workspace/req-crypto.jsh': `
        const crypto = require('node:crypto');
        const buf = new Uint8Array(8);
        console.log(crypto.randomFillSync(buf) === buf, typeof crypto.randomUUID());
      `,
    });
    const result = await executeJshFile('/workspace/req-crypto.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('true string');
  });
});

describe('executeJsCode', () => {
  it('executes inline code with argv', async () => {
    const ctx = createMockCtx();
    const result = await executeJsCode(
      'console.log(process.argv.join(","));',
      ['node', 'test.js', 'a', 'b'],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('node,test.js,a,b');
  });

  it('handles async code', async () => {
    const ctx = createMockCtx({
      '/workspace/data.txt': 'async content',
    });
    const result = await executeJsCode(
      'const fs = require("fs"); const data = await fs.readFile("data.txt"); console.log(data);',
      ['node'],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('async content');
  });
});

describe('exec bridge', () => {
  it('runs a shell command and returns the result', async () => {
    const mockExec = async (cmd: string) => ({
      stdout: `ran: ${cmd}\n`,
      stderr: '',
      exitCode: 0,
    });
    const ctx = createMockCtx(
      {
        '/workspace/run.jsh':
          'const exec = require("sliccy:exec"); const r = await exec("echo hello"); console.log(r.stdout.trim());',
      },
      {},
      mockExec
    );
    const result = await executeJshFile('/workspace/run.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ran: echo hello');
  });

  it('returns exitCode from the shell command', async () => {
    const mockExec = async () => ({
      stdout: '',
      stderr: 'not found\n',
      exitCode: 127,
    });
    const ctx = createMockCtx(
      {
        '/workspace/check.jsh':
          'const exec = require("sliccy:exec"); const r = await exec("bad-cmd"); console.log(r.exitCode);',
      },
      {},
      mockExec
    );
    const result = await executeJshFile('/workspace/check.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('127');
  });

  it('throws when exec is not available', async () => {
    const ctx = createMockCtx({
      '/workspace/noexec.jsh':
        'try { const exec = require("sliccy:exec"); await exec("ls"); } catch(e) { console.log(e.message); }',
    });
    const result = await executeJshFile('/workspace/noexec.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not available');
  });

  it('works via executeJsCode with exec', async () => {
    const mockExec = async (cmd: string) => ({
      stdout: `output of ${cmd}\n`,
      stderr: '',
      exitCode: 0,
    });
    const ctx = createMockCtx({}, {}, mockExec);
    const result = await executeJsCode(
      'const exec = require("sliccy:exec"); const r = await exec("oauth-token adobe"); process.stdout.write(r.stdout);',
      ['node'],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('output of oauth-token adobe\n');
  });

  it('captures stderr from failed shell commands', async () => {
    const mockExec = async () => ({
      stdout: '',
      stderr: 'permission denied\n',
      exitCode: 1,
    });
    const ctx = createMockCtx(
      {
        '/workspace/fail.jsh':
          'const exec = require("sliccy:exec"); const r = await exec("restricted-cmd"); console.error(r.stderr.trim()); console.log(r.exitCode);',
      },
      {},
      mockExec
    );
    const result = await executeJshFile('/workspace/fail.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('permission denied');
    expect(result.stdout.trim()).toBe('1');
  });
});

describe('jsh-executor — process manager wiring', () => {
  it('registers a kind:"jsh" process for executeJshFile and exits with the script exit code', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const ctx = createMockCtx({
      '/workspace/hi.jsh': 'console.log("hi")',
    });
    await executeJshFile('/workspace/hi.jsh', ['a', 'b'], ctx, {
      processManager: pm,
      owner: { kind: 'cone' },
      getParentPid: () => 5000,
    });
    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].kind).toBe('jsh');
    expect(procs[0].argv).toEqual(['node', '/workspace/hi.jsh', 'a', 'b']);
    expect(procs[0].ppid).toBe(5000);
    expect(procs[0].exitCode).toBe(0);
    expect(procs[0].status).toBe('exited');
  });

  it('records process.exit(N) as the kind:"jsh" exit code', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const ctx = createMockCtx({
      '/workspace/fail.jsh': 'process.exit(7);',
    });
    const result = await executeJshFile('/workspace/fail.jsh', [], ctx, {
      processManager: pm,
      owner: { kind: 'system' },
    });
    expect(result.exitCode).toBe(7);
    expect(pm.list()[0].exitCode).toBe(7);
  });

  it('exits 1 on a thrown script error', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const ctx = createMockCtx({
      '/workspace/throw.jsh': 'throw new Error("boom");',
    });
    const result = await executeJshFile('/workspace/throw.jsh', [], ctx, {
      processManager: pm,
      owner: { kind: 'system' },
    });
    expect(result.exitCode).toBe(1);
    expect(pm.list()[0].exitCode).toBe(1);
  });

  it('does not register processes when no pmConfig is supplied (backwards compatible)', async () => {
    const ctx = createMockCtx({
      '/workspace/hi.jsh': 'console.log("hi")',
    });
    const result = await executeJshFile('/workspace/hi.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
  });
});

describe('stdin in .jsh scripts', () => {
  it('exposes piped stdin via process.stdin.read()', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/cat.jsh': 'const data = process.stdin.read(); process.stdout.write(data);',
      },
      {},
      undefined,
      'hello from upstream\n'
    );
    const result = await executeJshFile('/workspace/cat.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from upstream\n');
  });

  it('returns the byte length when stdin is read as a string', async () => {
    const ctx = createMockCtx(
      { '/workspace/read.jsh': 'console.log(process.stdin.read().length);' },
      {},
      undefined,
      'abcdef'
    );
    const result = await executeJshFile('/workspace/read.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('6');
  });

  it('supports `for await (const chunk of process.stdin)` iteration', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/iter.jsh':
          'let total = ""; for await (const c of process.stdin) total += c; console.log(total.toUpperCase());',
      },
      {},
      undefined,
      'hi'
    );
    const result = await executeJshFile('/workspace/iter.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('HI');
  });

  it('returns null on subsequent process.stdin.read() calls (Node EOF semantics)', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/eof.jsh':
          'const a = process.stdin.read(); const b = process.stdin.read(); console.log(JSON.stringify({ a, b }));',
      },
      {},
      undefined,
      'data'
    );
    const result = await executeJshFile('/workspace/eof.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ a: 'data', b: null });
  });

  it('shares EOF state between read() and the async iterator', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/shared-eof.jsh':
          'process.stdin.read(); let n = 0; for await (const _ of process.stdin) n++; console.log(n);',
      },
      {},
      undefined,
      'data'
    );
    const result = await executeJshFile('/workspace/shared-eof.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('0');
  });

  it('async iterator yields once then ends', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/iter-twice.jsh': [
          'let first = ""; for await (const c of process.stdin) first += c;',
          'let second = ""; for await (const c of process.stdin) second += c;',
          'console.log(JSON.stringify({ first, second }));',
        ].join('\n'),
      },
      {},
      undefined,
      'once'
    );
    const result = await executeJshFile('/workspace/iter-twice.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ first: 'once', second: '' });
  });

  it('process.stdin.toString() is a non-consuming view', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/view.jsh': [
          'const view = String(process.stdin);',
          'const read = process.stdin.read();',
          'console.log(JSON.stringify({ view, read }));',
        ].join('\n'),
      },
      {},
      undefined,
      'data'
    );
    const result = await executeJshFile('/workspace/view.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ view: 'data', read: 'data' });
  });

  it('read() returns null when no stdin is piped (Node parity)', async () => {
    const ctx = createMockCtx({
      '/workspace/empty.jsh':
        'console.log(JSON.stringify({ first: process.stdin.read(), second: process.stdin.read(), tty: process.stdin.isTTY }));',
    });
    const result = await executeJshFile('/workspace/empty.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    // Node parity: with no piped input `read()` returns null immediately —
    // Node's Readable.read() never yields '' for an empty stream. (This
    // previously pinned first === ''; updated with the fd/readline stdin work.)
    expect(JSON.parse(result.stdout.trim())).toEqual({
      first: null,
      second: null,
      tty: false,
    });
  });

  it('preserves binary-shaped (latin1) stdin bytes verbatim', async () => {
    // just-bash threads non-UTF-8 binary as a latin1 string (one JS char
    // per byte). The realm must hand it back to user code byte-identical.
    const bytes = String.fromCharCode(0x00, 0xff, 0x7f, 0x80, 0xc3, 0xa9);
    const ctx = createMockCtx(
      {
        '/workspace/echo.jsh':
          'const data = process.stdin.read(); const codes = []; for (const c of data) codes.push(c.charCodeAt(0)); console.log(codes.join(","));',
      },
      {},
      undefined,
      bytes
    );
    const result = await executeJshFile('/workspace/echo.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('0,255,127,128,195,169');
  });

  it('does not collide with scripts that declare their own `stdin` identifier', async () => {
    // Earlier drafts of this feature injected `stdin` as a 9th
    // AsyncFunction parameter. That would have made the line below a
    // strict-mode SyntaxError (duplicate declaration). Surfacing only
    // via `process.stdin` keeps the identifier free for user code.
    const ctx = createMockCtx(
      {
        '/workspace/local-name.jsh': [
          'const stdin = "user-owned name";',
          'console.log(stdin);',
        ].join('\n'),
      },
      {},
      undefined,
      'piped'
    );
    const result = await executeJshFile('/workspace/local-name.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('user-owned name');
  });

  it('does not break scripts that ignore stdin', async () => {
    const ctx = createMockCtx(
      { '/workspace/quiet.jsh': 'console.log("ok");' },
      {},
      undefined,
      'some piped input the script will never read'
    );
    const result = await executeJshFile('/workspace/quiet.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
  });

  // -------------------------------------------------------------------------
  // Wave 1 characterization tests (issue #1720). These PIN DOWN today's
  // broken behavior so Wave 2 has a precise contract to flip. The tests
  // tagged "WAVE 2 CONTRACT" assert the *current* (buggy) result on purpose;
  // Wave 2 must update those assertions when it adds the EventEmitter surface
  // to createStdinShim. Do not "fix" them here — this task makes NO src change.
  // -------------------------------------------------------------------------

  it('issue #1720: process.stdin.on is now a function (EventEmitter surface added)', async () => {
    // WAVE 2 CONTRACT (flipped): the shim now carries `.on`, so `typeof` is
    // "function" (was "undefined" on pre-Wave-2 main).
    const ctx = createMockCtx(
      { '/workspace/typeof-on.jsh': 'console.log(typeof process.stdin.on);' },
      {},
      undefined,
      'hi'
    );
    const result = await executeJshFile('/workspace/typeof-on.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('issue #1720: the exact `.on("data")/.on("end")` snippet now prints and exits 0', async () => {
    // The verbatim reproduction from the issue. WAVE 2 CONTRACT (flipped): the
    // EventEmitter surface now emits the whole buffer as one `'data'` chunk then
    // `'end'` on a single microtask hop, so the `'end'` handler's output reaches
    // command stdout (see spec Acceptance Criteria).
    const ctx = createMockCtx(
      {
        '/workspace/on-chain.jsh':
          'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("got:",s))',
      },
      {},
      undefined,
      'hello from upstream'
    );
    const result = await executeJshFile('/workspace/on-chain.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('got: hello from upstream\n');
    expect(result.stderr).toBe('');
  });

  it('issue #1720: async iteration ALREADY works today (the "no async iteration" claim is a reporting artifact)', async () => {
    // FINDING (DoD item 2): the shim carries a real [Symbol.asyncIterator], so
    // `for await (const c of process.stdin)` works on current `main`. The
    // issue's "no async iteration" wording is a reporting artifact of the
    // missing `.on` surface — it is NOT a second, separate bug. This test is
    // expected to stay GREEN through Wave 2 (async iteration must not regress).
    const ctx = createMockCtx(
      {
        '/workspace/aiter-detect.jsh': [
          'const hasAsyncIter = typeof process.stdin[Symbol.asyncIterator] === "function";',
          'let s = ""; for await (const c of process.stdin) s += c;',
          'console.log(JSON.stringify({ hasAsyncIter, got: s }));',
        ].join('\n'),
      },
      {},
      undefined,
      'streamed'
    );
    const result = await executeJshFile('/workspace/aiter-detect.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ hasAsyncIter: true, got: 'streamed' });
  });

  it('output-loss window: queueMicrotask + single setTimeout(0) writes reach realm-done stdout today', async () => {
    // FINDING (DoD item 3) — the constraint Wave 2's `end`-event emission must
    // respect. runJsRealm resolves as soon as the user AsyncFunction returns;
    // it then runs flushSyncFsCache and, when process.exit() was NOT called,
    // drainPendingRpcs() (js-realm-shared.ts). drainPendingRpcs is a do/while
    // that always awaits AT LEAST ONE `setTimeout(r, 0)` macrotask boundary,
    // but its loop only continues while `rpc.pendingCount > 0` — user timers do
    // NOT count as pending RPCs. So the drain guarantees exactly ONE macrotask
    // hop when there are no outstanding RPCs.
    //
    // Consequence, established empirically here:
    //   * queueMicrotask output ALWAYS survives — microtasks queued in the body
    //     run before the `await runUserCode` continuation resumes.
    //   * a SINGLE setTimeout(0) hop survives — it was registered before the
    //     drain's own setTimeout(0), so it fires within that one macrotask hop.
    // Wave 2 may therefore emit `data`/`end` via one microtask/one setTimeout(0)
    // hop and still have `end`-callback output captured. See the deeper-nesting
    // test below for where that guarantee ends.
    const ctx = createMockCtx(
      {
        '/workspace/defer.jsh': [
          'process.stdout.write("sync\\n");',
          'queueMicrotask(() => process.stdout.write("micro\\n"));',
          'setTimeout(() => process.stdout.write("macro\\n"), 0);',
        ].join('\n'),
      },
      {},
      undefined,
      ''
    );
    const result = await executeJshFile('/workspace/defer.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sync\nmicro\nmacro\n');
  });

  it('output-loss window: a SECOND, nested setTimeout(0) hop is DROPPED from stdout today', async () => {
    // FINDING (DoD item 3, boundary case). drainPendingRpcs guarantees only ONE
    // macrotask hop for pure user timers (see above). Output written from a
    // setTimeout nested inside another setTimeout lands after realm-done has
    // already captured stdout, so it is silently lost. This is the hard
    // constraint for Wave 2: an `end`-event deferral must complete within a
    // single microtask/macrotask hop, NOT a multi-tick async chain, or the
    // callback's output will not appear in command stdout.
    const ctx = createMockCtx(
      {
        '/workspace/nested-defer.jsh': [
          'process.stdout.write("sync\\n");',
          'setTimeout(() => {',
          '  process.stdout.write("hop1\\n");',
          '  setTimeout(() => process.stdout.write("hop2\\n"), 0);',
          '}, 0);',
        ].join('\n'),
      },
      {},
      undefined,
      ''
    );
    const result = await executeJshFile('/workspace/nested-defer.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sync\nhop1\n');
    expect(result.stdout).not.toContain('hop2');
  });

  it('parity: process.stdin shim is constructed in exactly one place (createProcessShim)', () => {
    // DoD item 4 / WAVE 2 GUARD. The buffered stdin shim must live in exactly
    // one factory (createStdinShim, called only by createProcessShim). If a
    // second construction site is (re)introduced — e.g. a resurrected extension
    // `sandbox.html` realm copy — this test fails, so Wave 2's `.on` surface
    // can't be added to one copy while another is silently left broken.
    const srcRoot = resolve(repoRoot, 'packages/webapp/src');
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const tsFiles = walk(srcRoot);
    const definers = tsFiles
      .filter((f) => /function\s+createStdinShim\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(srcRoot, f).replaceAll('\\', '/'));
    expect(definers).toEqual(['kernel/realm/realm-node-shims.ts']);

    const shimSrc = readFileSync(resolve(srcRoot, 'kernel/realm/realm-node-shims.ts'), 'utf8');
    // Exactly two textual occurrences of `createStdinShim(`: the definition and
    // its single invocation.
    const occurrences = shimSrc.match(/createStdinShim\s*\(/g) ?? [];
    expect(occurrences).toHaveLength(2);
    // ...and that sole invocation lives inside createProcessShim.
    const processShimBody = shimSrc.slice(shimSrc.indexOf('function createProcessShim'));
    expect(processShimBody).toContain('createStdinShim(init.stdin');
  });

  // -------------------------------------------------------------------------
  // Wave 2 — EventEmitter surface behavior. Each test pins one Definition-of-
  // Done bullet for the `.on`/`'data'`/`'end'`/`'close'` shim.
  // -------------------------------------------------------------------------

  it('emits the whole buffer as one `data` chunk, then `end`, on a later tick', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/order.jsh': [
          'const order = [];',
          "process.stdin.on('data', (d) => order.push('data:' + d));",
          "process.stdin.on('end', () => {",
          "  order.push('end');",
          '  console.log(JSON.stringify(order));',
          '});',
          // Runs before any emission: proves emission is deferred to a later tick.
          "order.push('sync');",
        ].join('\n'),
      },
      {},
      undefined,
      'chunk-body'
    );
    const result = await executeJshFile('/workspace/order.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['sync', 'data:chunk-body', 'end']);
  });

  it('emits `end` with no `data` for empty stdin', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/empty-events.jsh': [
          'let dataCount = 0;',
          "process.stdin.on('data', () => dataCount++);",
          "process.stdin.on('end', () => console.log('end dataCount=' + dataCount));",
        ].join('\n'),
      },
      {},
      undefined,
      ''
    );
    const result = await executeJshFile('/workspace/empty-events.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('end dataCount=0');
  });

  it('fires `close` after `end` and never fires `error`', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/close-after-end.jsh': [
          'const seen = [];',
          "process.stdin.on('data', () => seen.push('data'));",
          "process.stdin.on('error', () => seen.push('error'));",
          "process.stdin.on('close', () => {",
          "  seen.push('close');",
          '  console.log(JSON.stringify(seen));',
          '});',
          "process.stdin.on('end', () => seen.push('end'));",
        ].join('\n'),
      },
      {},
      undefined,
      'x'
    );
    const result = await executeJshFile('/workspace/close-after-end.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['data', 'end', 'close']);
  });

  it('shares the one-shot `consumed` flag: read() after events returns null', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/events-then-read.jsh': [
          'let got = "";',
          "process.stdin.on('data', (d) => { got += d; });",
          "process.stdin.on('end', () => {",
          '  const after = process.stdin.read();',
          '  console.log(JSON.stringify({ got, after }));',
          '});',
        ].join('\n'),
      },
      {},
      undefined,
      'payload'
    );
    const result = await executeJshFile('/workspace/events-then-read.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ got: 'payload', after: null });
  });

  it('shares the one-shot `consumed` flag: events after read() emit only `end`', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/read-then-events.jsh': [
          'const first = process.stdin.read();',
          'let dataCount = 0;',
          "process.stdin.on('data', () => dataCount++);",
          "process.stdin.on('end', () => console.log(JSON.stringify({ first, dataCount })));",
        ].join('\n'),
      },
      {},
      undefined,
      'once-only'
    );
    const result = await executeJshFile('/workspace/read-then-events.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ first: 'once-only', dataCount: 0 });
  });

  it('setEncoding and no-encoding yield the same string chunk', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/encoding.jsh': [
          "process.stdin.setEncoding('utf8');",
          'let got = "";',
          "process.stdin.on('data', (d) => { got += d; });",
          "process.stdin.on('end', () => console.log(JSON.stringify({ got, type: typeof got })));",
        ].join('\n'),
      },
      {},
      undefined,
      'encoded-body'
    );
    const result = await executeJshFile('/workspace/encoding.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ got: 'encoded-body', type: 'string' });
  });

  it('preserves binary-shaped (latin1) stdin bytes verbatim through events', async () => {
    const bytes = String.fromCharCode(0x00, 0xff, 0x7f, 0x80, 0xc3, 0xa9);
    const ctx = createMockCtx(
      {
        '/workspace/echo-events.jsh': [
          'let data = "";',
          "process.stdin.on('data', (d) => { data += d; });",
          "process.stdin.on('end', () => {",
          '  const codes = [];',
          '  for (const c of data) codes.push(c.charCodeAt(0));',
          "  console.log(codes.join(','));",
          '});',
        ].join('\n'),
      },
      {},
      undefined,
      bytes
    );
    const result = await executeJshFile('/workspace/echo-events.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('0,255,127,128,195,169');
  });

  it('exposes the Node readable method surface with `this`-returning chains', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/surface.jsh': [
          'const s = process.stdin;',
          "const methods = ['on','once','off','removeListener','addListener','emit','pause','resume','setEncoding','pipe'];",
          'const shape = {};',
          'for (const m of methods) shape[m] = typeof s[m];',
          'const noop = () => {};',
          "const chains = s.addListener('x', noop) === s && s.off('x', noop) === s &&",
          '  s.pause() === s && s.resume() === s && s.setEncoding() === s;',
          'console.log(JSON.stringify({ shape, chains }));',
        ].join('\n'),
      },
      {},
      undefined,
      ''
    );
    const result = await executeJshFile('/workspace/surface.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.chains).toBe(true);
    for (const m of [
      'on',
      'once',
      'off',
      'removeListener',
      'addListener',
      'emit',
      'pause',
      'resume',
      'setEncoding',
      'pipe',
    ]) {
      expect(parsed.shape[m]).toBe('function');
    }
  });

  it('resume() triggers flowing mode without a `data` listener registered first', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/resume.jsh': [
          'let got = "";',
          "process.stdin.on('end', () => console.log('end:' + got));",
          "process.stdin.on('data', (d) => { got += d; });",
          'process.stdin.resume();',
        ].join('\n'),
      },
      {},
      undefined,
      'resumed'
    );
    const result = await executeJshFile('/workspace/resume.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('end:resumed');
  });

  // -------------------------------------------------------------------------
  // Review round 1 (PR #1730) — Codex inline comments. Each pins a reported
  // bug in the EventEmitter surface's deferred flush.
  // -------------------------------------------------------------------------

  it('P1: process.exit(N) from an `end` handler becomes the realm exit code', async () => {
    // r3665033022: flush() runs inside queueMicrotask, outside runUserCode's
    // try/catch, so a NodeExitError thrown by an `end` handler was lost — the
    // realm reported exit 0 (and surfaced an uncaught error) instead of N.
    const ctx = createMockCtx(
      {
        '/workspace/exit-in-end.jsh': [
          "process.stdin.on('data', (d) => process.stdout.write('got:' + d + '\\n'));",
          "process.stdin.on('end', () => process.exit(3));",
        ].join('\n'),
      },
      {},
      undefined,
      'payload'
    );
    const result = await executeJshFile('/workspace/exit-in-end.jsh', [], ctx);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('got:payload\n');
  });

  it('P1: process.exit(N) from a `data` handler exits before `end` fires', async () => {
    // Node's process.exit() terminates immediately, so a `data`-handler exit
    // must skip the subsequent `end`/`close` emission and carry code N.
    const ctx = createMockCtx(
      {
        '/workspace/exit-in-data.jsh': [
          "process.stdin.on('data', () => { process.stdout.write('data\\n'); process.exit(4); });",
          "process.stdin.on('end', () => process.stdout.write('end\\n'));",
        ].join('\n'),
      },
      {},
      undefined,
      'x'
    );
    const result = await executeJshFile('/workspace/exit-in-data.jsh', [], ctx);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe('data\n');
    expect(result.stdout).not.toContain('end');
  });

  it('P2: pause() before the scheduled flush suppresses emission until resume()', async () => {
    // r3665033027: `.on('data', h).pause()` still flushed on the scheduled
    // microtask — the buffer was consumed and emitted despite the pause, and a
    // later read() could not recover it. pause() must suppress the pending
    // flush; the buffer stays intact until resume() (or another surface) drains
    // it.
    const ctx = createMockCtx(
      {
        '/workspace/pause-suppress.jsh': [
          'const order = [];',
          "process.stdin.on('data', (d) => order.push('data:' + d));",
          "process.stdin.on('end', () => order.push('end'));",
          'process.stdin.pause();',
          'await new Promise((r) => setTimeout(r, 0));',
          'const recovered = process.stdin.read();',
          'console.log(JSON.stringify({ order, recovered }));',
        ].join('\n'),
      },
      {},
      undefined,
      'buffered'
    );
    const result = await executeJshFile('/workspace/pause-suppress.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ order: [], recovered: 'buffered' });
  });

  it('P2 guard: a synchronous pause().resume() still flushes within one hop', async () => {
    // The un-paused (and resync'd) path must keep emitting on the single
    // originally-scheduled microtask — no extra tick, no dropped `end` output.
    const ctx = createMockCtx(
      {
        '/workspace/pause-resume-sync.jsh': [
          'let got = "";',
          "process.stdin.on('data', (d) => { got += d; });",
          "process.stdin.on('end', () => console.log('end:' + got));",
          'process.stdin.pause();',
          'process.stdin.resume();',
        ].join('\n'),
      },
      {},
      undefined,
      'sync-body'
    );
    const result = await executeJshFile('/workspace/pause-resume-sync.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('end:sync-body');
  });
});
