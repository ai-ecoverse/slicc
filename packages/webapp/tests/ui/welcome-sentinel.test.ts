/**
 * `persistWelcomeSentinel` gating tests.
 *
 * Confirms the three branches the call-site in `main.ts` relies on:
 *   - flag off  → write through the supplied VFS (which is `localFs` in
 *                 the production wiring, so byte-identical to the
 *                 local-VFS baseline)
 *   - flag on + leader   → write through the writable VFS (which is the
 *                          `RemoteWritableVfsClient` page→worker bridge)
 *   - flag on + follower → no-op (skip the write so the marker isn't
 *                          silently orphaned in the page LFS shadow)
 *
 * The helper is fire-and-forget; the test waits one microtask for the
 * floated promise chain to settle before asserting.
 */

import { describe, expect, it, vi } from 'vitest';
import type { WritableVfsClient } from '../../src/kernel/writable-vfs-client.js';
import { persistWelcomeSentinel, WELCOME_SENTINEL_PATH } from '../../src/ui/welcome-sentinel.js';

function mkVfs(): { writeFile: ReturnType<typeof vi.fn>; vfs: WritableVfsClient } {
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const vfs = { writeFile } as unknown as WritableVfsClient;
  return { writeFile, vfs };
}

describe('persistWelcomeSentinel', () => {
  it('flag off (isWriter: true, localFs) writes the sentinel through the supplied VFS', async () => {
    // Flag-off production wiring: `writableFs === localFs` AND `isWriter`
    // resolves to `true` (no election ran). Behavior must be a single
    // `writeFile('/shared/.welcomed', '1')` — byte-identical to pre-B4b.
    const { writeFile, vfs } = mkVfs();

    persistWelcomeSentinel({ writableFs: vfs, isWriter: true });

    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(WELCOME_SENTINEL_PATH, '1');
  });

  it('flag on + leader routes through the writable RPC client (single write)', async () => {
    // Flag-on leader wiring: `writableFs` is the `RemoteWritableVfsClient`
    // page→worker bridge; the helper must drive its `writeFile` exactly
    // the same shape, so the sentinel lands on the worker-owned OPFS.
    const { writeFile, vfs } = mkVfs();

    persistWelcomeSentinel({ writableFs: vfs, isWriter: true });

    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(WELCOME_SENTINEL_PATH, '1');
  });

  it('flag on + follower no-ops (no writeFile call)', async () => {
    // Flag-on follower wiring: `__slicc_opfs_leader.isLeader === false`,
    // so the call-site passes `isWriter: false` and the helper must
    // short-circuit without touching the VFS at all.
    const { writeFile, vfs } = mkVfs();

    persistWelcomeSentinel({ writableFs: vfs, isWriter: false });

    await Promise.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('write failure is swallowed (fire-and-forget)', async () => {
    // The original inline call attached a `.catch` so a transient IDB/
    // OPFS hiccup wouldn't break onboarding. The extracted helper must
    // keep that contract — no unhandled rejection, no throw.
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const vfs = { writeFile } as unknown as WritableVfsClient;

    expect(() => persistWelcomeSentinel({ writableFs: vfs, isWriter: true })).not.toThrow();

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
