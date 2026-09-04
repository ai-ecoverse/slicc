/**
 * Tests for the `node` command — in particular the fix for
 * VAL-GLOBALS-005: `node <relative-path>` must pass an absolute
 * VFS path as argv[1] so that skill.dir (derived from
 * dirname(argv[1]) in skill-global.ts), __dirname, and __filename
 * are all correct for both relative and absolute invocations.
 */

import type { FsStat, IFileSystem, ResolvedCommandContext } from 'just-bash';
import { createCommandContext, unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createNodeCommand } from '../../../src/shell/supplemental-commands/node-command.js';
import { NODE_VERSION } from '../../../src/shell/supplemental-commands/shared.js';

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

function createMockCtx(
  files: Record<string, string> = {},
  cwd = '/workspace'
): ResolvedCommandContext {
  return createCommandContext({
    fs: createMockFs(files),
    cwd,
    env: new Map(),
    stdin: unsafeBytesFromLatin1(''),
  });
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

describe('node command — shebang stripping (Wave 15 / fix B1)', () => {
  it('runs a shebang-prefixed script file without a parse error', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/x.js': '#!/usr/bin/env node\nconsole.log("hi");\n',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./x.js'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.stderr).not.toMatch(/SyntaxError|Unexpected/);
  });

  it('runs a shebang-prefixed script read from stdin without a parse error', async () => {
    const ctx = createCommandContext({
      fs: createMockFs(),
      cwd: '/workspace',
      env: new Map(),
      stdin: unsafeBytesFromLatin1('#!/usr/bin/env node\nconsole.log("via stdin");\n'),
    });
    const cmd = createNodeCommand();
    const result = await cmd.execute([], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('via stdin');
    expect(result.stderr).not.toMatch(/SyntaxError|Unexpected/);
  });

  it('leaves scripts without a shebang line untouched', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/y.js': 'console.log("no shebang");\n',
      },
      '/workspace'
    );
    const cmd = createNodeCommand();
    const result = await cmd.execute(['./y.js'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('no shebang');
  });
});

describe('node command — explicit stdin script tokens (`node /dev/stdin << EOF`)', () => {
  function stdinCtx(code: string, files: Record<string, string> = {}): ResolvedCommandContext {
    return createCommandContext({
      fs: createMockFs(files),
      cwd: '/workspace',
      env: new Map(),
      stdin: unsafeBytesFromLatin1(code),
    });
  }

  for (const token of ['/dev/stdin', '-', '/dev/fd/0', '/proc/self/fd/0']) {
    it(`runs the heredoc body when invoked as \`node ${token}\``, async () => {
      const ctx = stdinCtx('console.log("from heredoc");\n');
      const result = await createNodeCommand().execute([token], ctx);

      expect(result.stderr).not.toContain('cannot find module');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from heredoc');
    });
  }

  it('keeps the token at argv[1] and forwards trailing args at argv[2…]', async () => {
    const ctx = stdinCtx('console.log(JSON.stringify(process.argv));\n');
    const result = await createNodeCommand().execute(['/dev/stdin', '--flag', 'value'], ctx);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['node', '/dev/stdin', '--flag', 'value']);
  });

  it('does not feed the script its own source as stdin', async () => {
    const ctx = stdinCtx(
      'console.log("stdin-len:" + require("fs").readFileSync(0, "utf8").length);\n'
    );
    const result = await createNodeCommand().execute(['/dev/stdin'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('stdin-len:0');
  });

  it('strips a shebang from the heredoc body', async () => {
    const ctx = stdinCtx('#!/usr/bin/env node\nconsole.log("shebang ok");\n');
    const result = await createNodeCommand().execute(['/dev/stdin'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('shebang ok');
    expect(result.stderr).not.toMatch(/SyntaxError|Unexpected/);
  });

  it('still reports "cannot find module" for a real missing path under /dev', async () => {
    const ctx = stdinCtx('console.log("unused");\n');
    const result = await createNodeCommand().execute(['/dev/null'], ctx);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot find module');
  });
});

describe('node command — --help / --version are node options, not script args', () => {
  function stdinCtx(code: string): ResolvedCommandContext {
    return createCommandContext({
      fs: createMockFs(),
      cwd: '/workspace',
      env: new Map(),
      stdin: unsafeBytesFromLatin1(code),
    });
  }

  it('still prints usage for a bare `node --help`', async () => {
    const result = await createNodeCommand().execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: node');
  });

  it('still prints the version for a bare `node -v`', async () => {
    const result = await createNodeCommand().execute(['-v'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(NODE_VERSION);
  });

  it('forwards `--help` after /dev/stdin to the script instead of printing usage', async () => {
    const ctx = stdinCtx('console.log(JSON.stringify(process.argv.slice(2)));\n');
    const result = await createNodeCommand().execute(['/dev/stdin', '--help'], ctx);

    expect(result.stdout).not.toContain('usage: node');
    expect(JSON.parse(result.stdout.trim())).toEqual(['--help']);
  });

  it('forwards `-v` after `-` to the script instead of printing the version', async () => {
    const ctx = stdinCtx('console.log(JSON.stringify(process.argv.slice(2)));\n');
    const result = await createNodeCommand().execute(['-', '-v'], ctx);

    expect(result.stdout.trim()).not.toBe(NODE_VERSION);
    expect(JSON.parse(result.stdout.trim())).toEqual(['-v']);
  });

  it('forwards `--version` after a script path to the script', async () => {
    const ctx = createMockCtx(
      { '/workspace/a.js': 'console.log(JSON.stringify(process.argv.slice(2)));' },
      '/workspace'
    );
    const result = await createNodeCommand().execute(['./a.js', '--version'], ctx);

    expect(result.stdout.trim()).not.toBe(NODE_VERSION);
    expect(JSON.parse(result.stdout.trim())).toEqual(['--version']);
  });

  it('forwards `-h` after `-e` code to the script', async () => {
    const ctx = createMockCtx({}, '/workspace');
    const result = await createNodeCommand().execute(
      ['-e', 'console.log(JSON.stringify(process.argv.slice(1)));', '-h'],
      ctx
    );

    expect(result.stdout).not.toContain('usage: node');
    expect(JSON.parse(result.stdout.trim())).toEqual(['-h']);
  });

  it('lists --check in `node --help`', async () => {
    const result = await createNodeCommand().execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--check');
    expect(result.stdout).toContain('-e, --eval');
  });
});

describe('node command — --check syntax-checks without executing', () => {
  it('accepts a valid script and does not run it', async () => {
    const ctx = createMockCtx(
      {
        '/workspace/ok.js': 'console.log("should not run"); throw new Error("nope");\n',
      },
      '/workspace'
    );
    const result = await createNodeCommand().execute(['--check', './ok.js'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('accepts `-c` as the short form', async () => {
    const ctx = createMockCtx({ '/workspace/ok.js': 'const x = 1;\n' }, '/workspace');
    const result = await createNodeCommand().execute(['-c', './ok.js'], ctx);
    expect(result.exitCode).toBe(0);
  });

  it('rejects a syntax error with exit 1', async () => {
    const ctx = createMockCtx({ '/workspace/bad.js': 'const {\n' }, '/workspace');
    const result = await createNodeCommand().execute(['--check', './bad.js'], ctx);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/SyntaxError|Unexpected|Invalid/i);
  });

  it('accepts top-level await (the realm wraps the entry in AsyncFunction)', async () => {
    const ctx = createMockCtx({ '/workspace/tla.js': 'await Promise.resolve(1);\n' }, '/workspace');
    const result = await createNodeCommand().execute(['--check', './tla.js'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('syntax-checks `-e` code without evaluating it', async () => {
    const result = await createNodeCommand().execute(
      ['--check', '-e', 'console.log("nope"); throw new Error("nope");'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('errors when --check has no program source', async () => {
    const result = await createNodeCommand().execute(['--check'], createMockCtx());
    expect(result.exitCode).toBe(9);
    expect(result.stderr).toContain('--check');
  });
});
