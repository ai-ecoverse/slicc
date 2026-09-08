/**
 * Pin just-bash POSIX normal-format default (issue #2950, upstream
 * vercel-labs/just-bash#413 / 2d9d41fd).
 *
 * No-flag `diff` must emit normal format (`<` / `>`), not unified. `-u`
 * stays unified. The issue repro is `diff a b | grep -cE '^[<>]'` returning 0
 * on files that differ — the canonical "lines only in A / only in B" idiom.
 */

import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';

const FILES = {
  '/d1.txt': 'a\nb\nc\n',
  '/d2.txt': 'a\nX\nc\n',
};

describe('just-bash diff POSIX normal format default (just-bash#413 / #2950)', () => {
  it('emits normal format with no flags (issue #2950 repro)', async () => {
    const b = new Bash({ files: FILES });
    const result = await b.exec('diff d1.txt d2.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('2c2\n< b\n---\n> X\n');
    expect(result.stdout).not.toMatch(/^={10,}/m);
    expect(result.stdout).not.toContain('@@');

    const counted = await b.exec("diff d1.txt d2.txt | grep -cE '^[<>]'");
    expect(counted.exitCode).toBe(0);
    expect(Number(counted.stdout.trim())).toBeGreaterThan(0);
  });

  it('emits unified format with -u, not the no-flag default', async () => {
    const b = new Bash({ files: FILES });
    const unified = await b.exec('diff -u d1.txt d2.txt');
    expect(unified.exitCode).toBe(1);
    expect(unified.stdout).toBe('--- d1.txt\n+++ d2.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n');

    const noFlag = await b.exec('diff d1.txt d2.txt');
    expect(noFlag.stdout).not.toBe(unified.stdout);
  });
});
