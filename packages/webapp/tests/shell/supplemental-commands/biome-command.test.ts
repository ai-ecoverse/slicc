import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';
import {
  createBiomeCommand,
  expandPaths,
  isLintableFile,
  parseBiomeArgs,
} from '../../../src/shell/supplemental-commands/biome-command.js';
import {
  resetBiomeForTests,
  tryLoadBiomeWasmFromNodeModules,
} from '../../../src/shell/supplemental-commands/biome-runtime.js';

/**
 * The Biome WASM init pulls the wasm-nodejs binary into memory and
 * spins up a workspace; only the live lint/format paths need that.
 * Pure logic tests — argv parsing, lintable-file detection, path
 * expansion — always run. The heavy path is gated behind
 * SLICC_TEST_HEAVY_WASM=1, matching `esbuild-command.test.ts`.
 */
const heavyWasm = process.env.SLICC_TEST_HEAVY_WASM === '1';
const describeHeavy = heavyWasm ? describe : describe.skip;

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
      // Materialize parent directories so stat/readdir behave sanely.
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
    const parsed = parseBiomeArgs([]);
    expect(parsed.showHelp).toBe(true);
  });

  it('captures lint/format/check/ci as subcommand', () => {
    expect(parseBiomeArgs(['lint', 'a.ts']).subcommand).toBe('lint');
    expect(parseBiomeArgs(['format', 'a.ts']).subcommand).toBe('format');
    expect(parseBiomeArgs(['check', 'a.ts']).subcommand).toBe('check');
    expect(parseBiomeArgs(['ci', 'a.ts']).subcommand).toBe('ci');
  });

  it('treats unrecognized first arg as a path, not a subcommand', () => {
    const parsed = parseBiomeArgs(['not-a-subcommand.ts']);
    expect(parsed.subcommand).toBeNull();
    expect(parsed.paths).toEqual(['not-a-subcommand.ts']);
  });

  it('captures --write, --apply, --apply-unsafe in any order', () => {
    const parsed = parseBiomeArgs(['check', '--write', '--apply', 'src']);
    expect(parsed.write).toBe(true);
    expect(parsed.apply).toBe(true);
    expect(parsed.applyUnsafe).toBe(false);
    expect(parsed.paths).toEqual(['src']);

    const unsafe = parseBiomeArgs(['lint', '--apply-unsafe', 'src']);
    expect(unsafe.applyUnsafe).toBe(true);
  });

  it('parses --stdin-file-path with both equals and space forms', () => {
    expect(parseBiomeArgs(['lint', '--stdin-file-path=foo.ts']).stdinFilePath).toBe('foo.ts');
    expect(parseBiomeArgs(['lint', '--stdin-file-path', 'bar.ts']).stdinFilePath).toBe('bar.ts');
  });

  it('rejects a flag-shaped next token as the --stdin-file-path value', () => {
    expect(() => parseBiomeArgs(['lint', '--stdin-file-path', '--apply'])).toThrow(
      /--stdin-file-path requires a value/
    );
  });

  it('flags --help and --version', () => {
    expect(parseBiomeArgs(['--help']).showHelp).toBe(true);
    expect(parseBiomeArgs(['-v']).showVersion).toBe(true);
  });

  it('throws on unknown options', () => {
    expect(() => parseBiomeArgs(['lint', '--bogus'])).toThrow(/unknown option/);
  });
});

describe('isLintableFile', () => {
  it('recognizes JS/TS/JSON/CSS extensions', () => {
    expect(isLintableFile('/x/a.ts')).toBe(true);
    expect(isLintableFile('/x/a.tsx')).toBe(true);
    expect(isLintableFile('/x/a.jsx')).toBe(true);
    expect(isLintableFile('/x/a.json')).toBe(true);
    expect(isLintableFile('/x/a.jsonc')).toBe(true);
    expect(isLintableFile('/x/a.css')).toBe(true);
  });

  it('rejects unrelated and extensionless files', () => {
    expect(isLintableFile('/x/a.md')).toBe(false);
    expect(isLintableFile('/x/Makefile')).toBe(false);
    expect(isLintableFile('/x/.gitignore')).toBe(false);
  });
});

describe('expandPaths', () => {
  it('keeps file paths, walks directories, surfaces missing entries', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'x');
    await ctx.fs.writeFile('/workspace/sub/b.tsx', 'y');
    await ctx.fs.writeFile('/workspace/sub/readme.md', 'z');
    const { files, missing } = await expandPaths(ctx.fs, '/workspace', ['a.ts', 'sub', 'gone.ts']);
    expect(files).toContain('/workspace/a.ts');
    expect(files).toContain('/workspace/sub/b.tsx');
    expect(files).not.toContain('/workspace/sub/readme.md');
    expect(missing).toEqual(['gone.ts']);
  });
});

describe('createBiomeCommand (dispatch)', () => {
  it('shows help with no args', async () => {
    const cmd = createBiomeCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('biome - WASM build');
  });

  it('shows help with --help (no wasm load)', async () => {
    const cmd = createBiomeCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('biome - WASM build');
  });
});

/**
 * Build a minimal {@link ModuleReader} + `readBytes` pair over an in-memory
 * tree so the ipk node_modules resolution path is exercisable without a real
 * VFS. Mirrors the `esbuild-command.test.ts` fixture — wasm bytes flow
 * through `readBytes` (the resolver's `readFile` is text-only).
 */
function makeIpkFixture(
  files: Map<string, string>,
  dirs: Set<string>,
  bytes: Map<string, Uint8Array>
): { reader: ModuleReader; readBytes: (p: string) => Promise<Uint8Array> } {
  const reader: ModuleReader = {
    exists: async (path) => files.has(path) || dirs.has(path) || bytes.has(path),
    isDirectory: async (path) => dirs.has(path),
    readFile: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
  };
  const readBytes = async (path: string): Promise<Uint8Array> => {
    const b = bytes.get(path);
    if (b === undefined) throw new Error(`ENOENT: ${path}`);
    return b;
  };
  return { reader, readBytes };
}

describe('tryLoadBiomeWasmFromNodeModules', () => {
  it('resolves biome_wasm_bg.wasm bytes from an ipk-installed node_modules tree', async () => {
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const files = new Map<string, string>([
      [
        '/workspace/node_modules/@biomejs/wasm-web/package.json',
        JSON.stringify({ name: '@biomejs/wasm-web', version: '0.0.0-test' }),
      ],
    ]);
    const dirs = new Set<string>([
      '/',
      '/workspace',
      '/workspace/node_modules',
      '/workspace/node_modules/@biomejs',
      '/workspace/node_modules/@biomejs/wasm-web',
    ]);
    const bytes = new Map<string, Uint8Array>([
      ['/workspace/node_modules/@biomejs/wasm-web/biome_wasm_bg.wasm', wasmBytes],
    ]);
    const { reader, readBytes } = makeIpkFixture(files, dirs, bytes);

    const result = await tryLoadBiomeWasmFromNodeModules({
      reader,
      readBytes,
      fromDir: '/workspace',
    });

    expect(result).not.toBeNull();
    expect(result).toEqual(wasmBytes);
  });

  it('returns null when nothing is installed (CDN fallback engages)', async () => {
    const { reader, readBytes } = makeIpkFixture(
      new Map(),
      new Set(['/', '/workspace']),
      new Map()
    );

    const result = await tryLoadBiomeWasmFromNodeModules({
      reader,
      readBytes,
      fromDir: '/workspace',
    });

    expect(result).toBeNull();
  });

  it('returns null when the package directory exists but the .wasm is missing', async () => {
    const files = new Map<string, string>([
      [
        '/workspace/node_modules/@biomejs/wasm-web/package.json',
        JSON.stringify({ name: '@biomejs/wasm-web', version: '0.0.0-test' }),
      ],
    ]);
    const dirs = new Set<string>([
      '/',
      '/workspace',
      '/workspace/node_modules',
      '/workspace/node_modules/@biomejs',
      '/workspace/node_modules/@biomejs/wasm-web',
    ]);
    const { reader, readBytes } = makeIpkFixture(files, dirs, new Map());

    const result = await tryLoadBiomeWasmFromNodeModules({
      reader,
      readBytes,
      fromDir: '/workspace',
    });

    expect(result).toBeNull();
  });
});

describeHeavy('createBiomeCommand (live WASM)', () => {
  it('formats a TypeScript file in place with --write', async () => {
    resetBiomeForTests();
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/src.ts', 'const  x   =  1;export {x};\n');
    const result = await cmd.execute(['format', '--write', 'src.ts'], ctx);
    expect(result.exitCode).toBe(0);
    const out = await ctx.fs.readFile('/workspace/src.ts');
    expect(out).toMatch(/const x = 1;/);
  }, 60_000);

  it('lint of clean code returns exit 0', async () => {
    resetBiomeForTests();
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/clean.ts', 'export const a = 1;\n');
    const result = await cmd.execute(['lint', 'clean.ts'], ctx);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('exposes a version via --version', async () => {
    resetBiomeForTests();
    const cmd = createBiomeCommand();
    const result = await cmd.execute(['--version'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  it('check (no --write) exits non-zero on unformatted files', async () => {
    resetBiomeForTests();
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/unfmt.ts', 'const  x   =  1;export {x};\n');
    const result = await cmd.execute(['check', 'unfmt.ts'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not formatted/);
    // Source file must not have been mutated without --write.
    expect(await ctx.fs.readFile('/workspace/unfmt.ts')).toMatch(/const {2}x/);
  }, 60_000);

  it('ci (no --write) exits non-zero on unformatted files', async () => {
    resetBiomeForTests();
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/unfmt-ci.ts', 'const  x   =  1;export {x};\n');
    const result = await cmd.execute(['ci', 'unfmt-ci.ts'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not formatted/);
  }, 60_000);

  it('lint --apply persists safe fixes without requiring --write', async () => {
    resetBiomeForTests();
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    // `let x = 1` triggers Biome's `useConst` recommended rule, which
    // is a safe fix that rewrites `let` → `const`.
    await ctx.fs.writeFile('/workspace/fixme.ts', 'let x = 1;\nexport { x };\n');
    await cmd.execute(['lint', '--apply', 'fixme.ts'], ctx);
    const after = await ctx.fs.readFile('/workspace/fixme.ts');
    expect(after).toMatch(/const x = 1/);
  }, 60_000);
});
