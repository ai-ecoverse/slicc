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
});
