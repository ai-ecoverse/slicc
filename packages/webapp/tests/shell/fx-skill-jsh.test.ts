/**
 * The shipped `fx.jsh` (Vercel fx agent host) loaded from the on-disk
 * vfs-root payload into a real `.jsh` realm. Covers the pre-runtime paths
 * that need no `libfx` install or Gateway credential: usage, the missing-key
 * guard, and the missing-package guidance — the realm resolves `require()`
 * at call time, so those branches run without `fx-core.wasm` present.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { afterEach, describe, expect, it } from 'vitest';
import { executeJshFile } from '../../src/shell/jsh-executor.js';
import { registerProviderEnvSeeder } from '../../src/shell/provider-env-seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const FX_JSH = readFileSync(
  resolve(repoRoot, 'packages/vfs-root/workspace/skills/fx/fx.jsh'),
  'utf8'
);

function makeFs(files: Record<string, string>): IFileSystem {
  const store = new Map(Object.entries(files));
  const fs: IFileSystem = {
    async readFile(p) {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async readFileBuffer(p) {
      return new TextEncoder().encode(await fs.readFile(p));
    },
    async writeFile(p, c) {
      store.set(p, typeof c === 'string' ? c : new TextDecoder().decode(c));
    },
    async appendFile(p, c) {
      store.set(
        p,
        (store.get(p) ?? '') + (typeof c === 'string' ? c : new TextDecoder().decode(c))
      );
    },
    async exists(p) {
      return store.has(p);
    },
    async stat(p): Promise<FsStat> {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: store.get(p)?.length ?? 0,
        mtime: new Date(),
      };
    },
    async mkdir() {},
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const names = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
    async rm(p) {
      store.delete(p);
    },
    async cp() {},
    async mv() {},
    resolvePath(base, p) {
      return p.startsWith('/') ? p : `${base}/${p}`;
    },
    async symlink() {},
    async readlink() {
      return '';
    },
    async lstat(p) {
      return fs.stat(p);
    },
    async realpath(p) {
      return p;
    },
    async utimes() {},
    getAllPaths() {
      return [...store.keys()];
    },
    async chmod() {},
    async link() {},
  };
  return fs;
}

function ctxWith(env: Record<string, string> = {}): CommandContext {
  return {
    fs: makeFs({ '/workspace/skills/fx/fx.jsh': FX_JSH }),
    cwd: '/workspace',
    env: new Map(Object.entries(env)),
    stdin: unsafeBytesFromLatin1(''),
  };
}

const run = (args: string[], env?: Record<string, string>) =>
  executeJshFile('/workspace/skills/fx/fx.jsh', args, ctxWith(env));

afterEach(() => registerProviderEnvSeeder(null));

describe('fx.jsh (bundled skill)', () => {
  it('prints usage and exits 0 on --help, 2 with no prompt', async () => {
    const help = await run(['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage: fx');
    expect(help.stdout).toContain('ipk add libfx@');
    const bare = await run([]);
    expect(bare.exitCode).toBe(2);
    expect(bare.stdout).toContain('Usage: fx');
  });

  it('refuses to start without AI_GATEWAY_API_KEY and names the provider to add', async () => {
    const r = await run(['hello']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AI_GATEWAY_API_KEY is not set');
    expect(r.stderr).toContain('Vercel AI Gateway');
  });

  it('picks up the seeded key and reports the missing libfx/esbuild install', async () => {
    registerProviderEnvSeeder(() => ({ AI_GATEWAY_API_KEY: 'vck_test' }));
    const r = await run(['hello']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      'cannot load libfx (run: ipk add esbuild-wasm@0.28.2 && ipk add libfx@0.0.4)'
    );
  });
});
