import { describe, expect, it, vi } from 'vitest';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import type { AppendConeMemoryMeta } from '../../src/scoops/cone-memory-store.js';
import { ScoopCompletionService } from '../../src/scoops/scoop-completion-service.js';
import {
  type ScoopLifecycleDeps,
  ScoopLifecycleManager,
} from '../../src/scoops/scoop-lifecycle-manager.js';
import type { ChannelMessage, RegisteredScoop } from '../../src/scoops/types.js';

vi.mock('../../src/scoops/scoop-context.js', () => ({
  ScoopContext: class {
    disposed = false;
    constructor(
      readonly scoop: RegisteredScoop,
      readonly callbacks: {
        onFatalError?(error: string): void;
        onScoopScoop?: unknown;
        onFeedScoop?: unknown;
      },
      readonly fs?: unknown
    ) {}

    async init(): Promise<void> {}
    stop(): void {}
    dispose(): void {
      this.disposed = true;
    }
    getFS(): unknown {
      return this.fs ?? null;
    }
  },
}));

const scoop: RegisteredScoop = {
  jid: 'cone',
  name: 'Main',
  folder: 'main',
  parentJid: null,
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: new Date().toISOString(),
};

const worker: RegisteredScoop = {
  jid: 'scoop_overflow_1',
  name: 'overflow-worker',
  folder: 'overflow-worker',
  parentJid: 'cone',
  requiresTrigger: false,
  assistantLabel: 'overflow-worker',
  addedAt: new Date().toISOString(),
};

function makeManager(flushOnIdle: (jid: string) => Promise<void>): ScoopLifecycleManager {
  return new ScoopLifecycleManager({
    getScoops: () => new Map([[scoop.jid, scoop]]),
    getSharedFs: () => ({}),
    getSessionStore: () => null,
    getConversationStore: () => null,
    getProcessManager: () => null,
    getSudoManager: () => null,
    callbacks: { onStatusChange: vi.fn() },
    idleTimers: { start: vi.fn(), clear: vi.fn() },
    messageRouter: {
      ensureQueue: vi.fn(),
      forgetScoop: vi.fn(),
      flushOnIdle,
    },
  } as unknown as ScoopLifecycleDeps);
}

describe('ScoopLifecycleManager', () => {
  it('probes persisted messages when a constructed tab first becomes ready', async () => {
    const flushOnIdle = vi.fn(async () => {});
    const manager = makeManager(flushOnIdle);

    await manager.createTab(scoop.jid);

    expect(manager.getTab(scoop.jid)?.status).toBe('ready');
    expect(flushOnIdle).toHaveBeenCalledOnce();
    expect(flushOnIdle).toHaveBeenCalledWith(scoop.jid);
  });

  it('does not wait for a slow first-ready probe', async () => {
    const flushOnIdle = vi.fn(() => new Promise<void>(() => {}));
    const manager = makeManager(flushOnIdle);
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('createTab remained pending')), 50);
    });

    await expect(Promise.race([manager.createTab(scoop.jid), timeout])).resolves.toBeUndefined();
    expect(flushOnIdle).toHaveBeenCalledOnce();
  });

  it('contains a rejected first-ready probe', async () => {
    const flushOnIdle = vi.fn(async () => {
      throw new Error('probe failed');
    });
    const manager = makeManager(flushOnIdle);

    await expect(manager.createTab(scoop.jid)).resolves.toBeUndefined();
    expect(flushOnIdle).toHaveBeenCalledOnce();
  });

  it('never unregisters the last cone', async () => {
    const scoops = new Map([[scoop.jid, scoop]]);
    const deleteScoop = vi.fn(async () => {});
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getConversationStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      getLickManager: () => null,
      callbacks: { onStatusChange: vi.fn() },
      db: { saveScoop: vi.fn(async () => {}), deleteScoop },
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
      costTracker: { snapshot: vi.fn() },
      approvalRouter: { failScoop: vi.fn(() => 0) },
      completionService: { forgetScoop: vi.fn(), clearResponse: vi.fn() },
    } as unknown as ScoopLifecycleDeps);

    await expect(manager.unregister(scoop.jid)).rejects.toThrow(/last cone/);
    expect(scoops.has(scoop.jid)).toBe(true);
    expect(deleteScoop).not.toHaveBeenCalled();
  });

  it('cascades unregister through a supervisor subtree', async () => {
    const supervisor: RegisteredScoop = {
      ...worker,
      jid: 'scoop_lead',
      name: 'lead',
      folder: 'lead',
      parentJid: scoop.jid,
      config: { canCreateChildren: true },
    };
    const grandchild: RegisteredScoop = {
      ...worker,
      jid: 'scoop_deep',
      name: 'deep',
      folder: 'deep',
      parentJid: supervisor.jid,
    };
    const scoops = new Map([
      [scoop.jid, scoop],
      [supervisor.jid, supervisor],
      [grandchild.jid, grandchild],
    ]);
    const deleteScoop = vi.fn(async () => {});
    const forgetScoop = vi.fn();
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getConversationStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      getLickManager: () => null,
      callbacks: { onStatusChange: vi.fn() },
      db: { saveScoop: vi.fn(async () => {}), deleteScoop },
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop,
        flushOnIdle: vi.fn(async () => {}),
      },
      costTracker: { snapshot: vi.fn() },
      approvalRouter: { failScoop: vi.fn(() => 0) },
      completionService: { forgetScoop: vi.fn(), clearResponse: vi.fn() },
    } as unknown as ScoopLifecycleDeps);

    await manager.unregister(supervisor.jid);

    expect(scoops.has(supervisor.jid)).toBe(false);
    expect(scoops.has(grandchild.jid)).toBe(false);
    expect(scoops.has(scoop.jid)).toBe(true);
    expect(deleteScoop).toHaveBeenCalledWith(grandchild.jid);
    expect(deleteScoop).toHaveBeenCalledWith(supervisor.jid);
    expect(forgetScoop).toHaveBeenCalledWith(grandchild.jid);
    expect(forgetScoop).toHaveBeenCalledWith(supervisor.jid);
  });

  // #2271: the sink path is bound from the unit's own record, so an extra
  // cone's compaction pass can only append to its own `CLAUDE.md`.
  it('binds each cone memory append to that cone workspace', async () => {
    const extraCone: RegisteredScoop = {
      ...scoop,
      jid: 'cone_beta',
      name: 'Beta',
      folder: 'cone-beta',
      assistantLabel: 'Beta',
    };
    const primary: RegisteredScoop = { ...scoop, folder: 'cone' };
    const scoops = new Map([
      [primary.jid, primary],
      [extraCone.jid, extraCone],
    ]);
    const appendConeMemory = vi.fn(async (_bullets: string, _meta: AppendConeMemoryMeta) => {});
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getConversationStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      callbacks: { onStatusChange: vi.fn() },
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
      cone: { appendConeMemory },
    } as unknown as ScoopLifecycleDeps);

    for (const jid of [primary.jid, extraCone.jid]) {
      await manager.createTab(jid);
      const context = manager.getContext(jid) as unknown as {
        callbacks: {
          appendConeMemory(bullets: string, meta: AppendConeMemoryMeta): Promise<void>;
        };
      };
      // A caller-supplied path must not win — the manager owns the binding.
      await context.callbacks.appendConeMemory('- a fact', {
        source: 'compaction',
        memoryPath: '/workspace/CLAUDE.md',
      });
    }

    expect(appendConeMemory.mock.calls.map(([, meta]) => meta.memoryPath)).toEqual([
      '/workspace/CLAUDE.md',
      '/cones/cone-beta/CLAUDE.md',
    ]);
  });

  it('routes fatal scoop errors to the cone and releases active scoop_wait callers', async () => {
    const scoops = new Map([
      [scoop.jid, scoop],
      [worker.jid, worker],
    ]);
    const incoming: ChannelMessage[] = [];
    const routed: ChannelMessage[] = [];
    const completionService = new ScoopCompletionService({
      getSharedFs: () => null,
      getScoop: (jid) => scoops.get(jid),
      findParent: () => scoop,
      hasScoop: (jid) => scoops.has(jid),
      notifyIncomingMessage: (_jid, message) => incoming.push(message),
      handleMessage: async (message) => {
        routed.push(message);
      },
      reportError: vi.fn(),
    });
    const forgetScoop = vi.spyOn(completionService, 'forgetScoop');
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getConversationStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      callbacks: {
        onError: vi.fn(),
        onStatusChange: vi.fn(),
        onIncomingMessage: (_jid: string, message: ChannelMessage) => incoming.push(message),
      },
      completionService,
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
      handleMessage: async (message: ChannelMessage) => {
        routed.push(message);
      },
    } as unknown as ScoopLifecycleDeps);

    await manager.createTab(worker.jid);
    const waitPromise = completionService.waitForScoops([worker.jid]);
    const context = manager.getContext(worker.jid) as unknown as {
      callbacks: { onFatalError(error: string): void };
    };

    context.callbacks.onFatalError('Context window exceeded and could not be reduced');

    await expect(waitPromise).resolves.toEqual([
      { jid: worker.jid, summary: null, timedOut: true },
    ]);
    expect(forgetScoop).toHaveBeenCalledWith(worker.jid, 'fatal-error');
    expect(incoming).toEqual([
      expect.objectContaining({ chatJid: scoop.jid, channel: 'scoop-error' }),
    ]);
    expect(routed).toEqual([
      expect.objectContaining({
        chatJid: scoop.jid,
        channel: 'scoop-error',
        content: expect.stringContaining('Context window exceeded and could not be reduced'),
      }),
    ]);
  });

  // #2360 (review follow-up): `scoop_scoop` picks a free folder from the
  // roster, but two cones creating the same name concurrently would both pass
  // that check while the first record is still inside `saveScoop`. The claim
  // therefore happens synchronously inside `register`, before the first await.
  it('reserves a free folder synchronously so concurrent registrations cannot share a sandbox', async () => {
    const scoops = new Map<string, RegisteredScoop>([[scoop.jid, scoop]]);
    let releaseSave: (() => void) | undefined;
    const saveScoop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        })
    );
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      getLickManager: () => null,
      callbacks: { onStatusChange: vi.fn() },
      db: { saveScoop, deleteScoop: vi.fn(async () => {}) },
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
      costTracker: { snapshot: vi.fn() },
      approvalRouter: { failScoop: vi.fn(() => 0) },
      completionService: { forgetScoop: vi.fn(), clearResponse: vi.fn() },
    } as unknown as ScoopLifecycleDeps);

    const first: RegisteredScoop = { ...worker, jid: 'scoop_a', folder: 'helper-scoop' };
    // Cone B's identically named scoop, created while `first` is mid-save.
    const second: RegisteredScoop = {
      ...worker,
      jid: 'scoop_b',
      parentJid: 'cone_b',
      folder: 'helper-scoop',
    };

    void manager.register(first).catch(() => {});
    void manager.register(second).catch(() => {});

    expect(first.folder).toBe('helper-scoop');
    expect(second.folder).toBe('helper-scoop-2');
    expect(second.trigger).toBe('@helper-scoop-2');
    expect(scoops.get('scoop_b')?.folder).toBe('helper-scoop-2');
    releaseSave?.();
  });

  it('releases the claimed registry slot when the record cannot be persisted', async () => {
    const scoops = new Map<string, RegisteredScoop>([[scoop.jid, scoop]]);
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => ({}),
      getSessionStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      getLickManager: () => null,
      callbacks: { onStatusChange: vi.fn() },
      db: {
        saveScoop: vi.fn(async () => {
          throw new Error('quota exceeded');
        }),
        deleteScoop: vi.fn(async () => {}),
      },
      idleTimers: { start: vi.fn(), clear: vi.fn() },
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
      costTracker: { snapshot: vi.fn() },
      approvalRouter: { failScoop: vi.fn(() => 0) },
      completionService: { forgetScoop: vi.fn(), clearResponse: vi.fn() },
    } as unknown as ScoopLifecycleDeps);

    await expect(manager.register({ ...worker, jid: 'scoop_c' })).rejects.toThrow(/quota exceeded/);
    expect(scoops.has('scoop_c')).toBe(false);
  });
});

describe('ScoopLifecycleManager.reinitAfterPromote (#2278)', () => {
  type FakeContext = {
    scoop: RegisteredScoop;
    callbacks: { onScoopScoop?: unknown; onFeedScoop?: unknown };
    fs?: unknown;
    disposed: boolean;
  };

  function makePair() {
    const child: RegisteredScoop = { ...worker };
    const scoops = new Map<string, RegisteredScoop>([
      [scoop.jid, scoop],
      [child.jid, child],
    ]);
    const sharedFs = { kind: 'shared-vfs' };
    const idleTimers = { start: vi.fn(), clear: vi.fn() };
    const manager = new ScoopLifecycleManager({
      getScoops: () => scoops,
      getSharedFs: () => sharedFs,
      getSessionStore: () => null,
      getConversationStore: () => null,
      getProcessManager: () => null,
      getSudoManager: () => null,
      callbacks: { onStatusChange: vi.fn() },
      idleTimers,
      messageRouter: {
        ensureQueue: vi.fn(),
        forgetScoop: vi.fn(),
        flushOnIdle: vi.fn(async () => {}),
      },
      completionService: {
        forgetScoop: vi.fn(),
        clearResponse: vi.fn(),
        notifyCompletion: vi.fn(),
      },
      cone: { getScoops: () => [...scoops.values()] },
    } as unknown as ScoopLifecycleDeps);
    return { manager, scoops, child, sharedFs, idleTimers };
  }

  it('rebuilds the live context as a root: full-workspace FS, child tools, no idle timer', async () => {
    const { manager, child, sharedFs, idleTimers } = makePair();
    await manager.createTab(child.jid);
    const before = manager.getContext(child.jid) as unknown as FakeContext;
    expect(before.scoop.parentJid).toBe(scoop.jid);
    expect(before.fs).toBeInstanceOf(RestrictedFS);
    expect(before.callbacks.onScoopScoop).toBeUndefined();
    expect(idleTimers.start).toHaveBeenCalledWith(child.jid);

    child.parentJid = null;
    await manager.reinitAfterPromote(child.jid);

    expect(before.disposed).toBe(true);
    const after = manager.getContext(child.jid) as unknown as FakeContext;
    expect(after).not.toBe(before);
    expect(after.scoop.parentJid).toBeNull();
    expect(after.fs).toBe(sharedFs);
    expect(after.callbacks.onScoopScoop).toBeTypeOf('function');
    expect(after.callbacks.onFeedScoop).toBeTypeOf('function');
    expect(idleTimers.start).toHaveBeenCalledOnce();
    expect(idleTimers.clear).toHaveBeenCalled();
    expect(manager.getTab(child.jid)?.status).toBe('ready');
  });

  it('is a no-op when the unit has never spawned', async () => {
    const { manager, child, idleTimers } = makePair();
    child.parentJid = null;
    await manager.reinitAfterPromote(child.jid);
    expect(manager.getContext(child.jid)).toBeUndefined();
    expect(idleTimers.start).not.toHaveBeenCalled();
  });

  it('keeps observers across the rebuild', async () => {
    const { manager, child } = makePair();
    const statuses: string[] = [];
    manager.observe(child.jid, { onStatusChange: (status) => statuses.push(status) });
    await manager.createTab(child.jid);
    child.parentJid = null;
    await manager.reinitAfterPromote(child.jid);
    expect(statuses).toContain('ready');
    expect(manager.getContext(child.jid)).toBeDefined();
  });

  it('does not leave the child runtime in place if rebuild fails', async () => {
    const { manager, child } = makePair();
    await manager.createTab(child.jid);
    const before = manager.getContext(child.jid) as unknown as FakeContext;
    child.parentJid = null;
    vi.spyOn(manager, 'createTab').mockRejectedValueOnce(new Error('boom'));
    await manager.reinitAfterPromote(child.jid);
    expect(before.disposed).toBe(true);
    expect(manager.getContext(child.jid)).toBeUndefined();
    expect(manager.getTab(child.jid)?.status).toBe('error');
  });
});
