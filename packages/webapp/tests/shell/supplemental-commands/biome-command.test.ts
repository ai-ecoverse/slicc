import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IFileSystem } from 'just-bash';
import { createRequire } from 'module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  biomeVirtualPath,
  checkBiomeInstalled,
  createBiomeCommand,
  createIpkContextFromCtx,
  expandPaths,
  isLintableFile,
  JSH_WRAP_PREFIX_BYTE_LENGTH,
  parseBiomeArgs,
  shiftBiomeSpans,
  shouldWrapForBiome,
  tryReadBiomeWasmVersion,
  unwrapFormattedJsh,
  wrapJshForBiome,
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
});
