/**
 * Phase-1 acceptance gates for the sync-fs bridge (node-testable layer).
 *
 * The ACL escape guard is proven in sync-fs-dispatch.test.ts (out-of-sandbox
 * read/write/`../` denied). Here we lock in the other two security properties
 * that are exercisable in node at the dispatch layer:
 *   - sudo inheritance: a sudo-gated write through dispatchSyncFs consults the
 *     broker and fails closed with EACCES on deny (the sync path inherits the
 *     same createSudoFs gate the async vfs path has).
 *   - token isolation: one realm's token cannot reach another realm's scope,
 *     and a revoked token fails closed.
 *
 * The TRUE sudo-under-synchronous-write REENTRANCY (page services the sync-fs
 * request while the sudo modal is pending; broker-timeout → EACCES, never a
 * hang) and cross-float smoke are browser-only (real SW + DedicatedWorker) and
 * are documented as manual smokes in the plan (Task 8 step 2/4 / Task 9 docs) —
 * the in-process factory must never drive a synchronous XHR (it would deadlock).
 */

import type { CommandContext } from 'just-bash';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { createSudoFs } from '../../../src/fs/sudo-fs.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { dispatchSyncFs } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
} from '../../../src/kernel/realm/sync-fs-token-registry.js';
import {
  mergePolicies,
  parseSudoers,
  type SudoersPolicy,
} from '../../../src/shell/sudo/sudoers.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import type { SudoDecision, SudoRequest } from '../../../src/sudo/types.js';

let counter = 0;

function denyBroker(): {
  calls: SudoRequest[];
  broker: { requestApproval(r: SudoRequest): Promise<SudoDecision> };
} {
  const calls: SudoRequest[] = [];
  return {
    calls,
    broker: {
      async requestApproval(req: SudoRequest): Promise<SudoDecision> {
        calls.push(req);
        return { decision: 'deny' };
      },
    },
  };
}

test('GATE: a sudo-gated write through dispatchSyncFs fails closed with EACCES on deny', async () => {
  const vfs = await VirtualFS.create({ dbName: `sfa-${counter++}`, wipe: true });
  await vfs.mkdir('/workspace/.git', { recursive: true });
  const policy: SudoersPolicy = mergePolicies(parseSudoers('Write /workspace/.git/**'));
  const { calls, broker } = denyBroker();
  const sudoFs = createSudoFs(new VfsAdapter(vfs), {
    broker,
    getPolicy: () => policy,
  }) as unknown as CommandContext['fs'];
  const token = mintSyncFsToken({ fs: sudoFs, cwd: '/workspace' });

  const r = await dispatchSyncFs({
    token,
    op: 'write',
    path: '/workspace/.git/config',
    body: new TextEncoder().encode('evil'),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EACCES');
  // The broker WAS consulted (sudo gate fired on the sync path).
  expect(calls.some((c) => c.detail === '/workspace/.git/config')).toBe(true);
});

test('GATE: a non-gated write through the same sudo fs succeeds (broker not consulted)', async () => {
  const vfs = await VirtualFS.create({ dbName: `sfa-${counter++}`, wipe: true });
  await vfs.mkdir('/workspace', { recursive: true });
  const policy: SudoersPolicy = mergePolicies(parseSudoers('Write /workspace/.git/**'));
  const { calls, broker } = denyBroker();
  const sudoFs = createSudoFs(new VfsAdapter(vfs), {
    broker,
    getPolicy: () => policy,
  }) as unknown as CommandContext['fs'];
  const token = mintSyncFsToken({ fs: sudoFs, cwd: '/workspace' });

  const r = await dispatchSyncFs({
    token,
    op: 'write',
    path: '/workspace/note.txt',
    body: new TextEncoder().encode('ok'),
  });
  expect(r.ok).toBe(true);
  expect(calls).toHaveLength(0);
});

test('GATE: token isolation — one realm cannot read another realm scope; revoke fails closed', async () => {
  const vfs = await VirtualFS.create({ dbName: `sfa-${counter++}`, wipe: true });
  await vfs.mkdir('/scoops/a', { recursive: true });
  await vfs.mkdir('/scoops/b', { recursive: true });
  await vfs.writeFile('/scoops/b/secret.txt', 'B-secret');

  const mk = (scope: string) =>
    mintSyncFsToken({
      fs: new VfsAdapter(
        new RestrictedFS(vfs, [scope]) as unknown as VirtualFS
      ) as unknown as CommandContext['fs'],
      cwd: scope,
    });
  const tokenA = mk('/scoops/a/');
  const tokenB = mk('/scoops/b/');

  // A cannot reach B's file (RestrictedFS denies).
  const crossed = await dispatchSyncFs({ token: tokenA, op: 'read', path: '/scoops/b/secret.txt' });
  expect(crossed.ok).toBe(false);
  if (!crossed.ok) expect(crossed.errno).toMatch(/EACCES|ENOENT/);

  // B reads its own.
  const own = await dispatchSyncFs({ token: tokenB, op: 'read', path: 'secret.txt' });
  expect(own.ok).toBe(true);
  if (own.ok && own.kind === 'bytes') expect(new TextDecoder().decode(own.bytes)).toBe('B-secret');

  // A revoked → fails closed regardless of path.
  revokeSyncFsToken(tokenA);
  const revoked = await dispatchSyncFs({ token: tokenA, op: 'read', path: 'anything' });
  expect(revoked.ok).toBe(false);
  if (!revoked.ok) expect(revoked.errno).toBe('EACCES');
});
