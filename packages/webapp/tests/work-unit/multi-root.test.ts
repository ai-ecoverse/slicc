/**
 * Two independent roots, each with a child, must never see each other's
 * traffic: completions, idle notices and approval requests go to the child's
 * own parent, closing one root tears down only its subtree, and the kernel
 * no longer needs a singleton cone (#1666, Phase 3).
 */

import { describe, expect, it, vi } from 'vitest';
import { ScoopApprovalRouter } from '../../src/scoops/scoop-approval-router.js';
import { ScoopCompletionService } from '../../src/scoops/scoop-completion-service.js';
import { SCOOP_IDLE_TIMEOUT_MS, ScoopIdleTimers } from '../../src/scoops/scoop-idle-timers.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';
import { WorkUnitManager } from '../../src/work-unit/manager.js';
import { rootsOf } from '../../src/work-unit/policy.js';
import { normalizeScoopRecord } from '../../src/work-unit/record.js';
import { childRecord, makeFakeHost, rootRecord } from './fixtures.js';

const rootA = rootRecord({ jid: 'cone_a', name: 'A', addedAt: '2026-01-01T00:00:00.000Z' });
const rootB = rootRecord({ jid: 'cone_b', name: 'B', addedAt: '2026-01-02T00:00:00.000Z' });
const childA = childRecord(rootA.jid, { folder: 'a-worker' });
const childB = childRecord(rootB.jid, { folder: 'b-worker' });

function registry(): Map<string, RegisteredScoop> {
  return new Map([rootA, childA, rootB, childB].map((s) => [s.jid, { ...s }]));
}

/** What the orchestrator wires: the child's parent, else the default root. */
function parentOrDefaultRoot(scoops: Map<string, RegisteredScoop>) {
  return (jid: string | undefined) => {
    const scoop = jid === undefined ? undefined : scoops.get(jid);
    const parent = scoop?.parentJid ? scoops.get(scoop.parentJid) : undefined;
    return parent ?? rootsOf(scoops.values())[0];
  };
}

describe('multiple roots', () => {
  it('the hierarchy sees two roots with one child each and no singleton', () => {
    const host = makeFakeHost([rootA, childA, rootB, childB]);
    const manager = new WorkUnitManager(host);
    expect(manager.roots().map((u) => u.descriptor.id)).toEqual([rootA.jid, rootB.jid]);
    expect(manager.getChildren(rootA.jid).map((u) => u.descriptor.id)).toEqual([childA.jid]);
    expect(manager.getChildren(rootB.jid).map((u) => u.descriptor.id)).toEqual([childB.jid]);
    expect(manager.rootOf(childB.jid)?.descriptor.id).toBe(rootB.jid);
    // unaddressed events still have a deterministic home
    expect(manager.resolveDefaultRoot()?.descriptor.id).toBe(rootA.jid);
  });

  it('a completion is delivered to the child’s own parent', async () => {
    const scoops = registry();
    const routed: ChannelMessage[] = [];
    const service = new ScoopCompletionService({
      getSharedFs: () => null,
      getScoop: (jid) => scoops.get(jid),
      findParent: parentOrDefaultRoot(scoops),
      hasScoop: (jid) => scoops.has(jid),
      notifyIncomingMessage: vi.fn(),
      handleMessage: async (msg) => {
        routed.push(msg);
      },
      reportError: vi.fn(),
    });

    service.setResponseFull(childB.jid, 'B is done');
    await service.notifyCompletion(childB.jid);
    service.setResponseFull(childA.jid, 'A is done');
    await service.notifyCompletion(childA.jid);

    expect(routed.map((m) => m.chatJid)).toEqual([rootB.jid, rootA.jid]);
    expect(routed[0].content).toContain('B is done');
    expect(routed[1].content).toContain('A is done');
  });

  it('a root never produces a completion notification', async () => {
    const scoops = registry();
    const handleMessage = vi.fn(async () => {});
    const service = new ScoopCompletionService({
      getSharedFs: () => null,
      getScoop: (jid) => scoops.get(jid),
      findParent: parentOrDefaultRoot(scoops),
      hasScoop: (jid) => scoops.has(jid),
      notifyIncomingMessage: vi.fn(),
      handleMessage,
      reportError: vi.fn(),
    });
    service.setResponseFull(rootB.jid, 'root output');
    await service.notifyCompletion(rootB.jid);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('an idle notice reaches the child’s own parent', () => {
    vi.useFakeTimers();
    try {
      const scoops = registry();
      const tabs = new Map<string, ScoopTabState>([
        [childB.jid, { jid: childB.jid, contextId: 'c', status: 'ready', lastActivity: 'x' }],
      ]);
      const notified: string[] = [];
      const timers = new ScoopIdleTimers({
        getScoops: () => scoops,
        getTabs: () => tabs,
        findParent: parentOrDefaultRoot(scoops),
        handleMessage: async (msg) => {
          notified.push(msg.chatJid);
        },
        notifyIncomingMessage: vi.fn(),
      });
      timers.start(childB.jid);
      vi.advanceTimersByTime(SCOOP_IDLE_TIMEOUT_MS + 1);
      expect(notified).toEqual([rootB.jid]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a sudo request is queued for the child’s own parent and fails closed without one', async () => {
    const scoops = registry();
    const store: ChannelMessage[] = [];
    const router = new ScoopApprovalRouter({
      getScoops: () => scoops,
      findApprover: parentOrDefaultRoot(scoops),
      getSudoManager: () => null,
      getLickManager: () => null,
      handleMessage: async (msg) => {
        store.push(msg);
      },
      onMessageUpdate: vi.fn(),
      getMessagesForScoop: async (jid) => store.filter((m) => m.chatJid === jid),
      saveMessage: async () => {},
    });

    const pending = router.enqueueSudoRequest(childB.jid, { kind: 'command', detail: 'git push' });
    await Promise.resolve();
    expect(store.map((m) => m.chatJid)).toEqual([rootB.jid]);
    const id = router.listPendingSudoRequests()[0]?.id;
    expect(id).toBeTruthy();
    router.resolveSudoRequest(id!, { decision: 'allow' });
    await expect(pending).resolves.toEqual({ decision: 'allow' });

    // no roots at all → deny
    const empty = new ScoopApprovalRouter({
      getScoops: () => new Map([[childA.jid, { ...childA }]]),
      findApprover: () => undefined,
      getSudoManager: () => null,
      getLickManager: () => null,
      handleMessage: async () => {},
      onMessageUpdate: vi.fn(),
      getMessagesForScoop: async () => [],
      saveMessage: async () => {},
    });
    await expect(
      empty.enqueueSudoRequest(childA.jid, { kind: 'command', detail: 'rm -rf' })
    ).resolves.toEqual({ decision: 'deny' });
  });

  it('closing root A closes its child and leaves root B’s subtree untouched', async () => {
    const host = makeFakeHost([rootA, childA, rootB, childB]);
    const manager = new WorkUnitManager(host);
    await manager.close(rootA.jid);
    expect(host.unregisterScoop.mock.calls.map(([jid]) => jid)).toEqual([childA.jid, rootA.jid]);
    expect(manager.roots().map((u) => u.descriptor.id)).toEqual([rootB.jid]);
    expect(manager.getChildren(rootB.jid).map((u) => u.descriptor.id)).toEqual([childB.jid]);
    expect(manager.resolveDefaultRoot()?.descriptor.id).toBe(rootB.jid);
  });

  it('normalizeScoopRecord derives the presentation fields from the edge', () => {
    const lyingRoot = normalizeScoopRecord(
      rootRecord({ isCone: false, type: 'scoop', trigger: '@x', requiresTrigger: true })
    );
    expect(lyingRoot).toMatchObject({
      isCone: true,
      type: 'cone',
      trigger: undefined,
      requiresTrigger: false,
    });
    const lyingChild = normalizeScoopRecord(childRecord(rootA.jid, { isCone: true, type: 'cone' }));
    expect(lyingChild).toMatchObject({ isCone: false, type: 'scoop', trigger: '@worker-scoop' });
  });
});
