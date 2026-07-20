import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEsbuildCommand,
  createIpkContextFromCtx,
  createVfsPlugin,
  inferLoader,
  parseEsbuildArgs,
} from '../../../src/shell/supplemental-commands/esbuild-command.js';
import { resetEsbuildForTests } from '../../../src/shell/supplemental-commands/esbuild-wasm.js';

// Mock the wasm loader so command-execute paths run deterministically without
// booting a real esbuild wasm subprocess (the live paths stay behind
// SLICC_TEST_HEAVY_WASM below).
const esb = vi.hoisted(() => ({
  loadError: null as Error | null,
  version: '0.25.0',
  transform: vi.fn(),
  build: vi.fn(),
}));

vi.mock('../../../src/shell/supplemental-commands/esbuild-wasm.js', () => ({
  resetEsbuildForTests: () => {},
  getEsbuild: async () => {
    if (esb.loadError) throw esb.loadError;
    return {
      version: esb.version,
      transform: esb.transform,
      build: esb.build,
      formatMessages: async (msgs: { text: string }[], opts: { kind: 'error' | 'warning' }) =>
        msgs.map((m) => `[${opts.kind}] ${m.text}\n`),
    };
  },
}));

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

describe('createEsbuildCommand (mocked wasm loader)', () => {
  beforeEach(() => {
    esb.loadError = null;
    esb.version = '0.25.0';
    esb.transform.mockReset();
    esb.build.mockReset();
  });

  it('prints help for --help', async () => {
    const result = await createEsbuildCommand().execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('esbuild - thin wrapper');
  });

  it('prints help when no args and no stdin', async () => {
    const result = await createEsbuildCommand().execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('esbuild - thin wrapper');
  });

  it('returns exit 2 on an argument parse error', async () => {
    const result = await createEsbuildCommand().execute(['--frobnicate', 'a.js'], createMockCtx());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown option');
  });

  it('rejects multiple entries without --bundle', async () => {
    const result = await createEsbuildCommand().execute(['a.js', 'b.js'], createMockCtx());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('multiple entry points require --bundle');
  });

  it('surfaces the loader guidance error verbatim', async () => {
    esb.loadError = new Error('run `ipk add esbuild-wasm`');
    const result = await createEsbuildCommand().execute(['--version'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('esbuild: run `ipk add esbuild-wasm`\n');
  });

  it('reports the module version', async () => {
    esb.version = '1.2.3';
    const result = await createEsbuildCommand().execute(['--version'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('1.2.3\n');
  });

  describe('transform mode', () => {
    it('transforms a VFS file to stdout', async () => {
      esb.transform.mockResolvedValue({ code: 'OUT;', warnings: [] });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/a.ts', 'const x=1;');
      const result = await createEsbuildCommand().execute(['a.ts'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('OUT;');
    });

    it('errors when the transform entry does not exist', async () => {
      const result = await createEsbuildCommand().execute(['missing.ts'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing.ts: no such file');
    });

    it('transforms stdin when no entry is given', async () => {
      esb.transform.mockResolvedValue({ code: 'FROM_STDIN;', warnings: [] });
      const result = await createEsbuildCommand().execute(
        ['--loader=ts'],
        createMockCtx({ stdin: 'const y=2;' })
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('FROM_STDIN;');
    });

    it('renders transform warnings to stderr', async () => {
      esb.transform.mockResolvedValue({ code: 'OUT;', warnings: [{ text: 'careful' }] });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/a.ts', 'x');
      const result = await createEsbuildCommand().execute(['a.ts'], ctx);
      expect(result.stderr).toContain('[warning] careful');
    });

    it('writes --outfile and a separate .map for external sourcemaps', async () => {
      esb.transform.mockResolvedValue({ code: 'OUT;', warnings: [], map: 'MAP' });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/a.ts', 'x');
      const result = await createEsbuildCommand().execute(
        ['a.ts', '--sourcemap=external', '--outfile', 'out.js'],
        ctx
      );
      expect(result.exitCode).toBe(0);
      expect(await ctx.fs.readFile('/workspace/out.js')).toBe('OUT;');
      expect(await ctx.fs.readFile('/workspace/out.js.map')).toBe('MAP');
    });

    it('renders a structured transform failure', async () => {
      esb.transform.mockRejectedValue({ errors: [{ text: 'boom' }], warnings: [] });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/a.ts', 'x');
      const result = await createEsbuildCommand().execute(['a.ts'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('[error] boom');
    });

    it('renders a plain transform failure', async () => {
      esb.transform.mockRejectedValue(new Error('kaput'));
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/a.ts', 'x');
      const result = await createEsbuildCommand().execute(['a.ts'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('esbuild: kaput\n');
    });
  });

  describe('bundle mode', () => {
    it('requires at least one entry point', async () => {
      const result = await createEsbuildCommand().execute(['--bundle'], createMockCtx());
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--bundle requires at least one entry point');
    });

    it('errors when a bundle entry does not exist', async () => {
      const result = await createEsbuildCommand().execute(
        ['--bundle', 'missing.ts'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no such file');
    });

    it('bundles to stdout', async () => {
      esb.build.mockResolvedValue({
        errors: [],
        warnings: [],
        outputFiles: [{ path: '/out.js', text: 'BUNDLED;' }],
      });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/entry.ts', 'x');
      const result = await createEsbuildCommand().execute(['--bundle', 'entry.ts'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('BUNDLED;');
    });

    it('writes --outfile plus extra output files', async () => {
      esb.build.mockResolvedValue({
        errors: [],
        warnings: [],
        outputFiles: [
          { path: '/out.js', text: 'MAIN;' },
          { path: '/out.js.map', text: 'MAP' },
        ],
      });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/entry.ts', 'x');
      const result = await createEsbuildCommand().execute(
        ['--bundle', 'entry.ts', '--outfile', 'dist/out.js'],
        ctx
      );
      expect(result.exitCode).toBe(0);
      expect(await ctx.fs.readFile('/workspace/dist/out.js')).toBe('MAIN;');
      expect(await ctx.fs.readFile('/workspace/dist/out.js.map')).toBe('MAP');
    });

    it('reports when a build produces no output for --outfile', async () => {
      esb.build.mockResolvedValue({ errors: [], warnings: [], outputFiles: [] });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/entry.ts', 'x');
      const result = await createEsbuildCommand().execute(
        ['--bundle', 'entry.ts', '--outfile', 'out.js'],
        ctx
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('build produced no output');
    });

    it('renders a structured bundle failure', async () => {
      esb.build.mockRejectedValue({ errors: [{ text: 'unresolved' }], warnings: [] });
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/entry.ts', 'x');
      const result = await createEsbuildCommand().execute(['--bundle', 'entry.ts'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('[error] unresolved');
    });

    it('renders a plain bundle failure', async () => {
      esb.build.mockRejectedValue(new Error('bundle boom'));
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/entry.ts', 'x');
      const result = await createEsbuildCommand().execute(['--bundle', 'entry.ts'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('esbuild: bundle boom\n');
    });
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

describe('createVfsPlugin VFS resolution + load', () => {
  type ResolveCb = (a: { path: string; importer?: string; namespace?: string }) => Promise<{
    path?: string;
    external?: boolean;
    errors?: { text: string }[];
  }>;
  type LoadCb = (a: {
    path: string;
    namespace?: string;
  }) => Promise<{ contents: string; loader: string; resolveDir: string } | null>;

  // The default mock resolvePath is naive; normalize `.`/`..` so relative
  // imports resolve to real fileStore keys the way the production fs does.
  const normalize = (base: string, p: string) => {
    const start = p.startsWith('/') ? p : `${base.replace(/\/$/, '')}/${p}`;
    const parts: string[] = [];
    for (const seg of start.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  };
  const pluginCtx = () => createMockCtx({ fs: { resolvePath: normalize } });

  function wirePlugin(ctx: ReturnType<typeof createMockCtx>) {
    const ipk = createIpkContextFromCtx(ctx);
    const plugin = createVfsPlugin(ctx.fs, ctx.cwd, ipk);
    let resolveCb: ResolveCb | null = null;
    let loadCb: LoadCb | null = null;
    const build = {
      onResolve(_f: { filter: RegExp }, cb: ResolveCb) {
        resolveCb = cb;
      },
      onLoad(_f: { filter: RegExp }, cb: LoadCb) {
        loadCb = cb;
      },
    };
    plugin.setup(build as unknown as Parameters<typeof plugin.setup>[0]);
    if (!resolveCb || !loadCb) throw new Error('plugin callbacks not registered');
    return { resolveCb: resolveCb as ResolveCb, loadCb: loadCb as LoadCb };
  }

  it('resolves a relative import by appending a known extension', async () => {
    const ctx = pluginCtx();
    await ctx.fs.writeFile('/workspace/mod.ts', 'export default 1;');
    const { resolveCb } = wirePlugin(ctx);
    const res = await resolveCb({ path: './mod', importer: '/workspace/entry.ts' });
    expect(res.path).toBe('/workspace/mod.ts');
  });

  it('resolves a directory import to its index file', async () => {
    const ctx = pluginCtx();
    await ctx.fs.writeFile('/workspace/dir/index.ts', 'export default 1;');
    const { resolveCb } = wirePlugin(ctx);
    const res = await resolveCb({ path: './dir', importer: '/workspace/entry.ts' });
    expect(res.path).toBe('/workspace/dir/index.ts');
  });

  it('returns the bare candidate when nothing resolves', async () => {
    const ctx = pluginCtx();
    const { resolveCb } = wirePlugin(ctx);
    const res = await resolveCb({ path: './nope', importer: '/workspace/entry.ts' });
    expect(res.path).toBe('/workspace/nope');
  });

  it('loads file contents with the inferred loader', async () => {
    const ctx = pluginCtx();
    await ctx.fs.writeFile('/workspace/mod.tsx', 'export const A = 1;');
    const { loadCb } = wirePlugin(ctx);
    const res = await loadCb({ path: '/workspace/mod.tsx', namespace: 'file' });
    expect(res?.contents).toBe('export const A = 1;');
    expect(res?.loader).toBe('tsx');
    expect(res?.resolveDir).toBe('/workspace');
  });

  it('skips load for non-file namespaces', async () => {
    const ctx = pluginCtx();
    const { loadCb } = wirePlugin(ctx);
    const res = await loadCb({ path: 'react', namespace: 'ipk' });
    expect(res).toBeNull();
  });
});
