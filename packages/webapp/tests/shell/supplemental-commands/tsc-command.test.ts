import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  resetTypeScriptForTests,
  tryLoadTypeScriptSourceFromNodeModules,
} from '../../../src/shell/supplemental-commands/shared.js';
import {
  createIpkContextFromCtx,
  createTscCommand,
  deriveOutputPath,
  findTsconfigPath,
  parseTscArgs,
} from '../../../src/shell/supplemental-commands/tsc-command.js';

function createMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string; stdin: string }> = {}
): Parameters<ReturnType<typeof createTscCommand>['execute']>[1] {
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
    readFileBuffer: vi.fn().mockImplementation(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return new TextEncoder().encode(v);
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

describe('parseTscArgs', () => {
  it('collects file arguments', () => {
    const parsed = parseTscArgs(['a.ts', 'b.ts']);
    expect(parsed.files).toEqual(['a.ts', 'b.ts']);
    expect(parsed.noEmit).toBe(false);
    expect(parsed.outDir).toBeNull();
  });

  it('parses --noEmit and --outDir as space-separated value', () => {
    const parsed = parseTscArgs(['--noEmit', '--outDir', 'dist', 'a.ts']);
    expect(parsed.noEmit).toBe(true);
    expect(parsed.outDir).toBe('dist');
    expect(parsed.files).toEqual(['a.ts']);
  });

  it('accepts --outDir=value', () => {
    const parsed = parseTscArgs(['--outDir=build/out', 'a.ts']);
    expect(parsed.outDir).toBe('build/out');
  });

  it('flags --help and --version', () => {
    expect(parseTscArgs(['--help']).showHelp).toBe(true);
    expect(parseTscArgs(['-v']).showVersion).toBe(true);
  });

  it('throws on unknown options', () => {
    expect(() => parseTscArgs(['--bogus'])).toThrow(/unknown option/);
    expect(() => parseTscArgs(['--outDir'])).toThrow(/--outDir requires a value/);
  });

  it('rejects a flag-shaped next token as the --outDir value', () => {
    expect(() => parseTscArgs(['--outDir', '--noEmit', 'foo.ts'])).toThrow(
      /--outDir requires a value/
    );
  });
});

describe('deriveOutputPath', () => {
  it('replaces extension and writes next to source by default', () => {
    expect(deriveOutputPath('/workspace/foo.ts', null)).toBe('/workspace/foo.js');
    expect(deriveOutputPath('/workspace/sub/bar.tsx', null)).toBe('/workspace/sub/bar.js');
  });

  it('routes into outDir when specified, stripping trailing slash', () => {
    expect(deriveOutputPath('/workspace/foo.ts', 'dist')).toBe('dist/foo.js');
    expect(deriveOutputPath('/workspace/foo.ts', 'dist/')).toBe('dist/foo.js');
  });
});

describe('loadTsconfig via createTscCommand', () => {
  it('parses tsconfig.json with comments and trailing commas and honors compilerOptions', async () => {
    const cmd = createTscCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/tsconfig.json',
      `{
  // line comment
  "compilerOptions": {
    /* block comment */
    "removeComments": true,
    "module": "CommonJS",
  }, // trailing comma inside object, and after the top-level pair
}`
    );
    await ctx.fs.writeFile(
      '/workspace/src.ts',
      '// keep-me comment\nexport const x: number = 1;\n'
    );
    const result = await cmd.execute(['src.ts'], ctx);
    expect(result.exitCode).toBe(0);
    const out = await ctx.fs.readFile('/workspace/src.js');
    expect(out).not.toMatch(/keep-me comment/);
    expect(out).toMatch(/exports\.x = 1/);
  });
});

describe('findTsconfigPath', () => {
  it('walks upward and returns the first match', async () => {
    const ctx = createMockCtx();
    (ctx.fs.writeFile as unknown as (p: string, c: string) => void)(
      '/workspace/tsconfig.json',
      '{}'
    );
    const found = await findTsconfigPath(ctx.fs, '/workspace/sub/deep');
    expect(found).toBe('/workspace/tsconfig.json');
  });

  it('returns null when nothing is found', async () => {
    const ctx = createMockCtx();
    const found = await findTsconfigPath(ctx.fs, '/workspace/sub');
    expect(found).toBeNull();
  });
});

describe('createTscCommand', () => {
  it('shows help with --help', async () => {
    const cmd = createTscCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tsc - thin wrapper');
    expect(result.stdout).toContain('ipk add typescript@6.0.3');
  });

  it('transpiles a single .ts file to a sibling .js', async () => {
    const cmd = createTscCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/src.ts', 'const x: number = 1;\nexport { x };\n');
    const result = await cmd.execute(['src.ts'], ctx);
    expect(result.exitCode).toBe(0);
    const out = await ctx.fs.readFile('/workspace/src.js');
    expect(out).toMatch(/const x = 1/);
    expect(out).not.toMatch(/: number/);
  });

  it('routes emit into --outDir', async () => {
    const cmd = createTscCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/foo.ts', 'export const a: string = "hi";\n');
    const result = await cmd.execute(['--outDir', '/workspace/dist', 'foo.ts'], ctx);
    expect(result.exitCode).toBe(0);
    expect(await ctx.fs.exists('/workspace/dist/foo.js')).toBe(true);
  });

  it('--noEmit skips writes', async () => {
    const cmd = createTscCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/n.ts', 'export const x: number = 1;\n');
    const result = await cmd.execute(['--noEmit', 'n.ts'], ctx);
    expect(result.exitCode).toBe(0);
    expect(await ctx.fs.exists('/workspace/n.js')).toBe(false);
  });

  it('transpiles stdin to stdout when no files are given', async () => {
    const cmd = createTscCommand();
    const ctx = createMockCtx({ stdin: 'export const a: number = 2;\n' });
    const result = await cmd.execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/const a = 2/);
  });
});

describe('install-required guidance (browser branch)', () => {
  // Vitest runs under Node so `getTypeScript`'s Node fallback always loads the
  // aliased TypeScript 6 package — exercise the browser-branch resolver helper
  // directly to pin the null-when-absent / source-when-installed behavior,
  // then stub the runtime for the command's browser-only guidance path.
  it('tryLoadTypeScriptSourceFromNodeModules returns null when TypeScript is absent', async () => {
    const ctx = createMockCtx();
    const result = await tryLoadTypeScriptSourceFromNodeModules(createIpkContextFromCtx(ctx));
    expect(result).toBeNull();
  });

  it('tryLoadTypeScriptSourceFromNodeModules reads lib/typescript.js when installed', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/node_modules/typescript/package.json',
      JSON.stringify({ name: 'typescript', version: '6.0.3', main: 'lib/typescript.js' })
    );
    await ctx.fs.writeFile(
      '/workspace/node_modules/typescript/lib/typescript.js',
      "module.exports = { version: '6.0.3' };"
    );
    const result = await tryLoadTypeScriptSourceFromNodeModules(createIpkContextFromCtx(ctx));
    expect(result).toContain("version: '6.0.3'");
  });

  it('returns null for the TypeScript 7 package shape without lib/typescript.js', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/node_modules/typescript/package.json',
      JSON.stringify({ name: 'typescript', version: '7.0.2', main: 'lib/version.cjs' })
    );
    await ctx.fs.writeFile(
      '/workspace/node_modules/typescript/lib/version.cjs',
      "module.exports = '7.0.2';"
    );
    const result = await tryLoadTypeScriptSourceFromNodeModules(createIpkContextFromCtx(ctx));
    expect(result).toBeNull();
  });

  it('surfaces the pinned TypeScript 6 install command when the browser compiler is absent', async () => {
    resetTypeScriptForTests();
    vi.stubGlobal('process', undefined);
    try {
      const result = await createTscCommand().execute(['--version'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ipk add typescript@6.0.3');
    } finally {
      vi.unstubAllGlobals();
      resetTypeScriptForTests();
    }
  });

  it('help text includes the pinned TypeScript 6 hint (zero network)', () => {
    // The HELP_TEXT is the canonical user-facing surface for the install
    // requirement. The command always emits it on `--help`, even when
    // typescript is absent.
    const cmd = createTscCommand();
    return cmd.execute(['--help'], createMockCtx()).then((res) => {
      expect(res.stdout).toContain('ipk add typescript@6.0.3');
      expect(res.stdout).not.toMatch(/unpkg|jsdelivr|esm\.sh|https?:\/\//);
    });
  });
});
