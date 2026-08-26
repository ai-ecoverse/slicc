/**
 * Router-level settle paths for cone-mediated sudo requests.
 *
 * When a request is settled fail-closed WITHOUT a cone decision — the
 * per-request timer fires (`expired`), the requesting scoop is dropped
 * (`scoop-dropped`), or the orchestrator shuts down (`shutdown`) — the stored
 * `sudo-request` lick card must flip off `pending` to `dismissed`, and the cone
 * must NOT be re-prompted (no second `handleMessage` delivery).
 */

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
    const sudoManager = { appendScoopRule } as unknown as SudoManager;
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

// #2416: after an 'always' approval widens a scoop's policy (or its config is
// re-registered), other requests from that scoop that the new policy already
// covers must resolve as allow instead of stalling until individually approved
// (which also appended duplicate rules).
describe('ScoopApprovalRouter settleGrantedRequests (issue #2416)', () => {
  function managerGranting(rules: string): SudoManager {
    return {
      getPolicyForScoop: () => parseSudoers(rules),
    } as unknown as SudoManager;
  }

  it('resolves pending path requests now covered by a NOPASSWD grant', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /.playwright/**'));
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

    const settled = h.router.settleGrantedRequests('scoop_a-folder');
    await flush();

    expect(settled).toBe(1);
    await expect(covered).resolves.toEqual({ decision: 'allow' });
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    // The covered request's card flips to confirmed; the uncovered one stays pending.
    expect(h.store.find((m) => m.content.includes('/.playwright'))?.lickState).toBe('confirmed');
    expect(h.store.find((m) => m.content.includes('/.migration'))?.lickState).toBe('pending');
    // Cleanup so the uncovered request doesn't dangle.
    h.router.failAll();
    await expect(uncovered).resolves.toEqual({ decision: 'deny' });
  });

  it('resolves pending command requests now covered by a NOPASSWD Cmnd grant', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Cmnd git *'));
    const covered = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'command',
      detail: 'git status',
    });
    await flush();

    expect(h.router.settleGrantedRequests('scoop_a-folder')).toBe(1);
    await expect(covered).resolves.toEqual({ decision: 'allow' });
  });

  it('only settles requests from the scoop whose policy reloaded', async () => {
    const h = makeHarness(managerGranting('NOPASSWD Write /.playwright/**'));
    const other = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'write',
      detail: '/.playwright/x.png',
    });
    await flush();

    expect(h.router.settleGrantedRequests('some-other-folder')).toBe(0);
    expect(h.router.listPendingSudoRequests()).toHaveLength(1);
    h.router.failAll();
    await expect(other).resolves.toEqual({ decision: 'deny' });
  });

  // #2455 review: `registry.resolve()` deletes the entry, so ownership must be
  // captured BEFORE settling — otherwise the card flip searches the DEFAULT
  // root's messages and the owning cone's card stays pending forever.
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
    const deps: ScoopApprovalRouterDeps = {
      getScoops: () => scoops,
      // Real approver semantics: the requesting scoop's parent; the DEFAULT
      // root (cone_a) for undefined/unknown jids — the exact fallback the
      // ownership bug used to hit after the registry entry was deleted.
      findApprover: (jid) => (jid === requester.jid ? coneB : coneA),
      getSudoManager: () =>
        ({
          getPolicyForScoop: () => parseSudoers('NOPASSWD Write /.playwright/**'),
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

    expect(router.settleGrantedRequests(requester.folder)).toBe(1);
    await flush();

    await expect(covered).resolves.toEqual({ decision: 'allow' });
    // The card lives under cone B and must flip there — not under cone A.
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

  // End-to-end through the real reload seam (#2455 review): a real SudoManager
  // whose `onPolicyReload` is wired to the router (mirroring the orchestrator's
  // wiring), driven by `appendScoopRule` — exactly what `lick_confirm` with
  // `always: true` does. The second pending request for the granted subtree
  // must auto-resolve without a second approval.
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

    // Two-phase init — the orchestrator builds the manager with a callback
    // that closes over the router it constructs alongside; mirror that.
    // (In production the orchestrator field-initializes the router before
    // `init()`; here it is created after, so guard the boot-time reload.)
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

    // The cone approves the FIRST request with always + a subtree pattern.
    const result = await h.router.resolveSudoRequestAndPersist(firstId, {
      decision: 'always',
      pattern: '/.playwright/**',
    });

    expect(result).toEqual(expect.objectContaining({ settled: true, persisted: true }));
    await expect(first).resolves.toEqual({ decision: 'always', pattern: '/.playwright/**' });
    // The SECOND request is auto-settled by the reload — no second approval.
    await expect(second).resolves.toEqual({ decision: 'allow' });
    expect(h.router.listPendingSudoRequests()).toHaveLength(0);

    mgr.dispose();
    await vfs.dispose?.();
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
    // Only the original delivery — settling must not re-prompt the cone.
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
      // Tagged `cone-timeout` so the scoop hears "the cone never answered"
      // rather than "the cone said no" — and is not told to wait for a user
      // who was never prompted. See sudo/approval-timeout.ts.
      await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'cone-timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
