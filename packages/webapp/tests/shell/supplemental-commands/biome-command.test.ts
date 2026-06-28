import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  checkBiomeInstalled,
  createBiomeCommand,
  createIpkContextFromCtx,
  expandPaths,
  isLintableFile,
  parseBiomeArgs,
  tryReadBiomeWasmVersion,
} from '../../../src/shell/supplemental-commands/biome-command.js';

// The install-hint versions are derived from packages/webapp/package.json
// (via the Vite/vitest `__BIOME_*__` defines), so the test reads the same
// source — a Renovate bump updates both the hint and this assertion together.
const webappPkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf-8')
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
function pinnedVersion(name: string): string {
  const spec = webappPkg.dependencies?.[name] ?? webappPkg.devDependencies?.[name];
  if (!spec) throw new Error(`webapp package.json is missing a version for ${name}`);
  return spec.replace(/^[\^~]/, '');
}

function createMockCtx(
  overrides: Partial<{
    fs: Partial<IFileSystem>;
    cwd: string;
    stdin: string;
  }> = {}
): Parameters<ReturnType<typeof createBiomeCommand>['execute']>[1] {
  const fileStore = new Map<string, string>();
  const dirSet = new Set<string>(['/workspace']);
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) =>
      path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
    exists: vi.fn().mockImplementation(async (p: string) => fileStore.has(p) || dirSet.has(p)),
    readFile: vi.fn().mockImplementation(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }),
    writeFile: vi.fn().mockImplementation(async (p: string, content: string | Uint8Array) => {
      fileStore.set(p, typeof content === 'string' ? content : new TextDecoder().decode(content));
      const parts = p.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const seg = parts.slice(0, i).join('/') || '/';
        dirSet.add(seg);
      }
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      if (fileStore.has(p)) {
        return { isFile: true, isDirectory: false, size: fileStore.get(p)!.length };
      }
      if (dirSet.has(p)) {
        return { isFile: false, isDirectory: true, size: 0 };
      }
      throw new Error(`ENOENT: ${p}`);
    }),
    readdir: vi.fn().mockImplementation(async (p: string) => {
      const prefix = p === '/' ? '/' : `${p}/`;
      const out = new Set<string>();
      for (const f of fileStore.keys()) {
        if (f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0]);
      }
      for (const d of dirSet) {
        if (d.startsWith(prefix) && d !== p) out.add(d.slice(prefix.length).split('/')[0]);
      }
      return [...out];
    }),
    readFileBuffer: vi.fn().mockImplementation(async () => new Uint8Array()),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/workspace',
    env: new Map<string, string>(),
    stdin: overrides.stdin ?? '',
  } as ReturnType<typeof createMockCtx> & {
    fs: IFileSystem;
    cwd: string;
    env: Map<string, string>;
    stdin: string;
  };
}

describe('parseBiomeArgs', () => {
  it('returns showHelp when no args are passed', () => {
    expect(parseBiomeArgs([]).showHelp).toBe(true);
  });

  it('captures check/format as subcommand', () => {
    expect(parseBiomeArgs(['check', 'a.ts']).subcommand).toBe('check');
    expect(parseBiomeArgs(['format', 'a.ts']).subcommand).toBe('format');
  });

  it('captures --write and --stdin-file-path', () => {
    const parsed = parseBiomeArgs(['format', '--write', 'a.ts']);
    expect(parsed.write).toBe(true);
    const stdin = parseBiomeArgs(['check', '--stdin-file-path', '/foo.ts']);
    expect(stdin.stdinFilePath).toBe('/foo.ts');
    const stdinEq = parseBiomeArgs(['check', '--stdin-file-path=/bar.ts']);
    expect(stdinEq.stdinFilePath).toBe('/bar.ts');
  });

  it('captures --version and --help', () => {
    expect(parseBiomeArgs(['--version']).showVersion).toBe(true);
    expect(parseBiomeArgs(['--help']).showHelp).toBe(true);
  });

  it('rejects unknown flags', () => {
    expect(() => parseBiomeArgs(['--bogus'])).toThrow(/unknown option/);
  });
});

describe('isLintableFile', () => {
  it('matches known source extensions', () => {
    expect(isLintableFile('a.ts')).toBe(true);
    expect(isLintableFile('b.json')).toBe(true);
    expect(isLintableFile('c.css')).toBe(true);
    expect(isLintableFile('d.svelte')).toBe(true);
  });

  it('rejects unknown extensions and extensionless names', () => {
    expect(isLintableFile('a.bin')).toBe(false);
    expect(isLintableFile('README')).toBe(false);
  });
});

describe('expandPaths', () => {
  it('keeps existing files as-is and reports missing ones', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'x');
    const r = await expandPaths(ctx.fs, ctx.cwd, ['a.ts', 'missing.ts']);
    expect(r.files).toEqual(['/workspace/a.ts']);
    expect(r.missing).toEqual(['missing.ts']);
  });
});

describe('install-required guidance', () => {
  it('tryReadBiomeWasmVersion returns null when wasm-web is absent', async () => {
    const ctx = createMockCtx();
    const v = await tryReadBiomeWasmVersion(createIpkContextFromCtx(ctx));
    expect(v).toBeNull();
  });

  it('checkBiomeInstalled reports the missing package by name', async () => {
    const ctx = createMockCtx();
    const result = await checkBiomeInstalled(createIpkContextFromCtx(ctx));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toBe('@biomejs/wasm-web');
  });

  it('checkBiomeInstalled reports esbuild-wasm missing when only the biome packages are present', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/node_modules/@biomejs/wasm-web/package.json',
      JSON.stringify({ version: '2.5.1' })
    );
    await ctx.fs.writeFile(
      '/workspace/node_modules/@biomejs/js-api/package.json',
      JSON.stringify({ version: '6.0.0' })
    );
    await ctx.fs.writeFile(
      '/workspace/node_modules/@biomejs/js-api/web.js',
      'module.exports = {};'
    );
    const result = await checkBiomeInstalled(createIpkContextFromCtx(ctx));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toBe('esbuild-wasm');
  });

  it('the install hint names all three pinned packages with no network fallback', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'const x=1;');
    const res = await cmd.execute(['check', 'a.ts'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`@biomejs/wasm-web@${pinnedVersion('@biomejs/wasm-web')}`);
    expect(res.stderr).toContain(`@biomejs/js-api@${pinnedVersion('@biomejs/js-api')}`);
    expect(res.stderr).toContain(`esbuild-wasm@${pinnedVersion('esbuild-wasm')}`);
    expect(res.stderr).not.toMatch(/https?:\/\//);
  });

  it('biome --version exits 1 with a `ipk add` hint when nothing is installed', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    const res = await cmd.execute(['--version'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/ipk add @biomejs\/wasm-web/);
    expect(res.stderr).not.toMatch(/https?:\/\//);
  });

  it('biome check exits 1 with guidance when the package is missing', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'const x=1;');
    const res = await cmd.execute(['check', 'a.ts'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/ipk add @biomejs\/wasm-web/);
    expect(res.stderr).not.toMatch(/unpkg|jsdelivr|esm\.sh/);
  });
});

describe('biome --help / argument errors', () => {
  it('prints help with no args', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    const res = await cmd.execute([], ctx);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/biome - thin wrapper/);
    expect(res.stdout).toMatch(/ipk add @biomejs\/wasm-web/);
  });

  it('exits 2 on an unknown flag', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    const res = await cmd.execute(['--frobnicate'], ctx);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/unknown option/);
  });
});
