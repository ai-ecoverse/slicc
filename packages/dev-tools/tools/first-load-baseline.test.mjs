import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveMergeBase } from './first-load-baseline.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('resolveMergeBase', () => {
  it('resolves HEAD against itself to HEAD', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    expect(resolveMergeBase(repoRoot, 'HEAD')).toBe(head);
  });

  it('returns null for an unknown ref instead of throwing', () => {
    // The degradation path: an unresolvable baseline must let the caller
    // fall back to ceiling-only checking, never crash the size gate.
    expect(resolveMergeBase(repoRoot, 'origin/definitely-not-a-branch-xyz')).toBeNull();
  });

  it('returns null for a ref that is not a commit', () => {
    expect(resolveMergeBase(repoRoot, '')).toBeNull();
  });
});
