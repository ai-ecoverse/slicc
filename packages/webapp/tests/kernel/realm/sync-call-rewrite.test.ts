import { describe, expect, it } from 'vitest';
import { rewriteSyncCalls } from '../../../src/kernel/realm/sync-call-rewrite.js';

describe('rewriteSyncCalls', () => {
  it('is a no-op when the source has no execSync/spawnSync reference', () => {
    const src = `const x = 1;\nconsole.log(x);`;
    expect(rewriteSyncCalls(src)).toBe(src);
  });

  it('rewrites a standalone execSync call, preserving balanced parens', () => {
    const src = `execSync('echo hi');`;
    const out = rewriteSyncCalls(src);
    expect(out).toBe(`(await execSync('echo hi'));`);
    const AsyncFn = Object.getPrototypeOf(async function () {
      /* noop */
    }).constructor;
    expect(() => new AsyncFn('execSync', out)).not.toThrow();
  });

  it('rewrites a standalone spawnSync call with array/object args', () => {
    const src = `spawnSync('echo', ['hi'], { shell: true });`;
    const out = rewriteSyncCalls(src);
    expect(out).toBe(`(await spawnSync('echo', ['hi'], { shell: true }));`);
  });

  it('rewrites an assigned standalone call', () => {
    const src = `const out = execSync('echo hi');`;
    expect(rewriteSyncCalls(src)).toBe(`const out = (await execSync('echo hi'));`);
  });

  it('rewrites after destructuring from require', () => {
    const src = `const { execSync } = require('child_process');\nconst out = execSync('ls');`;
    const out = rewriteSyncCalls(src);
    expect(out).toContain(`const { execSync } = require('child_process');`);
    expect(out).toContain(`const out = (await execSync('ls'));`);
  });

  it('rewrites require(child_process).execSync(...) as a whole awaited expression', () => {
    const src = `const out = require('child_process').execSync('ls');`;
    expect(rewriteSyncCalls(src)).toBe(
      `const out = (await require('child_process').execSync('ls'));`
    );
  });

  it('rewrites require(child_process).spawnSync(...) as a whole awaited expression', () => {
    const src = `require("child_process").spawnSync('ls');`;
    expect(rewriteSyncCalls(src)).toBe(`(await require("child_process").spawnSync('ls'));`);
  });

  it('handles nested parens in the argument list', () => {
    const src = `execSync(cmd + (flag ? ' -v' : ''));`;
    const out = rewriteSyncCalls(src);
    expect(out).toBe(`(await execSync(cmd + (flag ? ' -v' : '')));`);
  });

  it('does not rewrite a function declaration named execSync', () => {
    const src = `function execSync(cmd) { return cmd; }`;
    expect(rewriteSyncCalls(src)).toBe(src);
  });

  it('does not rewrite arbitrary property-access calls (cp.execSync)', () => {
    const src = `const cp = require('child_process');\ncp.execSync('ls');`;
    const out = rewriteSyncCalls(src);
    // Left untouched: no regex-only fix exists for arbitrary property access.
    expect(out).toBe(src);
  });

  it('rewrites multiple call sites independently', () => {
    const src = `execSync('a');\nexecSync('b');`;
    const out = rewriteSyncCalls(src);
    expect(out).toBe(`(await execSync('a'));\n(await execSync('b'));`);
  });
});
