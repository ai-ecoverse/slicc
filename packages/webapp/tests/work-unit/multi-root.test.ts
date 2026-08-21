/**
 * Two independent roots, each with a child, must never see each other's
 * traffic: completions, idle notices and approval requests go to the child's
 * own parent, closing one root tears down only its subtree, and the kernel
 * no longer needs a singleton cone (#1666, Phase 3).
 */

import type { LickEvent } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLickEventHandler, type LickRoutingContext } from '../../src/kernel/host.js';
import { ScoopApprovalRouter } from '../../src/scoops/scoop-approval-router.js';
import { ScoopCompletionService } from '../../src/scoops/scoop-completion-service.js';
import { SCOOP_IDLE_TIMEOUT_MS, ScoopIdleTimers } from '../../src/scoops/scoop-idle-timers.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';
import {
  clearDefaultRootJid,
  pickDefaultRoot,
  setDefaultRootJid,
} from '../../src/work-unit/default-root.js';
import { resolveLickTarget } from '../../src/work-unit/lick-target.js';
import { WorkUnitManager } from '../../src/work-unit/manager.js';
import { rootsOf } from '../../src/work-unit/policy.js';
import { normalizeScoopRecord } from '../../src/work-unit/record.js';
import { type FakeLocalStorage, installFakeLocalStorage } from '../helpers/fake-local-storage.js';
import { childRecord, makeFakeHost, rootRecord } from './fixtures.js';

function webhookLick(targetScoop?: string): LickEvent {
  return {
    type: 'webhook',
    webhookId: 'wh-1',
    webhookName: 'deploy',
    ...(targetScoop ? { targetScoop } : {}),
    timestamp: '2026-08-21T00:00:00.000Z',
    headers: {},
    body: { ok: true },
  };
}

/** Minimal routing context: records the chat each lick was delivered to. */
function routingContext(scoops: RegisteredScoop[], routed: string[]): LickRoutingContext {
  return {
    orchestrator: {
      getScoops: () => scoops,
      handleMessage: async (msg: ChannelMessage) => {
        routed.push(msg.chatJid);
      },
    } as never,
    lickManager: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
}

const rootA = rootRecord({ jid: 'cone_a', name: 'A', addedAt: '2026-01-01T00:00:00.000Z' });
const rootB = rootRecord({
  jid: 'cone_b',
  name: 'B',
  folder: 'cone-research',
  addedAt: '2026-01-02T00:00:00.000Z',
});
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

  it('a scoop_wait batch spanning two roots delivers each root only its own results', async () => {
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

    const { scheduled } = service.scheduleScoopWait([childA.jid, childB.jid], 10_000);
    expect(scheduled).toEqual([childA.jid, childB.jid]);
    service.setResponseFull(childA.jid, 'A result');
    await service.notifyCompletion(childA.jid);
    service.setResponseFull(childB.jid, 'B result');
    await service.notifyCompletion(childB.jid);
    await new Promise((r) => setTimeout(r, 0));

    const waits = routed.filter((m) => m.channel === 'scoop-wait');
    expect(waits.map((m) => m.chatJid).sort()).toEqual([rootA.jid, rootB.jid].sort());
    const forA = waits.find((m) => m.chatJid === rootA.jid)!;
    const forB = waits.find((m) => m.chatJid === rootB.jid)!;
    expect(forA.content).toContain('A result');
    expect(forA.content).not.toContain('B result');
    expect(forB.content).toContain('B result');
    expect(forB.content).not.toContain('A result');
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

/**
 * With two cones registered, "the default" is no longer a coin toss: it is a
 * persisted pick, and every unaddressed event honours it (#2273). A cone is
 * addressable by folder (`cone-research`), so a webhook or a background job
 * can name one the way it has always named a scoop.
 */
describe('two-root event routing', () => {
  let storage: FakeLocalStorage;

  beforeEach(() => {
    storage = installFakeLocalStorage();
  });
  afterEach(() => {
    storage.restore();
  });

  const registered = [rootA, childA, rootB, childB];

  it('the default root is the persisted pick while it is still a root', () => {
    expect(pickDefaultRoot(registered)?.jid).toBe(rootA.jid);
    setDefaultRootJid(rootB.jid);
    expect(pickDefaultRoot(registered)?.jid).toBe(rootB.jid);
    expect(new WorkUnitManager(makeFakeHost(registered)).resolveDefaultRoot()?.descriptor.id).toBe(
      rootB.jid
    );
  });

  it('falls back to the primary cone, then the oldest, and never to a child', () => {
    // A jid that is not a registered root (dropped cone, or a scoop someone
    // pointed the setting at) must not swallow events.
    setDefaultRootJid('cone_gone');
    expect(pickDefaultRoot(registered)?.jid).toBe(rootA.jid);
    setDefaultRootJid(childB.jid);
    expect(pickDefaultRoot(registered)?.jid).toBe(rootA.jid);
    // No primary `cone` folder at all → oldest root wins.
    const noPrimary = [
      rootRecord({ jid: 'cone_x', folder: 'cone-x', addedAt: '2026-03-01' }),
      rootB,
    ];
    clearDefaultRootJid();
    expect(pickDefaultRoot(noPrimary)?.jid).toBe(rootB.jid);
  });

  it('resolves a lick target by cone folder, scoop name and scoop folder', () => {
    expect(resolveLickTarget(registered, 'cone-research')?.jid).toBe(rootB.jid);
    expect(resolveLickTarget(registered, 'cone')?.jid).toBe(rootA.jid);
    expect(resolveLickTarget(registered, 'B')?.jid).toBe(rootB.jid);
    expect(resolveLickTarget(registered, 'b-worker')?.jid).toBe(childB.jid);
    const helper = childRecord(rootB.jid, {
      jid: 'scoop_helper',
      name: 'helper',
      folder: 'helper-scoop',
    });
    expect(resolveLickTarget([...registered, helper], 'helper')?.jid).toBe(helper.jid);
  });

  it('resolves an ambiguous alias by folder, not by registry order', () => {
    // Names are user-typed and not unique against folders: a cone the user
    // called "reviewer" next to a scoop living in `reviewer-scoop` must not
    // resolve by whichever record happens to sort first.
    const named = rootRecord({
      jid: 'cone_named',
      name: 'reviewer',
      folder: 'cone-reviewer',
      addedAt: '2026-01-03T00:00:00.000Z',
    });
    const foldered = childRecord(rootA.jid, {
      jid: 'scoop_reviewer',
      name: 'checker',
      folder: 'reviewer',
    });
    const suffixed = childRecord(rootA.jid, {
      jid: 'scoop_reviewer_suffixed',
      name: 'other',
      folder: 'reviewer-scoop',
    });
    // Exact folder wins over the `-scoop` folder and over the name, in both
    // registry orders.
    expect(resolveLickTarget([named, suffixed, foldered], 'reviewer')?.jid).toBe(foldered.jid);
    expect(resolveLickTarget([foldered, suffixed, named], 'reviewer')?.jid).toBe(foldered.jid);
    // Without the exact folder, `<alias>-scoop` beats the name.
    expect(resolveLickTarget([named, suffixed], 'reviewer')?.jid).toBe(suffixed.jid);
    // Name only when nothing else claims the alias.
    expect(resolveLickTarget([named], 'reviewer')?.jid).toBe(named.jid);
  });

  it('drops an unmatched target but lets sprinkle routing fall through', () => {
    setDefaultRootJid(rootB.jid);
    expect(resolveLickTarget(registered, 'ghost-scoop')).toBeUndefined();
    expect(resolveLickTarget(registered, 'ghost-scoop', { unmatched: 'default-root' })?.jid).toBe(
      rootB.jid
    );
    expect(resolveLickTarget(registered, undefined)?.jid).toBe(rootB.jid);
  });

  it('a webhook reaches the cone it names, and the configured default without one', () => {
    const routed: string[] = [];
    const ctx = routingContext(registered, routed);

    defaultLickEventHandler(webhookLick('cone-research'), ctx);
    setDefaultRootJid(rootB.jid);
    defaultLickEventHandler(webhookLick(), ctx);
    clearDefaultRootJid();
    defaultLickEventHandler(webhookLick(), ctx);

    expect(routed).toEqual([rootB.jid, rootB.jid, rootA.jid]);
  });

  it('a cron task naming cone B keeps firing into cone B', () => {
    const routed: string[] = [];
    // `crontask create --scoop cone-research` persists the cone folder, so the
    // task still reaches cone B after a reload — even though the default root
    // is cone A.
    defaultLickEventHandler(
      {
        type: 'cron',
        cronId: 'cr-1',
        cronName: 'nightly',
        targetScoop: rootB.folder,
        timestamp: 't',
        body: { time: 't' },
      },
      routingContext(registered, routed)
    );
    expect(routed).toEqual([rootB.jid]);
  });

  it('a background bash job in cone B reports back into cone B', () => {
    const routed: string[] = [];
    // What `ScoopContext` stamps: the owning unit's folder, root or child.
    defaultLickEventHandler(
      {
        type: 'bash',
        targetScoop: rootB.folder,
        bashJobId: 'bg-1',
        bashCommand: 'npm run build',
        bashExitCode: 0,
        resultPath: '/tmp/bash-bg-1.txt',
        preview: 'built',
        timestamp: 't',
        body: {},
      } as LickEvent,
      routingContext(registered, routed)
    );
    expect(routed).toEqual([rootB.jid]);
  });
});
