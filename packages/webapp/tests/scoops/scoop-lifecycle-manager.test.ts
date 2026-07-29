import { describe, expect, it, vi } from 'vitest';
import {
  type ScoopLifecycleDeps,
  ScoopLifecycleManager,
} from '../../src/scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

vi.mock('../../src/scoops/scoop-context.js', () => ({
  ScoopContext: class {
    async init(): Promise<void> {}
  },
}));

const scoop: RegisteredScoop = {
  jid: 'cone',
  name: 'Main',
  folder: 'main',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
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
});
