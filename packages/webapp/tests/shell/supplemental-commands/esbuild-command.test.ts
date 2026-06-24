import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  createEsbuildCommand,
  createIpkContextFromCtx,
  createVfsPlugin,
  inferLoader,
  parseEsbuildArgs,
} from '../../../src/shell/supplemental-commands/esbuild-command.js';
import { resetEsbuildForTests } from '../../../src/shell/supplemental-commands/esbuild-wasm.js';

/**
 * Heavy esbuild paths boot a real wasm subprocess (in Node) or the
 * in-realm wasm service; gate them behind SLICC_TEST_HEAVY_WASM=1
 * matching the prior `esbuild-command.test.ts` shape so logic tests
 * always run and live build/transform stays opt-in.
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

  it('rejects unknown long options', () => {
    expect(() => parseEsbuildArgs(['--frobnicate', 'a.js'])).toThrow(/unknown option/);
  });

  it('captures --version and --help', () => {
    expect(parseEsbuildArgs(['--version']).showVersion).toBe(true);
    expect(parseEsbuildArgs(['--help']).showHelp).toBe(true);
  });
});

describe('inferLoader', () => {
  it('maps known extensions and falls back to js', () => {
    expect(inferLoader('a.ts')).toBe('ts');
    expect(inferLoader('a.tsx')).toBe('tsx');
    expect(inferLoader('a.jsx')).toBe('jsx');
    expect(inferLoader('a.json')).toBe('json');
    expect(inferLoader('a.css')).toBe('css');
    expect(inferLoader('a.unknown')).toBe('js');
    expect(inferLoader('noext')).toBe('js');
  });
});

describe('createIpkContextFromCtx', () => {
  it('adapts the ctx.fs surface into a ModuleReader + readBytes', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/foo.txt', 'hello');
    const ipk = createIpkContextFromCtx(ctx);
    expect(await ipk.reader.exists('/foo.txt')).toBe(true);
    expect(await ipk.reader.readFile('/foo.txt')).toBe('hello');
    expect(ipk.fromDir).toBe('/workspace');
  });
});

describe('createVfsPlugin bare specifier resolution', () => {
  it("surfaces a 'run ipk install' error for an uninstalled bare specifier", async () => {
    const ctx = createMockCtx();
    const ipk = createIpkContextFromCtx(ctx);
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd, ipk);
    const collected: { errors: { text: string }[] } = { errors: [] };
    type ResolveCb = (a: { path: string; importer?: string; namespace?: string }) => Promise<{
      path?: string;
      external?: boolean;
      errors?: { text: string }[];
    }>;
    let resolveCb: ResolveCb | null = null;
    const build = {
      onResolve(_filter: { filter: RegExp }, cb: ResolveCb) {
        resolveCb = cb;
      },
      onLoad: () => {},
    };
    plugin.setup(build as unknown as Parameters<typeof plugin.setup>[0]);
    if (!resolveCb) throw new Error('onResolve callback not registered');
    const cb: ResolveCb = resolveCb;
    const res = await cb({ path: 'react', importer: '/workspace/entry.ts' });
    if (res.errors) collected.errors.push(...res.errors);
    expect(collected.errors[0].text).toMatch(/Cannot find module 'react'/);
    expect(collected.errors[0].text).toMatch(/ipk install react/);
  });

  it('marks node: / data: imports as external', async () => {
    const ctx = createMockCtx();
    const ipk = createIpkContextFromCtx(ctx);
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd, ipk);
    type ResolveCb = (a: { path: string; importer?: string; namespace?: string }) => Promise<{
      path?: string;
      external?: boolean;
      errors?: { text: string }[];
    }>;
    let resolveCb: ResolveCb | null = null;
    const build = {
      onResolve(_filter: { filter: RegExp }, cb: ResolveCb) {
        resolveCb = cb;
      },
      onLoad: () => {},
    };
    plugin.setup(build as unknown as Parameters<typeof plugin.setup>[0]);
    if (!resolveCb) throw new Error('onResolve callback not registered');
    const cb: ResolveCb = resolveCb;
    const res = await cb({ path: 'node:fs', importer: '/workspace/entry.ts' });
    expect(res.external).toBe(true);
  });
});

describeHeavy('esbuild command live wasm', () => {
  it('reports --version through the loaded module', async () => {
    resetEsbuildForTests();
    const cmd = createEsbuildCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['--version'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs a single-file --transform from a VFS file', async () => {
    resetEsbuildForTests();
    const cmd = createEsbuildCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'const x: number = 1; export default x;');
    const result = await cmd.execute(['/workspace/a.ts', '--format', 'cjs'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/const x = 1/);
  });
});
