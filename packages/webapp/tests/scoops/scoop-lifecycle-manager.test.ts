import { describe, expect, it, vi } from 'vitest';
import type { AppendConeMemoryMeta } from '../../src/scoops/cone-memory-store.js';
import { ScoopCompletionService } from '../../src/scoops/scoop-completion-service.js';
import {
  type ScoopLifecycleDeps,
  ScoopLifecycleManager,
} from '../../src/scoops/scoop-lifecycle-manager.js';
import type { ChannelMessage, RegisteredScoop } from '../../src/scoops/types.js';

vi.mock('../../src/scoops/scoop-context.js', () => ({
  ScoopContext: class {
    constructor(
      _scoop: RegisteredScoop,
      readonly callbacks: { onFatalError(error: string): void }
    ) {}

    async init(): Promise<void> {}
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
});
