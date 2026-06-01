import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  createTscCommand,
  deriveOutputPath,
  findTsconfigPath,
  parseTscArgs,
  stripJsonComments,
} from '../../../src/shell/supplemental-commands/tsc-command.js';

function createMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string; stdin: string }> = {}
): Parameters<ReturnType<typeof createTscCommand>['execute']>[1] {
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

describe('stripJsonComments', () => {
  it('removes // and /* */ comments while preserving strings', () => {
    const input = `{
  // line comment
  "name": "value", /* block */
  "url": "https://example.com" // trailing
}`;
    const out = stripJsonComments(input);
    expect(out).not.toMatch(/\/\/ line/);
    expect(out).not.toMatch(/block/);
    expect(out).toContain('"https://example.com"');
  });
});

describe('findTsconfigPath', () => {
  it('walks upward and returns the first match', async () => {
    const ctx = createMockCtx();
    (ctx.fs.writeFile as ReturnType<typeof vi.fn>)('/workspace/tsconfig.json', '{}');
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
    expect(result.stdout).toContain('tsc - TypeScript compiler');
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
