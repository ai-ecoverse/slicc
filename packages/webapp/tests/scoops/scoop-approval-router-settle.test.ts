import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { parseSudoers } from '../../src/base/sudoers.js';
import {
  ScoopApprovalRouter,
  type ScoopApprovalRouterDeps,
} from '../../src/scoops/scoop-approval-router.js';
import type { ChannelMessage, RegisteredScoop } from '../../src/scoops/types.js';
import { CONE_SUDO_TIMEOUT_MS } from '../../src/sudo/index.js';
import type { SudoManager } from '../../src/sudo/sudo-manager.js';
import type { SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function scoop(jid: string, isCone: boolean): RegisteredScoop {
  return {
    jid,
    name: jid,
    folder: `${jid}-folder`,
    parentJid: isCone ? null : 'cone',
    requiresTrigger: false,
    assistantLabel: jid,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeHarness(sudoManager: SudoManager | null = null) {
  const cone = scoop('cone_jid', true);
  const requester = scoop('scoop_a', false);
  const scoops = new Map<string, RegisteredScoop>([
    [cone.jid, cone],
    [requester.jid, requester],
  ]);
  const store: ChannelMessage[] = [];
  const handleMessage = vi.fn(async (msg: ChannelMessage) => {
    store.push(msg);
  });
  const saveMessage = vi.fn(async (msg: ChannelMessage) => {
    const i = store.findIndex((m) => m.id === msg.id);
    if (i >= 0) store[i] = msg;
    else store.push(msg);
  });
  const onMessageUpdate = vi.fn();
  const deps: ScoopApprovalRouterDeps = {
    getScoops: () => scoops,
    findApprover: () => cone,
    getSudoManager: () => sudoManager,
    getLickManager: () => null,
    handleMessage,
    onMessageUpdate,
    getMessagesForScoop: async (jid) => store.filter((m) => m.chatJid === jid),
    saveMessage,
  };
  return { router: new ScoopApprovalRouter(deps), store, handleMessage, onMessageUpdate };
}

describe('ScoopApprovalRouter persistence settlement', () => {
  it('claims the request before awaiting a durable rule write', async () => {
    let finishAppend: (pattern: string) => void = () => {};
    const appendScoopRule = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishAppend = resolve;
        })
    );
    const sudoManager = {
      appendScoopRule,
      getPolicyForScoop: () => parseSudoers(''),
    } as unknown as SudoManager;
    const h = makeHarness(sudoManager);
    const pendingDecision = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'read',
      detail: '/recordings/first.har',
    });
    await flush();
    const [{ id }] = h.router.listPendingSudoRequests();

    const resultPromise = h.router.resolveSudoRequestAndPersist(id, {
      decision: 'always',
      pattern: '/recordings/**',
    });

    expect(appendScoopRule).toHaveBeenCalledOnce();
    expect(h.router.failAll()).toBe(0);
    await expect(pendingDecision).resolves.toEqual({
      decision: 'always',
      pattern: '/recordings/**',
    });

    finishAppend('/recordings/**');
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ settled: true, persisted: true })
    );
  });
});

describe('ScoopApprovalRouter settleGrantedRequests (issue #2416)', () => {
  function managerGranting(rules: string): SudoManager & { setRules(next: string): void } {
    let current = rules;
    return {
      getPolicyForScoop: () => parseSudoers(current),
      setRules(next: string) {
        current = next;
      },
    } as unknown as SudoManager & { setRules(next: string): void };
  }

  it('resolves pending path requests now covered by a NOPASSWD grant', async () => {
    const mgr = managerGranting('');
    const h = makeHarness(mgr);
    const covered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/screenshots/x.png',
    });
    const uncovered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.migration/crop.png',
    });
    await flush();
    expect(h.router.listPendingSudoRequests()).toHaveLength(2);

    mgr.setRules('NOPASSWD Write /.playwright/**');
    const settled = h.router.settleGrantedRequests('scoop_a-folder');
    await flush();

    expect(settled).toBe(1);
    await expect(covered).resolves.toEqual({ decision: 'allow' });
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);

    expect(h.store.find((m) => m.content.includes('/.playwright'))?.lickState).toBe('confirmed');
    expect(h.store.find((m) => m.content.includes('/.migration'))?.lickState).toBe('pending');

    h.router.failAll();
    await expect(uncovered).resolves.toEqual({ decision: 'deny' });
  });

  it('resolves pending command requests now covered by a NOPASSWD Cmnd grant', async () => {
    const mgr = managerGranting('');
    const h = makeHarness(mgr);
    const covered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'command',
      detail: 'git status',
    });
    await flush();

    mgr.setRules('NOPASSWD Cmnd git *');
    expect(h.router.settleGrantedRequests('scoop_a-folder')).toBe(1);
    await expect(covered).resolves.toEqual({ decision: 'allow' });
  });

  it('only settles requests from the scoop whose policy reloaded', async () => {
    const mgr = managerGranting('');
    const h = makeHarness(mgr);
    const other = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/x.png',
    });
    await flush();

    mgr.setRules('NOPASSWD Write /.playwright/**');
    expect(h.router.settleGrantedRequests('some-other-folder')).toBe(0);
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    h.router.failAll();
    await expect(other).resolves.toEqual({ decision: 'deny' });
  });

  it('flips the card under the OWNING cone in a multi-cone session', async () => {
    const coneA = scoop('cone_a', true);
    const coneB = scoop('cone_b', true);
    const requester = { ...scoop('scoop_b_child', false), parentJid: 'cone_b' };
    const scoops = new Map<string, RegisteredScoop>([
      [coneA.jid, coneA],
      [coneB.jid, coneB],
      [requester.jid, requester],
    ]);
    const store: ChannelMessage[] = [];
    let rules = '';
    const deps: ScoopApprovalRouterDeps = {
      getScoops: () => scoops,

      findApprover: (jid) => (jid === requester.jid ? coneB : coneA),
      getSudoManager: () =>
        ({
          getPolicyForScoop: () => parseSudoers(rules),
        }) as unknown as SudoManager,
      getLickManager: () => null,
      handleMessage: async (msg) => {
        store.push(msg);
      },
      onMessageUpdate: vi.fn(),
      getMessagesForScoop: async (jid) => store.filter((m) => m.chatJid === jid),
      saveMessage: async (msg) => {
        const i = store.findIndex((m) => m.id === msg.id);
        if (i >= 0) store[i] = msg;
        else store.push(msg);
      },
    };
    const router = new ScoopApprovalRouter(deps);

    const covered = router.enqueueSudoRequest(requester.jid, {
      kind: 'write',
      detail: '/.playwright/x.png',
    });
    await flush();
    const card = store.find((m) => m.chatJid === coneB.jid);
    expect(card?.lickState).toBe('pending');

    rules = 'NOPASSWD Write /.playwright/**';
    expect(router.settleGrantedRequests(requester.folder)).toBe(1);
    await flush();

    await expect(covered).resolves.toEqual({ decision: 'allow' });

    expect(card?.lickState).toBe('confirmed');
  });

  it('is a no-op without a SudoManager', async () => {
    const h = makeHarness(null);
    const pending = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/x.png',
    });
    await flush();

    expect(h.router.settleGrantedRequests('scoop_a-folder')).toBe(0);
    h.router.failAll();
    await expect(pending).resolves.toEqual({ decision: 'deny' });
  });

  it("an 'always' persist via appendScoopRule auto-settles the scoop's other covered request", async () => {
    const { VirtualFS } = await import('../../src/fs/index.js');
    const { FsWatcher } = await import('../../src/fs/fs-watcher.js');
    const { SudoManager } = await import('../../src/sudo/sudo-manager.js');

    const vfs = await VirtualFS.create({
      dbName: `test-router-e2e-settle-${Date.now()}`,
      wipe: true,
    });
    const watcher = new FsWatcher();
    vfs.setWatcher(watcher);

    let router: ScoopApprovalRouter | undefined;
    const mgr = new SudoManager({
      fs: vfs,
      watcher,
      broker: { requestApproval: vi.fn(async () => ({ decision: 'deny' as const })) },
      onPolicyReload: (folder) => void router?.settleGrantedRequests(folder),
    });
    await mgr.init();
    const h = makeHarness(mgr);
    router = h.router;
    await mgr.initScoopPolicy('scoop_a-folder', { writablePaths: ['/scoops/scoop_a-folder/'] });

    const first = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/screenshots/one.png',
    });
    const second = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/session.md',
    });
    await flush();
    const [{ id: firstId }] = h.router.listPendingSudoRequests();

    const result = await h.router.resolveSudoRequestAndPersist(firstId, {
      decision: 'always',
      pattern: '/.playwright/**',
    });

    expect(result).toEqual(expect.objectContaining({ settled: true, persisted: true }));
    await expect(first).resolves.toEqual({ decision: 'always', pattern: '/.playwright/**' });

    await expect(second).resolves.toEqual({ decision: 'allow' });
    expect(h.router.listPendingSudoRequests()).toHaveLength(0);

    const third = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/screenshots/two.png',
    });
    await expect(third).resolves.toEqual({ decision: 'allow' });
    expect(h.handleMessage).toHaveBeenCalledTimes(2);
    expect(h.router.listPendingSudoRequests()).toHaveLength(0);

    mgr.dispose();
    await vfs.dispose?.();
  });
});

describe('ScoopApprovalRouter admission-time grant match (issue #2853)', () => {
  function managerGranting(rules: string): SudoManager {
    return {
      getPolicyForScoop: () => parseSudoers(rules),
    } as unknown as SudoManager;
  }

  it('resolves allow immediately for a NOPASSWD-granted write path without prompting the cone', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /.playwright/**'));
    const covered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/snapshots',
      suggestedPattern: '/.playwright/**',
    });

    await expect(covered).resolves.toEqual({ decision: 'allow' });
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.router.listPendingSudoRequests()).toHaveLength(0);
    expect(h.store).toHaveLength(0);
  });

  it('still escalates an ungranted write path', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /.playwright/**'));
    const uncovered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.nogrant-test',
    });
    await flush();

    expect(h.handleMessage).toHaveBeenCalledOnce();
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    expect(h.store[0]?.lickState).toBe('pending');
    h.router.failAll();
    await expect(uncovered).resolves.toEqual({ decision: 'deny' });
  });

  it('resolves allow immediately for a NOPASSWD-granted command', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Cmnd git *'));
    const covered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'command',
      detail: 'git status',
    });

    await expect(covered).resolves.toEqual({ decision: 'allow' });
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.router.listPendingSudoRequests()).toHaveLength(0);
  });

  it('still escalates a matching rule that is not NOPASSWD', async () => {
    const h = makeHarness(managerGranting('Write /.playwright/**'));
    const pending = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/x.png',
    });
    await flush();

    expect(h.handleMessage).toHaveBeenCalledOnce();
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    h.router.failAll();
    await expect(pending).resolves.toEqual({ decision: 'deny' });
  });

  it('does not let a granted suggested_pattern smuggle an ungranted detail', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /.playwright/**'));
    const pending = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.nogrant-test',
      suggestedPattern: '/.playwright/**',
    });
    await flush();

    expect(h.handleMessage).toHaveBeenCalledOnce();
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    h.router.failAll();
    await expect(pending).resolves.toEqual({ decision: 'deny' });
  });

  it('still escalates a self-protected sudoers write despite NOPASSWD Write /**', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /**'));
    const pending = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/etc/sudoers',
    });
    await flush();

    expect(h.handleMessage).toHaveBeenCalledOnce();
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    h.router.failAll();
    await expect(pending).resolves.toEqual({ decision: 'deny' });
  });

  it('still escalates a secret request even when other grants exist', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /**\nNOPASSWD Cmnd *'));
    const pending = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'secret',
      detail: 'GITHUB_TOKEN',
    });
    await flush();

    expect(h.handleMessage).toHaveBeenCalledOnce();
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    h.router.failAll();
    await expect(pending).resolves.toEqual({ decision: 'deny' });
  });
});

describe('ScoopApprovalRouter settle paths flip the lick card off pending', () => {
  it('scoop-dropped: failScoop flips the stored card to dismissed', async () => {
    const h = makeHarness();
    const decision = h.router.enqueueSudoRequest('scoop_a', REQ);
    expect(h.store[0].lickState).toBe('pending');

    expect(h.router.failScoop('scoop_a')).toBe(1);
    await flush();

    expect(h.store[0].lickState).toBe('dismissed');
    expect(h.onMessageUpdate).toHaveBeenCalledWith(
      'cone_jid',
      expect.objectContaining({ lickId: h.store[0].lickId, lickState: 'dismissed' })
    );

    expect(h.handleMessage).toHaveBeenCalledTimes(1);
    await expect(decision).resolves.toEqual({ decision: 'deny' });
  });

  it('shutdown: failAll flips the stored card to dismissed', async () => {
    const h = makeHarness();
    const decision = h.router.enqueueSudoRequest('scoop_a', REQ);
    expect(h.store[0].lickState).toBe('pending');

    expect(h.router.failAll()).toBe(1);
    await flush();

    expect(h.store[0].lickState).toBe('dismissed');
    expect(h.onMessageUpdate).toHaveBeenCalledWith(
      'cone_jid',
      expect.objectContaining({ lickState: 'dismissed' })
    );
    expect(h.handleMessage).toHaveBeenCalledTimes(1);
    await expect(decision).resolves.toEqual({ decision: 'deny' });
  });

  it('expired: the fail-closed timer flips the stored card to dismissed', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const decision = h.router.enqueueSudoRequest('scoop_a', REQ);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.store[0].lickState).toBe('pending');

      await vi.advanceTimersByTimeAsync(CONE_SUDO_TIMEOUT_MS + 1);

      expect(h.store[0].lickState).toBe('dismissed');
      expect(h.onMessageUpdate).toHaveBeenCalledWith(
        'cone_jid',
        expect.objectContaining({ lickState: 'dismissed' })
      );
      expect(h.handleMessage).toHaveBeenCalledTimes(1);

      await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'cone-timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ScoopApprovalRouter unhonoured sudoers subjects', () => {
  it('denies a write to an in-sandbox sudoers path without prompting the cone', async () => {
    const h = makeHarness();

    const decision = await h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/scoops/scoop_a-folder/etc/sudoers',
    });

    expect(decision).toEqual({ decision: 'deny' });
    expect(h.router.listPendingSudoRequests()).toHaveLength(0);
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('still routes an ordinary write to the cone', async () => {
    const h = makeHarness();

    void h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/workspace/notes.md',
    });
    await flush();

    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    expect(h.handleMessage).toHaveBeenCalled();
  });
});
