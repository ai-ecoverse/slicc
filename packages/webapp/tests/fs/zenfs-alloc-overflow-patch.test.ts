import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the ZenFS `Index._alloc()` spread-overflow patch.
//
// Upstream `_alloc()` was `Math.max(...[...this.values()].flatMap(i => [i.ino,
// i.data])) + 1` — a single spread of `2 * entryCount` arguments. `_alloc()` is
// called by `IndexFS.create()`, which backs `createFile` / `createFileSync` /
// `mkdir` / `mkdirSync`, so EVERY file and directory creation on the OPFS
// backend (`WebAccessFS extends Async(IndexFS)`) paid it. Past the host's
// spread-argument ceiling the engine throws `RangeError: Maximum call stack
// size exceeded` and nothing new can be created on the mount again.
//
// The ceiling is really "spread arguments vs. REMAINING stack", so it is not a
// clean cliff: the same index size succeeds from a shallow stack and throws
// from a deep one, and `create()` runs deep inside an async FS chain. Measured
// in a live Chrome 151 kernel worker: the shallow-stack ceiling bisected to
// 63,551 arguments (31,775 entries), while a production index of 26,013
// entries (52,026 arguments) survived ~800 extra frames and threw at ~1,000.
// Users saw intermittent write failures that grew more frequent as the VFS did.
//
// It surfaced as `EINVAL` rather than anything resource-shaped because a
// `RangeError` carries no `.code`, so `convertError` (src/fs/error-rebrand.ts)
// fell through to its unknown-error default — see the companion assertion in
// tests/fs/error-rebrand.test.ts.
//
// patches/@zenfs+core+2.6.2.patch replaces the spread with a reduction. These
// tests fail if the patch is missing or stops applying.
// Upstream report: https://github.com/zen-fs/core/issues/312
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fileIndexPath = resolve(repoRoot, 'node_modules/@zenfs/core/dist/internal/file_index.js');

describe('ZenFS Index._alloc spread-overflow patch', () => {
  it('the installed dist no longer spreads the index into Math.max', () => {
    const src = readFileSync(fileIndexPath, 'utf8');
    expect(
      src.includes('Math.max(...[...this.values()]'),
      'Installed @zenfs/core still spreads the whole index into Math.max in ' +
        '_alloc(); patches/@zenfs+core+2.6.2.patch is missing or failed to ' +
        'apply. Every createFile/mkdir will throw "Maximum call stack size ' +
        'exceeded" once the index grows large enough. See patches/README.md ' +
        'and https://github.com/zen-fs/core/issues/312.'
    ).toBe(false);
  });

  // `_alloc()` reads exactly two fields off each value — `ino` and `data` —
  // through `Index`'s inherited `Map.values()`. `Index extends Map` and does
  // not override `set`, so a plain `{ ino, data }` record exercises the same
  // contract as a real `Inode` for a fraction of the cost. That matters here:
  // the bug only shows at six-figure entry counts, and building 150,000
  // buffer-backed `Inode`s took ~22 s on a CI runner (vs ~3 s locally) purely
  // in fixture setup — a timeout that said nothing about `_alloc` itself.
  async function indexOfSize(count: number) {
    const { Index } = await import('@zenfs/core');
    const index = new Index();
    for (let i = 0; i < count; i++) {
      index.set(`/f${i}`, { ino: 2 * i + 2, data: 2 * i + 3 } as never);
    }
    return index;
  }

  it('behaviorally: allocates over an index far past the spread-argument ceiling', async () => {
    // 150,000 entries = 300,000 spread arguments — past every host's ceiling
    // (Node throws around 100,000 entries, Chrome around 31,775).
    const count = 150_000;
    const index = await indexOfSize(count);
    // Highest id in the index is `data` of the last entry: 2*(count-1)+3.
    expect(index._alloc()).toBe(2 * (count - 1) + 3 + 1);
  });

  it('behaviorally: still allocates correctly from a deep call stack', async () => {
    const index = await indexOfSize(60_000);
    // The real caller (`IndexFS.create`) runs deep inside an async FS chain;
    // the unpatched spread threw at this size once ~1,000 frames were already
    // on the stack, even though the same size succeeded from a shallow one.
    const deep = (depth: number): number => (depth > 0 ? deep(depth - 1) : index._alloc());
    expect(deep(2_000)).toBe(2 * 59_999 + 3 + 1);
  });
});
