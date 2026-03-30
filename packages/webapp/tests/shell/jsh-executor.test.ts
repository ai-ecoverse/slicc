import { describe, it, expect } from 'vitest';
import type { CommandContext, IFileSystem, FsStat } from 'just-bash';
import { executeJshFile, executeJsCode } from '../../src/shell/jsh-executor.js';

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
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): CommandContext {
  const env = new Map<string, string>(Object.entries(envVars));
  const ctx: CommandContext = {
    fs: createMockFs(files),
    cwd: '/workspace',
    env,
    stdin: '',
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

  it('provides fs.readFile for VFS access', async () => {
    const ctx = createMockCtx({
      '/workspace/reader.jsh':
        'const content = await fs.readFile("data.txt"); console.log(content);',
      '/workspace/data.txt': 'file contents here',
    });
    const result = await executeJshFile('/workspace/reader.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('file contents here');
  });

  it('provides fs.writeFile for VFS access', async () => {
    const ctx = createMockCtx({
      '/workspace/writer.jsh': 'await fs.writeFile("out.txt", "written!"); console.log("done");',
    });
    const result = await executeJshFile('/workspace/writer.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    // Verify the file was written via the mock fs
    const content = await ctx.fs.readFile('/workspace/out.txt');
    expect(content).toBe('written!');
  });

  it('provides fs.exists', async () => {
    const ctx = createMockCtx({
      '/workspace/check.jsh':
        'console.log(await fs.exists("data.txt")); console.log(await fs.exists("nope.txt"));',
      '/workspace/data.txt': 'exists',
    });
    const result = await executeJshFile('/workspace/check.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true\nfalse\n');
  });

  it('provides fs.readDir', async () => {
    const ctx = createMockCtx({
      '/workspace/lsdir.jsh':
        'const entries = await fs.readDir("."); console.log(entries.sort().join(","));',
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

  it('provides require that returns a promise (CDN-backed)', async () => {
    const ctx = createMockCtx({
      '/workspace/req.jsh':
        'const r = require("nonexistent-pkg-xyz"); console.log(typeof r.then); r.catch(() => {});',
    });
    const result = await executeJshFile('/workspace/req.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('function'); // require returns a Promise (thenable)
  });

  it('require catches network errors gracefully', async () => {
    const ctx = createMockCtx({
      '/workspace/req-err.jsh':
        'try { await require("this-package-definitely-does-not-exist-xyz123"); } catch(e) { console.log(e.message); }',
    });
    const result = await executeJshFile('/workspace/req-err.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('require');
    expect(result.stdout).toContain('esm.sh');
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
      'const data = await fs.readFile("data.txt"); console.log(data);',
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
      { '/workspace/run.jsh': 'const r = await exec("echo hello"); console.log(r.stdout.trim());' },
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
      { '/workspace/check.jsh': 'const r = await exec("bad-cmd"); console.log(r.exitCode);' },
      {},
      mockExec
    );
    const result = await executeJshFile('/workspace/check.jsh', [], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('127');
  });

  it('throws when exec is not available', async () => {
    const ctx = createMockCtx({
      '/workspace/noexec.jsh': 'try { await exec("ls"); } catch(e) { console.log(e.message); }',
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
      'const r = await exec("oauth-token adobe"); process.stdout.write(r.stdout);',
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
          'const r = await exec("restricted-cmd"); console.error(r.stderr.trim()); console.log(r.exitCode);',
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
