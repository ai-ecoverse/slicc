import { describe, expect, it } from 'vitest';
import { createEsbuildCommand } from '../../../src/shell/supplemental-commands/esbuild-command.js';
import { resetEsbuildForTests } from '../../../src/shell/supplemental-commands/esbuild-wasm.js';
import { createEsbuildMockCtx as createMockCtx } from '../helpers/esbuild-mock-ctx.js';

/**
 * Opt-in integration tests that boot the real esbuild-wasm loader. Kept in a
 * dedicated file with NO `vi.mock` so the mocked unit suite
 * (esbuild-command.test.ts) can't intercept `getEsbuild`. Gated behind
 * SLICC_TEST_HEAVY_WASM=1 because the wasm subprocess is slow.
 */
const describeHeavy = process.env.SLICC_TEST_HEAVY_WASM === '1' ? describe : describe.skip;

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

  it('keeps an exact external in CommonJS bundle output', async () => {
    resetEsbuildForTests();
    const cmd = createEsbuildCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/entry.js',
      'import { readFileSync } from "fs"; export { readFileSync };'
    );
    const result = await cmd.execute(
      ['entry.js', '--bundle', '--format=cjs', '--external:fs'],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('require("fs")');
  });

  it('keeps descendants of exact package externals out of the bundle', async () => {
    resetEsbuildForTests();
    const cmd = createEsbuildCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/entry.js',
      'import value from "pkg/subpath"; import scoped from "@scope/pkg/subpath"; export { value, scoped };'
    );
    const result = await cmd.execute(
      ['entry.js', '--bundle', '--format=cjs', '--external:pkg', '--external:@scope/pkg'],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('require("pkg/subpath")');
    expect(result.stdout).toContain('require("@scope/pkg/subpath")');
  });

  it('does not externalize the entry point when a wildcard external matches imports', async () => {
    resetEsbuildForTests();
    const cmd = createEsbuildCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/entry.js',
      'import value from "external-dependency"; export const marker = "ENTRY_MARKER"; export default value;'
    );
    const result = await cmd.execute(['entry.js', '--bundle', '--format=cjs', '--external:*'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ENTRY_MARKER');
    expect(result.stdout).toContain('require("external-dependency")');
  });
});
