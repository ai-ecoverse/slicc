/**
 * Tests for the `node` command — in particular the fix for
 * VAL-GLOBALS-005: `node <relative-path>` must pass an absolute
 * VFS path as argv[1] so that skill.dir (derived from
 * dirname(argv[1]) in skill-global.ts), __dirname, and __filename
 * are all correct for both relative and absolute invocations.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createNodeCommand } from '../../../src/shell/supplemental-commands/node-command.js';

/** Minimal in-memory IFileSystem for tests — mirrors jsh-executor.test.ts */
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
    async rm(): Promise<void> {
      /* noop */
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

function createMockCtx(files: Record<string, string> = {}, cwd = '/workspace'): CommandContext {
  return {
    fs: createMockFs(files),
    cwd,
    env: new Map(),
    stdin: '',
  };
}

describe('node command — trusted dispatch', () => {
  it('is registered as a trusted command so the worker realm gets unpatched async I/O', () => {
    // just-bash runs untrusted commands inside a defense-in-depth box that
    // monkey-patches async primitives, which breaks the cross-thread worker RPC
    // await and drops a failing require's non-zero exit on the floor (exit 0).
    // The command must be trusted, like the `.jsh` script command.
    expect(createNodeCommand().trusted).toBe(true);
  });
});

describe('node command — relative script path absolutization', () => {
  it('passes an absolute argv[1] when invoked with a relative script path', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/skills/my-skill/run.jsh': 'console.log("argv[1] is: " + process.argv[1]);',
      },
      '/workspace/skills/my-skill'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./run.jsh'], ctx);

    expect(result.exitCode).toBe(0);
    // argv[1] must be the absolute path, not the relative ./run.jsh
    expect(result.stdout.trim()).toBe('argv[1] is: /workspace/skills/my-skill/run.jsh');
  });

  it('passes the script path as argv[1] with extra args intact', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/scripts/test.jsh': 'console.log(JSON.stringify(process.argv));',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./scripts/test.jsh', '--flag', 'value'], ctx);

    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(result.stdout.trim());
    expect(argv[0]).toBe('node');
    expect(argv[1]).toBe('/workspace/scripts/test.jsh');
    expect(argv[2]).toBe('--flag');
    expect(argv[3]).toBe('value');
  });

  it('skill.dir derives the absolute dirname when the script is relative (VAL-GLOBALS-005)', async () => {
    // skill.dir = dirname(argv[1]) — we verify that argv[1] is absolute so dirname is non-empty.
    // We implement dirname inline since `path` may not be available in all test realms.
    const ctx = createMockCtx(
      {
        '/workspace/skills/concur/concur.jsh':
          'const p = process.argv[1]; const idx = p.lastIndexOf("/"); const dir = idx < 0 ? "" : (idx === 0 ? "/" : p.substring(0, idx)); console.log(dir);',
      },
      '/workspace/skills/concur'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./concur.jsh'], ctx);

    expect(result.exitCode).toBe(0);
    // argv[1] is now absolute, so dirname is non-empty (the absolute script's directory)
    expect(result.stdout.trim()).toBe('/workspace/skills/concur');
  });

  it('__dirname is absolute and correct for a relative invocation', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/myscript.jsh': 'console.log(__dirname);',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./myscript.jsh'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/workspace');
  });

  it('__filename is the absolute script path for a relative invocation', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/myscript.jsh': 'console.log(__filename);',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./myscript.jsh'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/workspace/myscript.jsh');
  });

  it('absolute script path invocation is unchanged (argv[1] still absolute)', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/scripts/other.jsh': 'console.log("argv[1] is: " + process.argv[1]);',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['/workspace/scripts/other.jsh'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('argv[1] is: /workspace/scripts/other.jsh');
  });

  it('absolute invocation gives correct __dirname and argv[1] dirname', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/skills/oryx/oryx.jsh':
          'const p = process.argv[1]; const idx = p.lastIndexOf("/"); const dir = idx < 0 ? "" : (idx === 0 ? "/" : p.substring(0, idx)); console.log("argv1-dir:" + dir + " __dirname:" + __dirname);',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['/workspace/skills/oryx/oryx.jsh'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'argv1-dir:/workspace/skills/oryx __dirname:/workspace/skills/oryx'
    );
  });

  it('reports "cannot find module" for a relative path that does not exist', async () => {
    const ctx = createMockCtx({}, '/workspace');
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./nonexistent.jsh'], ctx);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot find module');
  });
});
