import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';
import {
  createEsbuildCommand,
  createVfsPlugin,
  inferLoader,
  parseEsbuildArgs,
} from '../../../src/shell/supplemental-commands/esbuild-command.js';
import {
  resetEsbuildForTests,
  tryLoadEsbuildWasmFromNodeModules,
} from '../../../src/shell/supplemental-commands/esbuild-wasm.js';

/**
 * The full WASM init is heavy in CI (esbuild-wasm spawns a child
 * `node bin/esbuild` and pulls in the wasm binary), so the live
 * build/transform paths are gated behind SLICC_TEST_HEAVY_WASM=1.
 * Pure logic tests — argv parsing, loader inference, plugin
 * resolve/load wiring — always run.
 */
const heavyWasm = process.env.SLICC_TEST_HEAVY_WASM === '1';
const describeHeavy = heavyWasm ? describe : describe.skip;

function createMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string; stdin: string }> = {}
): Parameters<ReturnType<typeof createEsbuildCommand>['execute']>[1] {
  const fileStore = new Map<string, string>();
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) =>
      path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
    exists: vi.fn().mockImplementation(async (p: string) => fileStore.has(p)),
    readFile: vi.fn().mockImplementation(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }),
    writeFile: vi.fn().mockImplementation(async (p: string, content: string | Uint8Array) => {
      fileStore.set(p, typeof content === 'string' ? content : new TextDecoder().decode(content));
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      if (!fileStore.has(p)) throw new Error(`ENOENT: ${p}`);
      return { isFile: true, isDirectory: false, size: fileStore.get(p)!.length };
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

describe('parseEsbuildArgs', () => {
  it('collects entry points and toggles --bundle', () => {
    const parsed = parseEsbuildArgs(['--bundle', 'src/index.ts']);
    expect(parsed.bundle).toBe(true);
    expect(parsed.entries).toEqual(['src/index.ts']);
  });

  it('parses --format with both equals and space forms', () => {
    expect(parseEsbuildArgs(['--format=cjs', 'a.js']).format).toBe('cjs');
    expect(parseEsbuildArgs(['--format', 'esm', 'a.js']).format).toBe('esm');
  });

  it('rejects an invalid --format value', () => {
    expect(() => parseEsbuildArgs(['--format=amd', 'a.js'])).toThrow(/--format/);
  });

  it('captures --minify, --sourcemap, --target, --loader, --outfile', () => {
    const parsed = parseEsbuildArgs([
      '--bundle',
      '--minify',
      '--sourcemap=inline',
      '--target=es2020,chrome100',
      '--loader=ts',
      '--outfile',
      'out/bundle.js',
      'src/index.ts',
    ]);
    expect(parsed.minify).toBe(true);
    expect(parsed.sourcemap).toBe('inline');
    expect(parsed.target).toEqual(['es2020', 'chrome100']);
    expect(parsed.loader).toBe('ts');
    expect(parsed.outfile).toBe('out/bundle.js');
    expect(parsed.entries).toEqual(['src/index.ts']);
  });

  it('treats bare --sourcemap as boolean-true', () => {
    expect(parseEsbuildArgs(['--sourcemap', 'a.js']).sourcemap).toBe(true);
  });

  it('rejects an invalid --sourcemap value', () => {
    expect(() => parseEsbuildArgs(['--sourcemap=lol', 'a.js'])).toThrow(/--sourcemap/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseEsbuildArgs(['--frobnicate'])).toThrow(/unknown option/);
  });

  it('throws when --outfile is missing its value', () => {
    expect(() => parseEsbuildArgs(['--outfile'])).toThrow(/requires a value/);
  });

  it('rejects flag-shaped next tokens as option values', () => {
    expect(() => parseEsbuildArgs(['--outfile', '--minify'])).toThrow(/requires a value/);
  });

  it('accepts --sourcemap <value> when next token is a valid enum', () => {
    const parsed = parseEsbuildArgs(['--sourcemap', 'inline', 'a.js']);
    expect(parsed.sourcemap).toBe('inline');
    expect(parsed.entries).toEqual(['a.js']);
  });
});

describe('inferLoader', () => {
  it('maps file extensions to esbuild loaders', () => {
    expect(inferLoader('a.ts')).toBe('ts');
    expect(inferLoader('a.tsx')).toBe('tsx');
    expect(inferLoader('a.jsx')).toBe('jsx');
    expect(inferLoader('a.js')).toBe('js');
    expect(inferLoader('a.mjs')).toBe('js');
    expect(inferLoader('a.cjs')).toBe('js');
    expect(inferLoader('a.json')).toBe('json');
    expect(inferLoader('a.css')).toBe('css');
    expect(inferLoader('a.txt')).toBe('text');
  });

  it('defaults unknown extensions to js', () => {
    expect(inferLoader('a.weird')).toBe('js');
    expect(inferLoader('no-ext')).toBe('js');
  });
});

describe('createVfsPlugin', () => {
  // The plugin captures `build` from a fake PluginBuild and we drive
  // its onResolve/onLoad callbacks directly. This isolates the
  // routing logic from the full esbuild service.
  interface Cb<TArgs, TResult> {
    filter: RegExp;
    namespace?: string;
    fn: (args: TArgs) => Promise<TResult> | TResult;
  }

  function makeFakeBuild() {
    type ResolveCb = Cb<
      Parameters<Parameters<import('esbuild-wasm').PluginBuild['onResolve']>[1]>[0],
      Awaited<ReturnType<Parameters<import('esbuild-wasm').PluginBuild['onResolve']>[1]>>
    >;
    type LoadCb = Cb<
      Parameters<Parameters<import('esbuild-wasm').PluginBuild['onLoad']>[1]>[0],
      Awaited<ReturnType<Parameters<import('esbuild-wasm').PluginBuild['onLoad']>[1]>>
    >;
    const resolvers: ResolveCb[] = [];
    const loaders: LoadCb[] = [];
    const build = {
      onResolve: (opts: { filter: RegExp; namespace?: string }, fn: ResolveCb['fn']): void => {
        resolvers.push({ filter: opts.filter, namespace: opts.namespace, fn });
      },
      onLoad: (opts: { filter: RegExp; namespace?: string }, fn: LoadCb['fn']): void => {
        loaders.push({ filter: opts.filter, namespace: opts.namespace, fn });
      },
    } as unknown as import('esbuild-wasm').PluginBuild;
    return { build, resolvers, loaders };
  }

  it('routes bare specifiers to the esm.sh http-url namespace', async () => {
    const ctx = createMockCtx();
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd);
    const { build, resolvers } = makeFakeBuild();
    await plugin.setup(build);
    const resolved = await resolvers[0].fn({
      path: 'react',
      importer: '/workspace/src/index.ts',
      namespace: 'file',
      resolveDir: '/workspace/src',
      kind: 'import-statement',
      pluginData: undefined,
      with: {},
    });
    expect(resolved?.path).toBe('https://esm.sh/react');
    expect(resolved?.namespace).toBe('http-url');
  });

  it('resolves relative imports against the VFS', async () => {
    const ctx = createMockCtx({
      fs: {
        resolvePath: (base: string, path: string) => {
          // Minimal `./` normalization so the test mirrors the real
          // VFS resolver's behavior closely enough for the plugin.
          const joined = path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`;
          return joined.replace(/\/\.\//g, '/').replace(/\/+$/, '');
        },
        exists: vi.fn().mockImplementation(async (p: string) => p === '/workspace/src/util.ts'),
        stat: vi.fn().mockResolvedValue({ isFile: true, isDirectory: false, size: 0 } as never),
      },
    });
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd);
    const { build, resolvers } = makeFakeBuild();
    await plugin.setup(build);
    const resolved = await resolvers[0].fn({
      path: './util',
      importer: '/workspace/src/index.ts',
      namespace: 'file',
      resolveDir: '/workspace/src',
      kind: 'import-statement',
      pluginData: undefined,
      with: {},
    });
    expect(resolved?.path).toBe('/workspace/src/util.ts');
  });

  it('marks unknown protocols (node:fs) as external', async () => {
    const ctx = createMockCtx();
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd);
    const { build, resolvers } = makeFakeBuild();
    await plugin.setup(build);
    const resolved = await resolvers[0].fn({
      path: 'node:fs',
      importer: '/workspace/src/index.ts',
      namespace: 'file',
      resolveDir: '/workspace/src',
      kind: 'import-statement',
      pluginData: undefined,
      with: {},
    });
    expect(resolved?.external).toBe(true);
  });

  it('chains relative imports inside the http-url namespace', async () => {
    const ctx = createMockCtx();
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd);
    const { build, resolvers } = makeFakeBuild();
    await plugin.setup(build);
    const resolved = await resolvers[0].fn({
      path: './sub.js',
      importer: 'https://esm.sh/react@18/index.js',
      namespace: 'http-url',
      resolveDir: '',
      kind: 'import-statement',
      pluginData: undefined,
      with: {},
    });
    expect(resolved?.path).toBe('https://esm.sh/react@18/sub.js');
    expect(resolved?.namespace).toBe('http-url');
  });

  it('loads VFS file contents through ctx.fs.readFile', async () => {
    const ctx = createMockCtx({
      fs: {
        readFile: vi.fn().mockResolvedValue('export const x = 1;'),
      },
    });
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd);
    const { build, loaders } = makeFakeBuild();
    await plugin.setup(build);
    // First load callback is the default-namespace VFS loader.
    const loaded = await loaders[0].fn({
      path: '/workspace/src/index.ts',
      namespace: 'file',
      suffix: '',
      pluginData: undefined,
      with: {},
    });
    expect(loaded?.contents).toBe('export const x = 1;');
    expect(loaded?.loader).toBe('ts');
  });

  it('loads http-url namespace contents through fetch', async () => {
    const ctx = createMockCtx();
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'export default {};',
    }) as unknown as typeof fetch;
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd, fakeFetch);
    const { build, loaders } = makeFakeBuild();
    await plugin.setup(build);
    // Second load callback is the http-url namespace loader.
    const loaded = await loaders[1].fn({
      path: 'https://esm.sh/react',
      namespace: 'http-url',
      suffix: '',
      pluginData: undefined,
      with: {},
    });
    expect(loaded?.contents).toBe('export default {};');
  });

  it('surfaces http errors as load diagnostics', async () => {
    const ctx = createMockCtx();
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
    }) as unknown as typeof fetch;
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd, fakeFetch);
    const { build, loaders } = makeFakeBuild();
    await plugin.setup(build);
    const loaded = await loaders[1].fn({
      path: 'https://esm.sh/nope',
      namespace: 'http-url',
      suffix: '',
      pluginData: undefined,
      with: {},
    });
    expect(loaded?.errors?.[0]?.text).toMatch(/HTTP 404/);
  });
});

describe('createEsbuildCommand routing', () => {
  it('prints help when invoked with no args', async () => {
    const cmd = createEsbuildCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('esbuild');
    expect(result.stdout).toContain('--bundle');
  });

  it('reports a parse error with exit code 2', async () => {
    const cmd = createEsbuildCommand();
    const result = await cmd.execute(['--frobnicate'], createMockCtx());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown option/);
  });

  it('errors on multiple entry points without --bundle (exit 2, no WASM load)', async () => {
    const cmd = createEsbuildCommand();
    const result = await cmd.execute(['a.js', 'b.js'], createMockCtx());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--bundle/);
  });
});

/**
 * Build a minimal {@link ModuleReader} + `readBytes` pair over an in-memory
 * tree so the ipk node_modules resolution path is exercisable without a real
 * VFS. `files` keys are absolute VFS paths; `dirs` is the set of paths that
 * should answer `isDirectory: true`. `bytes` returns binary contents (the
 * resolver's `readFile` is text-only — wasm bytes flow through `readBytes`).
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

describe('tryLoadEsbuildWasmFromNodeModules', () => {
  it('resolves esbuild.wasm bytes from an ipk-installed node_modules tree', async () => {
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const files = new Map<string, string>([
      [
        '/workspace/node_modules/esbuild-wasm/package.json',
        JSON.stringify({ name: 'esbuild-wasm', version: '0.0.0-test' }),
      ],
    ]);
    const dirs = new Set<string>([
      '/',
      '/workspace',
      '/workspace/node_modules',
      '/workspace/node_modules/esbuild-wasm',
    ]);
    const bytes = new Map<string, Uint8Array>([
      ['/workspace/node_modules/esbuild-wasm/esbuild.wasm', wasmBytes],
    ]);
    const { reader, readBytes } = makeIpkFixture(files, dirs, bytes);

    const result = await tryLoadEsbuildWasmFromNodeModules({
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

    const result = await tryLoadEsbuildWasmFromNodeModules({
      reader,
      readBytes,
      fromDir: '/workspace',
    });

    expect(result).toBeNull();
  });

  it('returns null when the package directory exists but the .wasm is missing', async () => {
    const files = new Map<string, string>([
      [
        '/workspace/node_modules/esbuild-wasm/package.json',
        JSON.stringify({ name: 'esbuild-wasm', version: '0.0.0-test' }),
      ],
    ]);
    const dirs = new Set<string>([
      '/',
      '/workspace',
      '/workspace/node_modules',
      '/workspace/node_modules/esbuild-wasm',
    ]);
    const { reader, readBytes } = makeIpkFixture(files, dirs, new Map());

    const result = await tryLoadEsbuildWasmFromNodeModules({
      reader,
      readBytes,
      fromDir: '/workspace',
    });

    expect(result).toBeNull();
  });
});

describeHeavy('createEsbuildCommand (live WASM, SLICC_TEST_HEAVY_WASM=1)', () => {
  it('transforms TypeScript stdin to JavaScript on stdout', async () => {
    resetEsbuildForTests();
    const cmd = createEsbuildCommand();
    const result = await cmd.execute(
      ['--loader=ts'],
      createMockCtx({ stdin: 'const x: number = 1; export { x };' })
    );
    expect(result.exitCode).toBe(0);
    // Type annotation must be gone; the binding name + export
    // statement must survive. Don't pin the exact var-keyword the
    // transpiler emits — esbuild's defaults change between releases.
    expect(result.stdout).toContain('x = 1');
    expect(result.stdout).toContain('export');
    expect(result.stdout).not.toContain(': number');
  });
});
