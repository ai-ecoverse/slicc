import type { CommandContext } from 'just-bash';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { mergePolicies, parseSudoers, type SudoersPolicy } from '../../../src/base/sudoers.js';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { createSudoFs } from '../../../src/fs/sudo-fs.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  dispatchSyncExec,
  SYNC_EXEC_CHANNEL,
} from '../../../src/kernel/realm/sync-exec-dispatch.js';
import { dispatchSyncFs } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
} from '../../../src/kernel/realm/sync-fs-token-registry.js';
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

  const crossed = await dispatchSyncFs({ token: tokenA, op: 'read', path: '/scoops/b/secret.txt' });
  expect(crossed.ok).toBe(false);
  if (!crossed.ok) expect(crossed.errno).toMatch(/EACCES|ENOENT/);

  const own = await dispatchSyncFs({ token: tokenB, op: 'read', path: 'secret.txt' });
  expect(own.ok).toBe(true);
  if (own.ok && own.kind === 'bytes') expect(new TextDecoder().decode(own.bytes)).toBe('B-secret');

  revokeSyncFsToken(tokenA);
  const revoked = await dispatchSyncFs({ token: tokenA, op: 'read', path: 'anything' });
  expect(revoked.ok).toBe(false);
  if (!revoked.ok) expect(revoked.errno).toBe('EACCES');
});

test('GATE: the sync-exec channel runs through the realm own gated ctx.exec, in its cwd', async () => {
  const seen: Array<{ cmd: string; cwd: unknown }> = [];
  const exec = (async (cmd: string, opts: { cwd?: string }) => {
    seen.push({ cmd, cwd: opts.cwd });
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], exec, cwd: '/scoops/a' });

  const r = await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'ls' });

  expect(r.ok).toBe(true);

  expect(seen).toEqual([{ cmd: 'ls', cwd: '/scoops/a' }]);
});

test('GATE: a sudo-denying ctx.exec propagates EACCES through the sync-exec channel', async () => {
  const exec = (async () => {
    throw Object.assign(new Error('sudo: command denied'), { code: 'EACCES' });
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], exec, cwd: '/workspace' });

  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: 'rm -rf /',
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EACCES');
});

test('GATE: a revoked token cannot run a command (exec capability dies with the realm)', async () => {
  let ran = false;
  const exec = (async () => {
    ran = true;
    return { stdout: '', stderr: '', exitCode: 0 };
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], exec, cwd: '/workspace' });

  revokeSyncFsToken(token);
  const r = await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'whoami' });

  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EACCES');
  expect(ran).toBe(false);
});
