import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsWatcher } from '../../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../../src/fs/index.js';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { createSudoFs } from '../../../src/fs/sudo-fs.js';
import {
  buildSudoWiring,
  NO_ESCALATE_NOTE,
} from '../../../src/scoops/scoop-context/sudo-wiring.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { SudoManager } from '../../../src/sudo/sudo-manager.js';
import type { EscalationCounts, SudoDecision } from '../../../src/sudo/types.js';
import { toDescriptor } from '../../../src/work-unit/descriptor.js';

let dbCounter = 0;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function harness(opts: { escalate?: boolean; decision?: SudoDecision } = {}) {
  const vfs = await VirtualFS.create({ dbName: `sudo-wiring-${dbCounter++}`, wipe: true });
  await vfs.mkdir('/scoops/agent-x/workspace', { recursive: true });
  await vfs.mkdir('/shared', { recursive: true });
  const watcher = new FsWatcher();
  vfs.setWatcher(watcher);
  const userBroker = { requestApproval: vi.fn(async () => ({ decision: 'allow' as const })) };
  const mgr = new SudoManager({ fs: vfs, watcher, broker: userBroker });
  await mgr.init();

  const config = {
    writablePaths: ['/scoops/agent-x/'],
    visiblePaths: ['/shared/'],
    allowedCommands: ['echo'],
    ...(opts.escalate === false ? { escalate: false } : {}),
  };
  mgr.registerScoopConfig('agent-x', config);
  const scoop: RegisteredScoop = {
    jid: 'agent_x',
    name: 'agent-x',
    folder: 'agent-x',
    parentJid: 'cone_1',
    requiresTrigger: false,
    assistantLabel: 'agent-x',
    addedAt: new Date(0).toISOString(),
    config,
  };

  const onSudoRequest = vi.fn(async () => opts.decision ?? { decision: 'allow' as const });
  const escalations: EscalationCounts = { asked: 0, allowed: 0, denied: 0 };
  const wiring = buildSudoWiring({
    sudoManager: mgr,
    unit: toDescriptor(scoop),
    folder: scoop.folder,
    onSudoRequest,
    escalate: opts.escalate,
    escalations,
  });
  if (!wiring) throw new Error('expected a wiring');

  const restricted = new RestrictedFS(
    vfs,
    config.writablePaths,
    config.visiblePaths,
    'sudo-delegated'
  );
  const gatedFs = createSudoFs(restricted, {
    broker: wiring.broker,
    getPolicy: wiring.getPolicy,
    defaultDisposition: wiring.defaultDisposition,
  }) as unknown as VirtualFS;
  const shell = new AlmostBashShellHeadless({
    fs: gatedFs,
    cwd: '/scoops/agent-x/workspace',
    allowedCommands: config.allowedCommands,
    sudo: wiring.shellConfig,
  });
  cleanups.push(async () => {
    mgr.dispose();
    await vfs.dispose?.();
  });
  return { wiring, gatedFs, shell, onSudoRequest, userBroker, escalations, mgr, vfs };
}

describe('buildSudoWiring — escalate: false (agent --no-escalate)', () => {
  it('refuses an unlisted command without asking the cone or the user', async () => {
    const h = await harness({ escalate: false });
    const result = await h.shell.executeCommand('ls /shared');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(NO_ESCALATE_NOTE);
    expect(h.onSudoRequest).not.toHaveBeenCalled();
    expect(h.userBroker.requestApproval).not.toHaveBeenCalled();
    expect(h.escalations).toEqual({ asked: 1, allowed: 0, denied: 1 });
  });

  it('still runs an allowed command, and an in-bounds write, without a request', async () => {
    const h = await harness({ escalate: false });
    const result = await h.shell.executeCommand('echo hi > /scoops/agent-x/workspace/out.txt');
    expect(result.exitCode).toBe(0);
    expect(h.escalations).toEqual({ asked: 0, allowed: 0, denied: 0 });
  });

  it('refuses an out-of-bounds write without asking the cone or the user', async () => {
    const h = await harness({ escalate: false });
    await expect(h.gatedFs.writeFile('/shared/leak.txt', 'x')).rejects.toThrow(NO_ESCALATE_NOTE);
    expect(h.onSudoRequest).not.toHaveBeenCalled();
    expect(h.userBroker.requestApproval).not.toHaveBeenCalled();
    expect(h.escalations).toEqual({ asked: 1, allowed: 0, denied: 1 });
  });

  it('ignores stored scoop and global grants, which still apply without the flag', async () => {
    for (const escalate of [false, undefined]) {
      const h = await harness({ escalate });
      await h.mgr.appendScoopRule('agent-x', 'command', 'ls *');
      await h.vfs.writeFile('/etc/sudoers.d/granted', 'NOPASSWD Write /shared/**\n');
      await h.mgr.reload();

      const ls = await h.shell.executeCommand('ls /shared');
      const write = h.gatedFs.writeFile('/shared/leak.txt', 'x');
      if (escalate === false) {
        expect(ls.stderr).toContain(NO_ESCALATE_NOTE);
        await expect(write).rejects.toThrow(NO_ESCALATE_NOTE);
        expect(h.escalations).toEqual({ asked: 2, allowed: 0, denied: 2 });
      } else {
        expect(ls.exitCode).toBe(0);
        await expect(write).resolves.toBeUndefined();
        expect(h.escalations).toEqual({ asked: 0, allowed: 0, denied: 0 });
      }
      expect(h.onSudoRequest).not.toHaveBeenCalled();
    }
  });

  it('without the flag, the same write escalates to the cone as before', async () => {
    const h = await harness();
    await h.gatedFs.writeFile('/shared/ok.txt', 'x');
    expect(h.onSudoRequest).toHaveBeenCalledTimes(1);
  });
});

describe('buildSudoWiring — escalation tally', () => {
  it('counts an approved escalation as asked + allowed', async () => {
    const h = await harness({ decision: { decision: 'allow' } });
    await h.gatedFs.writeFile('/shared/a.txt', 'x');
    expect(h.escalations).toEqual({ asked: 1, allowed: 1, denied: 0 });
  });

  it('counts always as allowed and deny or a timeout as denied', async () => {
    const always = await harness({ decision: { decision: 'always', pattern: '/shared/**' } });
    await always.wiring.broker.requestApproval({ kind: 'write', detail: '/shared/a' });
    expect(always.escalations).toEqual({ asked: 1, allowed: 1, denied: 0 });

    const denied = await harness({ decision: { decision: 'deny' } });
    await denied.wiring.broker.requestApproval({ kind: 'write', detail: '/shared/a' });
    await denied.wiring.broker.requestApproval({ kind: 'write', detail: '/shared/b' });
    expect(denied.escalations).toEqual({ asked: 2, allowed: 0, denied: 2 });

    const timedOut = await harness({ decision: { decision: 'deny', reason: 'cone-timeout' } });
    await timedOut.wiring.broker.requestApproval({ kind: 'write', detail: '/shared/a' });
    expect(timedOut.escalations).toEqual({ asked: 1, allowed: 0, denied: 1 });
  });

  it('counts a broker that throws (fail-closed) as denied', async () => {
    const h = await harness();
    h.onSudoRequest.mockRejectedValueOnce(new Error('relay gone'));
    await expect(
      h.wiring.broker.requestApproval({ kind: 'write', detail: '/shared/a' })
    ).rejects.toThrow('relay gone');
    expect(h.escalations).toEqual({ asked: 1, allowed: 0, denied: 1 });
  });
});
