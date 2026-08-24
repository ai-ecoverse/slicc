import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IFileSystem } from 'just-bash';
import { createRequire } from 'module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  biomeDiagnosticToJson,
  biomePathFromConfigRoot,
  biomeVirtualPath,
  checkBiomeInstalled,
  createBiomeCommand,
  createIpkContextFromCtx,
  expandPaths,
  finalizeOutcome,
  isLintableFile,
  JSH_WRAP_PREFIX_BYTE_LENGTH,
  parseBiomeArgs,
  shiftBiomeSpans,
  shouldWrapForBiome,
  tryReadBiomeWasmVersion,
  unwrapFormattedJsh,
  wrapJshForBiome,
} from '../../../src/shell/supplemental-commands/biome-command.js';
import {
  parseBiomeJsonc,
  resolveBiomeConfiguration,
} from '../../../src/shell/supplemental-commands/biome-configuration.js';

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
  const fileStore = new Map<string, string | Uint8Array>();
  const dirSet = new Set<string>(['/workspace']);
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) =>
      path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
    exists: vi.fn().mockImplementation(async (p: string) => fileStore.has(p) || dirSet.has(p)),
    readFile: vi.fn().mockImplementation(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    }),
    writeFile: vi.fn().mockImplementation(async (p: string, content: string | Uint8Array) => {
      fileStore.set(p, content);
      const parts = p.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const seg = parts.slice(0, i).join('/') || '/';
        dirSet.add(seg);
      }
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      if (fileStore.has(p)) {
        const value = fileStore.get(p)!;
        return { isFile: true, isDirectory: false, size: value.length };
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
    readFileBuffer: vi.fn().mockImplementation(async (p: string) => {
      const value = fileStore.get(p);
      if (value === undefined) throw new Error(`ENOENT: ${p}`);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
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

function parseJsonResult(result: { stdout: string; stderr: string; exitCode: number }) {
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as {
    summary: { errors: number; warnings: number; filesChecked: number; unformattedFiles: number };
    diagnostics: {
      severity: string;
      category: string;
      message: string;
      filePath: string;
      line: number | null;
      column: number | null;
    }[];
    files: { path: string; unchanged: boolean }[];
  };
}

async function stageRealBiomePackages(ctx: ReturnType<typeof createMockCtx>): Promise<void> {
  const require = createRequire(import.meta.url);
  const packages = [
    {
      hostRoot: dirname(require.resolve('@biomejs/wasm-web/package.json')),
      vfsRoot: '/workspace/node_modules/@biomejs/wasm-web',
      files: ['package.json', 'biome_wasm.js'],
      binaries: ['biome_wasm_bg.wasm'],
    },
    {
      hostRoot: dirname(require.resolve('@biomejs/js-api/package.json')),
      vfsRoot: '/workspace/node_modules/@biomejs/js-api',
      files: ['package.json', 'dist/web.js', 'dist/common.js', 'dist/wasm.js'],
      binaries: [],
    },
    {
      hostRoot: dirname(require.resolve('esbuild-wasm/package.json')),
      vfsRoot: '/workspace/node_modules/esbuild-wasm',
      files: ['package.json'],
      binaries: [],
    },
  ];
  for (const pkg of packages) {
    for (const file of pkg.files) {
      await ctx.fs.writeFile(`${pkg.vfsRoot}/${file}`, readFileSync(resolve(pkg.hostRoot, file)));
    }
    for (const file of pkg.binaries) {
      await ctx.fs.writeFile(
        `${pkg.vfsRoot}/${file}`,
        new Uint8Array(readFileSync(resolve(pkg.hostRoot, file)))
      );
    }
  }
}

describe('parseBiomeArgs', () => {
  it('returns showHelp when no args are passed', () => {
    expect(parseBiomeArgs([]).showHelp).toBe(true);
  });

  it('captures check, lint, and format as subcommands', () => {
    expect(parseBiomeArgs(['check', 'a.ts']).subcommand).toBe('check');
    expect(parseBiomeArgs(['lint', 'a.ts']).subcommand).toBe('lint');
    expect(parseBiomeArgs(['format', 'a.ts']).subcommand).toBe('format');
  });

  it('captures format --check', () => {
    const parsed = parseBiomeArgs(['format', '--check', 'a.ts']);
    expect(parsed.subcommand).toBe('format');
    expect(parsed.check).toBe(true);
  });

  it('rejects --write together with --check', () => {
    expect(() => parseBiomeArgs(['format', '--write', '--check', 'a.ts'])).toThrow(
      /cannot be used together/
    );
  });

  it('captures --write and --stdin-file-path', () => {
    const parsed = parseBiomeArgs(['format', '--write', 'a.ts']);
    expect(parsed.write).toBe(true);
    const stdin = parseBiomeArgs(['check', '--stdin-file-path', '/foo.ts']);
    expect(stdin.stdinFilePath).toBe('/foo.ts');
    const stdinEq = parseBiomeArgs(['check', '--stdin-file-path=/bar.ts']);
    expect(stdinEq.stdinFilePath).toBe('/bar.ts');
  });

  it('rejects a missing --stdin-file-path value in both forms', () => {
    expect(() => parseBiomeArgs(['check', '--stdin-file-path'])).toThrow(/requires a value/);
    expect(() => parseBiomeArgs(['check', '--stdin-file-path='])).toThrow(/requires a value/);
  });

  it('captures --version and --help', () => {
    expect(parseBiomeArgs(['--version']).showVersion).toBe(true);
    expect(parseBiomeArgs(['--help']).showHelp).toBe(true);
  });

  it('captures both --config-path forms', () => {
    expect(parseBiomeArgs(['check', '--config-path', 'biome.json', 'a.ts']).configPath).toBe(
      'biome.json'
    );
    expect(parseBiomeArgs(['check', '--config-path=/repo/biome.json', 'a.ts']).configPath).toBe(
      '/repo/biome.json'
    );
  });

  it('rejects a missing --config-path value', () => {
    expect(() => parseBiomeArgs(['check', '--config-path'])).toThrow(/requires a value/);
    expect(() => parseBiomeArgs(['check', '--config-path='])).toThrow(/requires a value/);
  });

  it('captures reporter forms and defaults to plain', () => {
    expect(parseBiomeArgs(['lint', 'a.ts']).reporter).toBe('plain');
    expect(parseBiomeArgs(['lint', '--reporter', 'json', 'a.ts']).reporter).toBe('json');
    expect(parseBiomeArgs(['lint', '--reporter=plain', 'a.ts']).reporter).toBe('plain');
  });

  it('captures --json as an alias for --reporter json', () => {
    expect(parseBiomeArgs(['lint', '--json', 'a.ts']).reporter).toBe('json');
  });

  it('rejects invalid or missing reporter values', () => {
    expect(() => parseBiomeArgs(['lint', '--reporter', 'github', 'a.ts'])).toThrow(
      /unknown reporter/
    );
    expect(() => parseBiomeArgs(['lint', '--reporter'])).toThrow(/requires a value/);
    expect(() => parseBiomeArgs(['lint', '--reporter='])).toThrow(/requires a value/);
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

  it('matches .jsh and .bsh shell scripts', () => {
    expect(isLintableFile('a.jsh')).toBe(true);
    expect(isLintableFile('b.bsh')).toBe(true);
  });

  it('rejects unknown extensions and extensionless names', () => {
    expect(isLintableFile('a.bin')).toBe(false);
    expect(isLintableFile('README')).toBe(false);
  });
});

describe('biomeVirtualPath', () => {
  it('maps .jsh to a .js parser path (body is wrapped for parsing)', () => {
    expect(biomeVirtualPath('/x/foo.jsh')).toBe('/x/foo.js');
  });

  it('maps .bsh to a .js parser path', () => {
    expect(biomeVirtualPath('/x/bar.bsh')).toBe('/x/bar.js');
  });

  it('leaves other extensions unchanged', () => {
    expect(biomeVirtualPath('/x/baz.ts')).toBe('/x/baz.ts');
  });
});

describe('biomePathFromConfigRoot', () => {
  it('uses config-root-relative parser paths while preserving no-config behavior', () => {
    expect(biomePathFromConfigRoot('/workspace/project/src/tool.jsh', '/workspace/project')).toBe(
      'src/tool.js'
    );
    expect(biomePathFromConfigRoot('/workspace/other.ts', '/workspace/project')).toBe(
      '../other.ts'
    );
    expect(biomePathFromConfigRoot('/workspace/project/src/file.ts', null)).toBe(
      '/workspace/project/src/file.ts'
    );
  });
});

describe('shouldWrapForBiome', () => {
  it('wraps only .jsh and .bsh shell scripts', () => {
    expect(shouldWrapForBiome('/x/foo.jsh')).toBe(true);
    expect(shouldWrapForBiome('/x/bar.bsh')).toBe(true);
    expect(shouldWrapForBiome('/x/baz.ts')).toBe(false);
    expect(shouldWrapForBiome('/x/qux.mjs')).toBe(false);
    expect(shouldWrapForBiome('/x/quux.js')).toBe(false);
  });
});

describe('wrapJshForBiome', () => {
  it('wraps the body in an async function so top-level return/await parse', () => {
    const wrapped = wrapJshForBiome('return 1;\nawait x();\n');
    expect(wrapped).toBe('async function __slicc() {\nreturn 1;\nawait x();\n\n}');
    // Body starts on line 2 at column 0 (no re-indentation), so diagnostic
    // columns match the real file and only byte offsets shift.
    expect(wrapped.split('\n')[1]).toBe('return 1;');
  });

  it('the prefix byte length matches the wrapper prefix', () => {
    expect(JSH_WRAP_PREFIX_BYTE_LENGTH).toBe(
      new TextEncoder().encode('async function __slicc() {\n').length
    );
  });
});

describe('unwrapFormattedJsh', () => {
  it('drops the wrapper lines and de-indents one tab per body line', () => {
    const formatted = 'async function __slicc() {\n\tconst x = 1;\n\treturn x;\n}\n';
    expect(unwrapFormattedJsh(formatted)).toBe('const x = 1;\nreturn x;\n');
  });

  it('preserves template-literal lines that carry leading spaces (only tabs are stripped)', () => {
    // Biome indents the wrapper body with tabs; leading SPACES inside a
    // template literal are content and must survive unwrapping.
    const formatted =
      'async function __slicc() {\n\tconst s = `\n    indented in template\n`;\n}\n';
    const out = unwrapFormattedJsh(formatted);
    expect(out).toContain('    indented in template');
    expect(out.startsWith('const s = `')).toBe(true);
  });

  it('always emits a trailing newline', () => {
    expect(unwrapFormattedJsh('async function __slicc() {\n\tx();\n}')).toBe('x();\n');
  });
});

describe('shiftBiomeSpans', () => {
  it('subtracts the prefix byte length from every nested span and clamps at zero', () => {
    const diag = {
      location: { span: [40, 45], path: { file: '/x.js' } },
      advices: { advices: [{ log: [{ location: { span: [5, 8] } }] }] },
    };
    shiftBiomeSpans(diag, 28);
    expect(diag.location.span).toEqual([12, 17]);
    // 5 - 28 and 8 - 28 both clamp to 0.
    expect(diag.advices.advices[0].log[0].location.span).toEqual([0, 0]);
  });

  it('nulls out any embedded sourceCode so the printer uses the real source', () => {
    const diag = { location: { span: [30, 31], sourceCode: 'async function __slicc() {\n...' } };
    shiftBiomeSpans(diag, 28);
    expect(diag.location.span).toEqual([2, 3]);
    expect(diag.location.sourceCode).toBeNull();
  });

  it('ignores non-span arrays and primitives without throwing', () => {
    const diag = { tags: [], message: 'x', location: { span: [30, 31] } };
    expect(() => shiftBiomeSpans(diag, 28)).not.toThrow();
    expect(diag.location.span).toEqual([2, 3]);
  });
});

describe('biomeDiagnosticToJson', () => {
  it('uses the real wrapped-file path and span-shifted line and column', () => {
    const source = 'const y = 1;\nconst unusedX = 2;\nreturn y;\n';
    const start =
      JSH_WRAP_PREFIX_BYTE_LENGTH + new TextEncoder().encode('const y = 1;\nconst ').length;
    const diagnostic = {
      severity: 'warning',
      category: 'lint/correctness/noUnusedVariables',
      description: 'unused variable',
      message: [
        { elements: [], content: 'The variable ' },
        { elements: ['Emphasis'], content: 'unusedX' },
        { elements: [], content: ' is unused.' },
      ],
      location: { span: [start, start + 7] },
    };
    shiftBiomeSpans(diagnostic, JSH_WRAP_PREFIX_BYTE_LENGTH);
    expect(biomeDiagnosticToJson(diagnostic, '/workspace/tool.jsh', source)).toEqual({
      severity: 'warning',
      category: 'lint/correctness/noUnusedVariables',
      message: 'The variable unusedX is unused.',
      filePath: '/workspace/tool.jsh',
      line: 2,
      column: 7,
    });
  });
});

describe('realm-helper embedding safety', () => {
  // The realm helper embeds these functions verbatim via `.toString()`, so
  // they must be self-contained (no closure over module scope) and survive
  // re-evaluation. Re-hydrate them the same way the helper does and confirm
  // they still work under the test transformer (esbuild — same as the bundle).
  it('shiftBiomeSpans re-evaluates from its own source and still works', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rehydrated = new Function(
      `return (${shiftBiomeSpans.toString()});`
    )() as typeof shiftBiomeSpans;
    const diag = { location: { span: [40, 45] }, advices: [{ location: { span: [30, 31] } }] };
    rehydrated(diag, 28);
    expect(diag.location.span).toEqual([12, 17]);
    expect(diag.advices[0].location.span).toEqual([2, 3]);
  });

  it('unwrapFormattedJsh re-evaluates from its own source and still works', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rehydrated = new Function(
      `return (${unwrapFormattedJsh.toString()});`
    )() as typeof unwrapFormattedJsh;
    expect(rehydrated('async function __slicc() {\n\tconst x = 1;\n}\n')).toBe('const x = 1;\n');
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

describe('Biome configuration resolution', () => {
  it('uses an explicit --config-path relative to cwd', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/biome.json', '{ invalid discovered config }');
    await ctx.fs.writeFile('/workspace/config/biome.json', '{ "formatter": { "enabled": false } }');
    const result = await resolveBiomeConfiguration(
      ctx.fs,
      ctx.cwd,
      '/workspace/src',
      'config/biome.json'
    );
    expect(result).toEqual({
      ok: true,
      resolved: {
        path: '/workspace/config/biome.json',
        configuration: { formatter: { enabled: false } },
      },
    });
  });

  it('discovers the nearest config upward and prefers biome.json', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/biome.jsonc', '{ "root": false }');
    await ctx.fs.writeFile('/workspace/packages/biome.json', '{ "root": true }');
    await ctx.fs.writeFile('/workspace/packages/biome.jsonc', '{ "root": false }');
    const result = await resolveBiomeConfiguration(
      ctx.fs,
      ctx.cwd,
      '/workspace/packages/app/src',
      null
    );
    expect(result).toMatchObject({
      ok: true,
      resolved: { path: '/workspace/packages/biome.json', configuration: { root: true } },
    });
  });

  it('rejects path-based plugins with a precise unsupported-configuration error', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/biome.json',
      JSON.stringify({ plugins: ['./.biome-plugins/custom.grit'] })
    );
    const result = await resolveBiomeConfiguration(ctx.fs, ctx.cwd, '/workspace/src', null);
    expect(result).toEqual({
      ok: false,
      error:
        'biome: unsupported configuration /workspace/biome.json: path-based plugin "./.biome-plugins/custom.grit" cannot be loaded by @biomejs/js-api@6.0.0',
      exitCode: 1,
    });
  });

  it('fails check and format precisely against this repository biome.json plugin', async () => {
    const ctx = createMockCtx();
    const repositoryConfig = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../biome.json'),
      'utf8'
    );
    await ctx.fs.writeFile('/workspace/biome.json', repositoryConfig);
    const sourcePath = '/workspace/packages/webapp/src/shell/file.ts';
    await ctx.fs.writeFile(sourcePath, 'const value = 1;\n');
    const expectedError =
      'biome: unsupported configuration /workspace/biome.json: path-based plugin "./.biome-plugins/no-innerhtml-electron-overlay.grit" cannot be loaded by @biomejs/js-api@6.0.0\n';

    for (const subcommand of ['check', 'format']) {
      const result = await createBiomeCommand().execute([subcommand, sourcePath], ctx);
      expect(result).toEqual({ exitCode: 1, stdout: '', stderr: expectedError });
    }
  });

  it('parses JSONC comments and trailing commas without altering string content', () => {
    expect(
      parseBiomeJsonc(`{
        // line comment
        "url": "https://example.test/a//b",
        /* block comment */
        "javascript": { "formatter": { "quoteStyle": "single", }, },
      }`)
    ).toEqual({
      url: 'https://example.test/a//b',
      javascript: { formatter: { quoteStyle: 'single' } },
    });
  });

  it('returns exit 2 for a missing explicit config', async () => {
    const ctx = createMockCtx();
    const result = await resolveBiomeConfiguration(
      ctx.fs,
      ctx.cwd,
      '/workspace/src',
      'missing.json'
    );
    expect(result).toEqual({
      ok: false,
      error: 'biome: configuration file not found: /workspace/missing.json',
      exitCode: 2,
    });
  });

  it('returns exit 2 for an unparseable explicit config', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/custom.jsonc', '{ invalid }');
    const result = await resolveBiomeConfiguration(
      ctx.fs,
      ctx.cwd,
      '/workspace/src',
      'custom.jsonc'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(2);
      expect(result.error).toMatch(/failed to parse configuration \/workspace\/custom\.jsonc/);
    }
  });

  it('returns exit 1 for an unparseable discovered config', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/biome.json', '{ invalid }');
    const result = await resolveBiomeConfiguration(ctx.fs, ctx.cwd, '/workspace/src', null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(1);
      expect(result.error).toMatch(/failed to parse configuration \/workspace\/biome\.json/);
    }
  });

  it('returns the default null configuration when no config exists', async () => {
    const ctx = createMockCtx();
    await expect(
      resolveBiomeConfiguration(ctx.fs, ctx.cwd, '/workspace/src/nested', null)
    ).resolves.toEqual({ ok: true, resolved: null });
  });

  it('does not discover configs inside node_modules while walking upward', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/biome.json', '{ "root": true }');
    await ctx.fs.writeFile('/workspace/node_modules/pkg/biome.json', '{ "root": false }');
    const result = await resolveBiomeConfiguration(
      ctx.fs,
      ctx.cwd,
      '/workspace/node_modules/pkg/src',
      null
    );
    expect(result).toMatchObject({
      ok: true,
      resolved: { path: '/workspace/biome.json', configuration: { root: true } },
    });
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

  it('keeps the pinned biome versions in lockstep with the installed packages', () => {
    const require = createRequire(import.meta.url);
    const wasmWeb = JSON.parse(
      readFileSync(require.resolve('@biomejs/wasm-web/package.json'), 'utf-8')
    ) as { version: string };
    const jsApi = JSON.parse(
      readFileSync(require.resolve('@biomejs/js-api/package.json'), 'utf-8')
    ) as { version: string };
    expect(pinnedVersion('@biomejs/wasm-web')).toBe(wasmWeb.version);
    expect(pinnedVersion('@biomejs/js-api')).toBe(jsApi.version);
  });

  it('biome --version exits 1 with a `ipk add` hint when nothing is installed', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    const res = await cmd.execute(['--version'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/ipk add -g @biomejs\/wasm-web/);
    expect(res.stderr).not.toMatch(/https?:\/\//);
  });

  it('biome check exits 1 with guidance when the package is missing', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'const x=1;');
    const res = await cmd.execute(['check', 'a.ts'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/ipk add -g @biomejs\/wasm-web/);
    expect(res.stderr).not.toMatch(/unpkg|jsdelivr|esm\.sh/);

    const json = await cmd.execute(['check', '--json', 'a.ts'], ctx);
    expect(json.exitCode).toBe(res.exitCode);
    expect(parseJsonResult(json)).toEqual({
      summary: { errors: 1, warnings: 0, filesChecked: 0, unformattedFiles: 0 },
      diagnostics: [
        expect.objectContaining({
          severity: 'error',
          category: 'runtime',
          message: expect.stringMatching(/ipk add -g @biomejs\/wasm-web/),
          filePath: '/workspace/a.ts',
          line: null,
          column: null,
        }),
      ],
      files: [],
    });
  });
});

describe('biome --help / argument errors', () => {
  it('prints help with no args', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    const res = await cmd.execute([], ctx);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/biome - thin wrapper/);
    expect(res.stdout).toMatch(/ipk add -g @biomejs\/wasm-web/);
    expect(res.stdout).toMatch(/lint\s+Lint only/);
    expect(res.stdout).toContain('--check');
    expect(res.stdout).toContain('--config-path <file>       Use this config instead of automatic');
    expect(res.stdout).toContain("starts at the first target's directory (or cwd for");
    expect(res.stdout).toContain('biome.json is preferred over');
    expect(res.stdout).toContain('Config "extends" is');
    expect(res.stdout).toContain('unsupported and is not resolved');
    expect(res.stdout).toContain('Path-based plugins are unsupported');
    expect(res.stdout).toContain('Diagnostics use plain text without HTML tags, entities');
    expect(res.stdout).toContain('--reporter <plain|json>    Reporter selection (default: plain)');
    expect(res.stdout).toContain('--json                     Alias for --reporter json');
    expect(res.stdout).toContain('The json reporter writes one document to stdout');
    expect(res.stdout).toMatch(
      /Exit codes:[\s\S]*0\s+No findings[\s\S]*1\s+Error\/fatal\/warning diagnostics[\s\S]*2\s+Usage error/
    );
  });

  it('exits 2 on an unknown flag', async () => {
    const cmd = createBiomeCommand();
    const ctx = createMockCtx();
    const res = await cmd.execute(['--frobnicate'], ctx);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/unknown option/);
  });

  it('emits a JSON document for a parse-time usage error when --json was selected', async () => {
    const res = await createBiomeCommand().execute(['--json', '--frobnicate'], createMockCtx());
    expect(res.exitCode).toBe(2);
    expect(parseJsonResult(res)).toEqual({
      summary: { errors: 1, warnings: 0, filesChecked: 0, unformattedFiles: 0 },
      diagnostics: [
        {
          severity: 'error',
          category: 'usage',
          message: 'biome: unknown option: --frobnicate',
          filePath: '',
          line: null,
          column: null,
        },
      ],
      files: [],
    });
  });

  it('exits 2 when --write and --check are combined', async () => {
    const res = await createBiomeCommand().execute(
      ['format', '--write', '--check', 'a.ts'],
      createMockCtx()
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/cannot be used together/);
  });

  it.each([
    [['check', '--config-path'], /--config-path requires a value/],
    [['lint', '--reporter'], /--reporter requires a value/],
    [['lint', '--reporter', 'github'], /unknown reporter/],
  ] as const)('exits 2 for invalid option values: %j', async (args, message) => {
    const res = await createBiomeCommand().execute([...args], createMockCtx());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(message);
  });

  it('exits 2 for a missing explicit configuration before loading Biome', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'const value = 1;');
    const res = await createBiomeCommand().execute(
      ['check', '--config-path', 'missing.json', 'a.ts'],
      ctx
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('configuration file not found: /workspace/missing.json');

    const json = await createBiomeCommand().execute(
      ['check', '--json', '--config-path', 'missing.json', 'a.ts'],
      ctx
    );
    expect(json.exitCode).toBe(res.exitCode);
    expect(parseJsonResult(json)).toEqual({
      summary: { errors: 1, warnings: 0, filesChecked: 0, unformattedFiles: 0 },
      diagnostics: [
        {
          severity: 'error',
          category: 'configuration',
          message: 'biome: configuration file not found: /workspace/missing.json',
          filePath: '/workspace/a.ts',
          line: null,
          column: null,
        },
      ],
      files: [],
    });
  });

  it('emits input failures as JSON with the plain reporter exit code', async () => {
    const ctx = createMockCtx();
    const plain = await createBiomeCommand().execute(['check', 'missing.ts'], ctx);
    const json = await createBiomeCommand().execute(['check', '--json', 'missing.ts'], ctx);
    expect(json.exitCode).toBe(plain.exitCode);
    expect(plain.stderr).toBe(
      'biome: missing.ts: no such file or directory\nbiome: no lintable files found\n'
    );
    expect(parseJsonResult(json)).toMatchObject({
      summary: { errors: 1, warnings: 0, filesChecked: 0, unformattedFiles: 0 },
      diagnostics: [
        {
          severity: 'error',
          category: 'io',
          message: 'biome: missing.ts: no such file or directory\nbiome: no lintable files found',
          filePath: '',
          line: null,
          column: null,
        },
      ],
      files: [],
    });
  });

  it('wraps unexpected post-parse filesystem exceptions only for JSON', async () => {
    const ctx = createMockCtx({
      fs: { readFile: vi.fn().mockRejectedValue(new Error('read exploded')) },
    });
    await ctx.fs.writeFile('/workspace/a.ts', 'const value = 1;');
    await expect(createBiomeCommand().execute(['check', 'a.ts'], ctx)).rejects.toThrow(
      'read exploded'
    );

    const json = await createBiomeCommand().execute(['check', '--json', 'a.ts'], ctx);
    expect(json.exitCode).toBe(1);
    expect(parseJsonResult(json)).toEqual({
      summary: { errors: 1, warnings: 0, filesChecked: 0, unformattedFiles: 0 },
      diagnostics: [
        {
          severity: 'error',
          category: 'runtime',
          message: 'biome: read exploded',
          filePath: '/workspace/a.ts',
          line: null,
          column: null,
        },
      ],
      files: [],
    });
  });

  it('exits 1 for an unparseable discovered configuration before loading Biome', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.ts', 'const value = 1;');
    await ctx.fs.writeFile('/workspace/biome.jsonc', '{ invalid }');
    const res = await createBiomeCommand().execute(['check', 'a.ts'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/failed to parse configuration \/workspace\/biome\.jsonc/);
  });

  it('starts stdin configuration discovery from cwd, not --stdin-file-path', async () => {
    const ctx = createMockCtx({ cwd: '/workspace/project', stdin: 'const value = 1;' });
    await ctx.fs.writeFile('/workspace/project/biome.json', '{ invalid }');
    const res = await createBiomeCommand().execute(
      ['check', '--stdin-file-path', '/elsewhere/stdin.ts'],
      ctx
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/failed to parse configuration \/workspace\/project\/biome\.json/);
  });
});

describe('finalizeOutcome', () => {
  it('converts helper HTML diagnostics to plain stderr text', async () => {
    const ctx = createMockCtx();
    const source = 'if (left < right) return;\n';
    const result = await finalizeOutcome(
      ctx,
      parseBiomeArgs(['lint', 'a.ts']),
      [{ path: '/workspace/a.ts', source }],
      {
        results: [
          {
            path: '/workspace/a.ts',
            formatted: null,
            diagnosticsText:
              '<strong>error</strong>: left &lt; right &amp;&amp; value &gt; 0<br><span>lint/rule</span>\n',
            diagnostics: [],
            errorCount: 1,
            warningCount: 0,
            unchanged: true,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      ''
    );
    expect(result.stderr).toBe('error: left < right && value > 0\nlint/rule\n');
    expect(result.stderr).not.toMatch(
      /<\/?[A-Za-z][^>]*>|&(?:amp|lt|gt|quot|apos|nbsp|#[xX]?[0-9A-Fa-f]+);/
    );
  });

  it('exits 1 when warnings are the only findings', async () => {
    const ctx = createMockCtx();
    const source = 'const value = 1;\n';
    const result = await finalizeOutcome(
      ctx,
      parseBiomeArgs(['lint', 'a.ts']),
      [{ path: '/workspace/a.ts', source }],
      {
        results: [
          {
            path: '/workspace/a.ts',
            formatted: null,
            diagnosticsText: 'warning\n',
            diagnostics: [],
            errorCount: 0,
            warningCount: 1,
            unchanged: true,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      ''
    );
    expect(result.exitCode).toBe(1);
  });

  it('does not print formatted source for format --check', async () => {
    const ctx = createMockCtx();
    const result = await finalizeOutcome(
      ctx,
      parseBiomeArgs(['format', '--check', 'a.ts']),
      [{ path: '/workspace/a.ts', source: 'const value=1;\n' }],
      {
        results: [
          {
            path: '/workspace/a.ts',
            formatted: 'const value = 1;\n',
            diagnosticsText: '/workspace/a.ts: file is not formatted\n',
            diagnostics: [],
            errorCount: 1,
            warningCount: 0,
            unchanged: false,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      ''
    );
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('emits the stable JSON shape for a clean run', async () => {
    const result = await finalizeOutcome(
      createMockCtx(),
      parseBiomeArgs(['check', '--json', 'a.ts']),
      [{ path: '/workspace/a.ts', source: 'const value = 1;\n' }],
      {
        results: [
          {
            path: '/workspace/a.ts',
            formatted: null,
            diagnosticsText: '',
            diagnostics: [],
            errorCount: 0,
            warningCount: 0,
            unchanged: true,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      ''
    );
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      summary: { errors: 0, warnings: 0, filesChecked: 1, unformattedFiles: 0 },
      diagnostics: [],
      files: [{ path: '/workspace/a.ts', unchanged: true }],
    });
  });

  it('includes a partial missing-input failure in the JSON document', async () => {
    const result = await finalizeOutcome(
      createMockCtx(),
      parseBiomeArgs(['check', '--json', 'a.ts', 'missing.ts']),
      [{ path: '/workspace/a.ts', source: 'const value = 1;\n' }],
      {
        results: [
          {
            path: '/workspace/a.ts',
            formatted: null,
            diagnosticsText: '',
            diagnostics: [],
            errorCount: 0,
            warningCount: 0,
            unchanged: true,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      'biome: missing.ts: no such file or directory\n'
    );
    expect(result.exitCode).toBe(1);
    expect(parseJsonResult(result)).toEqual({
      summary: { errors: 1, warnings: 0, filesChecked: 1, unformattedFiles: 0 },
      diagnostics: [
        {
          severity: 'error',
          category: 'io',
          message: 'biome: missing.ts: no such file or directory',
          filePath: '',
          line: null,
          column: null,
        },
      ],
      files: [{ path: '/workspace/a.ts', unchanged: true }],
    });
  });

  it('puts structured findings in JSON stdout and leaves stderr empty', async () => {
    const diagnostic = {
      severity: 'error',
      category: 'lint/suspicious/noDebugger',
      message: 'This is an unexpected use of the debugger statement.',
      filePath: '/workspace/a.js',
      line: 2,
      column: 1,
    };
    const result = await finalizeOutcome(
      createMockCtx(),
      parseBiomeArgs(['lint', '--reporter', 'json', 'a.js']),
      [{ path: '/workspace/a.js', source: 'const value = 1;\ndebugger;\n' }],
      {
        results: [
          {
            path: '/workspace/a.js',
            formatted: null,
            diagnosticsText: '<strong>diagnostic text must not reach stderr</strong>',
            diagnostics: [diagnostic],
            errorCount: 1,
            warningCount: 0,
            unchanged: true,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      ''
    );
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      summary: { errors: 1, warnings: 0, filesChecked: 1, unformattedFiles: 0 },
      diagnostics: [diagnostic],
    });
    expect(result.exitCode).toBe(1);
  });

  it('reports an unformatted file without mixing formatted source into JSON stdout', async () => {
    const formatted = 'const value = 1;\n';
    const result = await finalizeOutcome(
      createMockCtx(),
      parseBiomeArgs(['format', '--check', '--json', 'a.ts']),
      [{ path: '/workspace/a.ts', source: 'const value=1;\n' }],
      {
        results: [
          {
            path: '/workspace/a.ts',
            formatted,
            diagnosticsText: '/workspace/a.ts: file is not formatted\n',
            diagnostics: [],
            errorCount: 1,
            warningCount: 0,
            unchanged: false,
          },
        ],
        stderr: '',
        exitCode: 0,
      },
      ''
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(formatted);
    expect(JSON.parse(result.stdout)).toEqual({
      summary: { errors: 1, warnings: 0, filesChecked: 1, unformattedFiles: 1 },
      diagnostics: [],
      files: [{ path: '/workspace/a.ts', unchanged: false }],
    });
    expect(result.exitCode).toBe(1);
  });

  it('keeps exit codes identical between plain and JSON reporters', async () => {
    const makeOutcome = () => ({
      results: [
        {
          path: '/workspace/a.ts',
          formatted: null,
          diagnosticsText: 'warning\n',
          diagnostics: [
            {
              severity: 'warning',
              category: 'lint/style/example',
              message: 'warning',
              filePath: '/workspace/a.ts',
              line: 1,
              column: 1,
            },
          ],
          errorCount: 0,
          warningCount: 1,
          unchanged: true,
        },
      ],
      stderr: '',
      exitCode: 0,
    });
    const inputs = [{ path: '/workspace/a.ts', source: 'const value = 1;\n' }];
    const plain = await finalizeOutcome(
      createMockCtx(),
      parseBiomeArgs(['lint', '--reporter', 'plain', 'a.ts']),
      inputs,
      makeOutcome(),
      ''
    );
    const json = await finalizeOutcome(
      createMockCtx(),
      parseBiomeArgs(['lint', '--reporter', 'json', 'a.ts']),
      inputs,
      makeOutcome(),
      ''
    );
    expect(json.exitCode).toBe(plain.exitCode);
    expect(json.exitCode).toBe(1);
  });
});

// End-to-end proof against the REAL Biome WASM that the exported wrap/unwrap/
// span-shift primitives (which the in-realm helper embeds verbatim) behave as
// designed. Gated behind SLICC_TEST_HEAVY_WASM=1 because it boots the ~33 MB
// wasm workspace — same gating convention as the esbuild live-service tests.
const describeHeavy = process.env.SLICC_TEST_HEAVY_WASM === '1' ? describe : describe.skip;

describeHeavy('biome .jsh/.bsh wrapping against real Biome', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let biome: any;
  let projectKey: string;

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasmWeb = (await import('@biomejs/wasm-web')) as unknown as {
      default?: (opts: { module_or_path: Uint8Array }) => Promise<unknown>;
    };
    const init = wasmWeb.default ?? (wasmWeb as unknown as typeof wasmWeb.default);
    const wasmPath = require.resolve('@biomejs/wasm-web/biome_wasm_bg.wasm');
    await init!({ module_or_path: readFileSync(wasmPath) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Biome } = require('@biomejs/js-api/web') as { Biome: new () => any };
    biome = new Biome();
    projectKey = biome.openProject().projectKey;
  }, 60_000);

  const parseDiags = (diags: { category?: string }[]) =>
    diags.filter((d) => d.category === 'parse');

  function formatWrapped(source: string): { content: string; parseDiagnostics: unknown[] } {
    const wrapped = wrapJshForBiome(source);
    const fmt = biome.formatContent(projectKey, wrapped, { filePath: '/t/x.js' });
    const diags = fmt.diagnostics || [];
    for (const d of diags) shiftBiomeSpans(d, JSH_WRAP_PREFIX_BYTE_LENGTH);
    let content = source;
    if (fmt.content !== wrapped) {
      const candidate = unwrapFormattedJsh(fmt.content);
      const reFmt = biome.formatContent(projectKey, wrapJshForBiome(candidate), {
        filePath: '/t/x.js',
      });
      content = reFmt.content === fmt.content ? candidate : source;
    }
    return { content, parseDiagnostics: parseDiags(diags) };
  }

  it('top-level return produces no syntax error', () => {
    expect(formatWrapped('const x = 1;\nreturn x;\n').parseDiagnostics).toHaveLength(0);
  });

  it('top-level await produces no syntax error', () => {
    expect(formatWrapped('await Promise.resolve();\n').parseDiagnostics).toHaveLength(0);
  });

  it('top-level return AND await together produce no syntax error', () => {
    expect(formatWrapped('const x = await f();\nreturn x;\n').parseDiagnostics).toHaveLength(0);
  });

  it('formats the body with the wrapper fully removed and no extra indentation', () => {
    expect(formatWrapped('const x=1\nreturn x\n').content).toBe('const x = 1;\nreturn x;\n');
  });

  it('leaves a template literal with tab-prefixed content UNCHANGED (corruption guard)', () => {
    const src = 'const s = `\n\ttab content here\nplain\n`;\nreturn s;\n';
    expect(formatWrapped(src).content).toBe(src);
  });

  it('maps a lint diagnostic line number back to the REAL file', () => {
    const source = 'const y = 1;\nconst unusedX = 2;\nreturn y;\n';
    const lint = biome.lintContent(projectKey, wrapJshForBiome(source), { filePath: '/t/x.js' });
    const diags = lint.diagnostics || [];
    for (const d of diags) shiftBiomeSpans(d, JSH_WRAP_PREFIX_BYTE_LENGTH);
    const printed = biome.printDiagnostics(diags, {
      filePath: '/t/real.jsh',
      fileSource: source,
    });
    // The unused const sits on real line 2 of the ORIGINAL file.
    expect(printed).toContain('/t/real.jsh:2:');
    expect(printed).not.toContain('__slicc');
  });

  it('applies a configuration that disables a lint rule', () => {
    const enabledProject = biome.openProject('/lint-enabled').projectKey;
    biome.applyConfiguration(enabledProject, {
      linter: {
        enabled: true,
        rules: { preset: 'recommended', suspicious: { noDebugger: 'error' } },
      },
    });
    const disabledProject = biome.openProject('/lint-disabled').projectKey;
    biome.applyConfiguration(disabledProject, {
      linter: {
        enabled: true,
        rules: { preset: 'recommended', suspicious: { noDebugger: 'off' } },
      },
    });
    const source = 'debugger;\n';
    const categories = (key: number) =>
      biome
        .lintContent(key, source, { filePath: '/t/configured.js' })
        .diagnostics.map((diagnostic: { category?: string }) => diagnostic.category);
    expect(categories(enabledProject)).toContain('lint/suspicious/noDebugger');
    expect(categories(disabledProject)).not.toContain('lint/suspicious/noDebugger');
  });

  it('applies javascript formatter quoteStyle', () => {
    const configuredProject = biome.openProject('/format-configured').projectKey;
    biome.applyConfiguration(configuredProject, {
      javascript: { formatter: { quoteStyle: 'single' } },
    });
    const formatted = biome.formatContent(configuredProject, 'const greeting = "hello";\n', {
      filePath: '/t/configured.js',
    });
    expect(formatted.content).toContain("const greeting = 'hello';");
  });

  it('applies config roots, feature gates, and file filters through the real command helper', async () => {
    const ctx = createMockCtx();
    await stageRealBiomePackages(ctx);
    await ctx.fs.writeFile(
      '/workspace/project/enabled.json',
      JSON.stringify({
        linter: {
          enabled: true,
          rules: { preset: 'recommended', suspicious: { noDebugger: 'error' } },
        },
      })
    );
    await ctx.fs.writeFile(
      '/workspace/project/biome.jsonc',
      `{
        // The discovered config must reach BIOME_HELPER_SCRIPT.
        "files": { "includes": ["**/*.js", "**/*.ts", "!**/generated/**"] },
        "formatter": { "enabled": true },
        "linter": {
          "enabled": true,
          "rules": { "preset": "recommended", "suspicious": { "noDebugger": "error" } },
        },
        "javascript": { "formatter": { "quoteStyle": "single" } },
        "overrides": [
          {
            "includes": ["src/configured.js"],
            "linter": { "rules": { "suspicious": { "noDebugger": "off" } } }
          },
          {
            "includes": ["src/disabled.js", "src/types/**/*.ts"],
            "formatter": { "enabled": false },
            "linter": { "enabled": false }
          }
        ],
      }`
    );
    const sourcePath = '/workspace/project/src/configured.js';
    await ctx.fs.writeFile(sourcePath, 'debugger;\nconst greeting = "hello";\nvoid greeting;\n');
    const disabledPath = '/workspace/project/src/disabled.js';
    const disabledSource = 'debugger;\nconst disabled = "unchanged";\n';
    await ctx.fs.writeFile(disabledPath, disabledSource);
    const overridePath = '/workspace/project/src/types/configured.ts';
    const overrideSource = 'debugger;\n';
    await ctx.fs.writeFile(overridePath, overrideSource);
    const excludedPath = '/workspace/project/generated/excluded.js';
    const excludedSource = 'debugger;\nconst excluded = "unchanged";\n';
    await ctx.fs.writeFile(excludedPath, excludedSource);

    const enabled = await createBiomeCommand().execute(
      ['lint', '--json', '--config-path', '/workspace/project/enabled.json', sourcePath],
      ctx
    );
    expect(enabled.exitCode).toBe(1);
    expect(enabled.stderr).toBe('');
    expect(parseJsonResult(enabled).diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'lint/suspicious/noDebugger',
        filePath: sourcePath,
      })
    );

    const configured = await createBiomeCommand().execute(
      ['check', '--write', sourcePath, disabledPath, overridePath, excludedPath],
      ctx
    );
    expect(configured).toMatchObject({ exitCode: 0, stdout: '' });
    expect(configured.stderr).toContain('biome: wrote 1 file(s)');
    const written = await ctx.fs.readFile(sourcePath);
    expect(written).toContain("const greeting = 'hello';");
    expect(written).not.toContain('const greeting = "hello";');
    expect(await ctx.fs.readFile(disabledPath)).toBe(disabledSource);
    expect(await ctx.fs.readFile(overridePath)).toBe(overrideSource);
    expect(await ctx.fs.readFile(excludedPath)).toBe(excludedSource);
  }, 120_000);
});
