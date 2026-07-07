/**
 * Shared in-process realm harness for the CJS require/resolution suites
 * (m4-cjs-require-rewire). Drives the same `runJsRealm` engine the production
 * worker/iframe floats use (so behavior parity is by construction) over a
 * directory-aware in-memory VFS, exercising the `module`/buildGraph RPC end to
 * end. Used by `cjs-require-rewire.test.ts` and `cjs-resolution-paths.test.ts`.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { normalizePath } from '../../../src/fs/path-utils.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import { executeJsCode } from '../../../src/shell/jsh-executor.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Directory-aware in-memory filesystem (models node_modules nesting). */
export function makeTreeFs(files: Record<string, string>): IFileSystem {
  const store = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalizePath(rawPath);
    store.set(path, content);
    let dir = path.slice(0, path.lastIndexOf('/')) || '/';
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/')) || (dir === '/' ? '' : '/');
      if (dir === '/') {
        dirs.add('/');
        break;
      }
    }
  }
  const fileStat = (size: number, isDir: boolean): FsStat => ({
    isFile: !isDir,
    isDirectory: isDir,
    isSymbolicLink: false,
    mode: 0o644,
    size,
    mtime: new Date(),
  });
  const fs: IFileSystem = {
    async readFile(p: string): Promise<string> {
      const v = store.get(normalizePath(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async readFileBuffer(p: string): Promise<Uint8Array> {
      return new TextEncoder().encode(await fs.readFile(p));
    },
    async writeFile(p: string, c: string | Uint8Array): Promise<void> {
      store.set(normalizePath(p), typeof c === 'string' ? c : new TextDecoder().decode(c));
    },
    async appendFile(p: string, c: string | Uint8Array): Promise<void> {
      const path = normalizePath(p);
      store.set(
        path,
        (store.get(path) || '') + (typeof c === 'string' ? c : new TextDecoder().decode(c))
      );
    },
    async exists(p: string): Promise<boolean> {
      const path = normalizePath(p);
      return store.has(path) || dirs.has(path);
    },
    async stat(p: string): Promise<FsStat> {
      const path = normalizePath(p);
      if (store.has(path)) return fileStat((store.get(path) || '').length, false);
      if (dirs.has(path)) return fileStat(0, true);
      throw new Error(`ENOENT: ${p}`);
    },
    async mkdir(): Promise<void> {},
    async readdir(p: string): Promise<string[]> {
      const path = normalizePath(p);
      const prefix = path === '/' ? '/' : `${path}/`;
      const names = new Set<string>();
      for (const key of [...store.keys(), ...dirs]) {
        if (key !== path && key.startsWith(prefix)) {
          names.add(key.slice(prefix.length).split('/')[0]);
        }
      }
      return [...names];
    },
    async rm(p: string): Promise<void> {
      store.delete(normalizePath(p));
    },
    async cp(): Promise<void> {},
    async mv(): Promise<void> {},
    resolvePath(base: string, p: string): string {
      if (p.startsWith('/')) return normalizePath(p);
      return normalizePath(`${base}/${p}`);
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
      return normalizePath(p);
    },
    async utimes(): Promise<void> {},
  };
  return fs;
}

export function makeCtx(
  opts: {
    files?: Record<string, string>;
    cwd?: string;
    exec?: CommandContext['exec'];
    fetch?: CommandContext['fetch'];
  } = {}
): CommandContext {
  const ctx: CommandContext = {
    fs: makeTreeFs(opts.files ?? {}),
    cwd: opts.cwd ?? '/workspace',
    env: new Map<string, string>(),
    stdin: unsafeBytesFromLatin1(''),
  };
  if (opts.exec) ctx.exec = opts.exec;
  if (opts.fetch) ctx.fetch = opts.fetch;
  return ctx;
}

/**
 * Run inline code the way `node -e "<code>"` does: the realm's `filename` is
 * the synthetic `[eval]` marker so top-level relative/bare requires resolve
 * against the realm `cwd`.
 */
export async function runCode(
  code: string,
  ctx: CommandContext,
  argv: string[] = ['node']
): Promise<RunResult> {
  return executeJsCode(code, argv, ctx, undefined, {
    realmFactory: createInProcessJsRealmFactory(),
  });
}

/**
 * Run a script file the way `node <scriptPath>` does (see `node-command.ts`):
 * the realm reads the file's source as the entry code and sets `filename` to
 * the resolved absolute path, so the entry's requires resolve against the
 * script's OWN directory and `__dirname`/`__filename` reflect it.
 */
export async function runScript(
  scriptPath: string,
  ctx: CommandContext,
  args: string[] = []
): Promise<RunResult> {
  const code = await ctx.fs.readFile(scriptPath);
  return executeJsCode(code, ['node', scriptPath, ...args], ctx, undefined, {
    realmFactory: createInProcessJsRealmFactory(),
    filename: scriptPath,
  });
}
