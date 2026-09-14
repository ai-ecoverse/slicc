import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fileIndexPath = resolve(repoRoot, 'node_modules/@zenfs/core/dist/internal/file_index.js');

describe('ZenFS Index._alloc spread-overflow fix', () => {
  it('the installed dist no longer spreads the index into Math.max', () => {
    const src = readFileSync(fileIndexPath, 'utf8');
    expect(
      src.includes('Math.max(...[...this.values()]'),
      'Installed @zenfs/core spreads the whole index into Math.max in ' +
        '_alloc() again — the zen-fs/core#312 fix shipped in 2.6.5, so this ' +
        'means a downgrade or an upstream regression. Every createFile/mkdir ' +
        'will throw "Maximum call stack size exceeded" once the index grows ' +
        'large enough. See patches/README.md and ' +
        'https://github.com/zen-fs/core/issues/312.'
    ).toBe(false);
  });

  async function indexOfSize(count: number) {
    const { Index } = await import('@zenfs/core');
    const index = new Index();
    for (let i = 0; i < count; i++) {
      index.set(`/f${i}`, { ino: 2 * i + 2, data: 2 * i + 3 } as never);
    }
    return index;
  }

  it('behaviorally: allocates over an index far past the spread-argument ceiling', async () => {
    const count = 150_000;
    const index = await indexOfSize(count);

    expect(index._alloc()).toBe(2 * (count - 1) + 3 + 1);
  });

  it('behaviorally: still allocates correctly from a deep call stack', async () => {
    const index = await indexOfSize(60_000);

    const deep = (depth: number): number => (depth > 0 ? deep(depth - 1) : index._alloc());
    expect(deep(2_000)).toBe(2 * 59_999 + 3 + 1);
  });
});
