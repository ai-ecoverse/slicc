import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GELATIERE_OWNER_JID } from '../../src/base/gelatiere-constants.js';
import {
  type ScoopLifecycleDeps,
  ScoopLifecycleManager,
} from '../../src/scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { modelFor } from '../../src/work-unit/record.js';

const updateModel = vi.fn();
const prompt = vi.fn(async () => {});

vi.mock('../../src/scoops/scoop-context.js', () => ({
  ScoopContext: class {
    async init(): Promise<void> {}
    updateModel(): void {
      updateModel();
    }
    async prompt(): Promise<void> {
      await prompt();
    }
  },
}));

vi.mock('../../src/scoops/model-seed.js', () => ({
  globalSeedModel: () => ({ provider: 'seed-provider', id: 'seed-model' }),
}));

function root(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function gelatiere(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return root({
    jid: 'scoop_gelatiere',
    name: 'gelatiere',
    folder: 'gelatiere',
    parentJid: GELATIERE_OWNER_JID,
    assistantLabel: 'gelatiere',
    notifyOnComplete: false,
    ...overrides,
  });
}

function makeManager(
  scoops: Map<string, RegisteredScoop>,
  saveScoop: ReturnType<typeof vi.fn> = vi.fn(async () => {})
): {
  manager: ScoopLifecycleManager;
  saveScoop: ReturnType<typeof vi.fn>;
} {
  const manager = new ScoopLifecycleManager({
    getScoops: () => scoops,
    getSharedFs: () => ({}),
    getSessionStore: () => null,
    getConversationStore: () => null,
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
  return { manager, saveScoop };
}

describe('per-cone model selection (#2310)', () => {
  beforeEach(() => {
    updateModel.mockClear();
    prompt.mockClear();
  });

  it('seeds the first cone of a profile from the global selection', async () => {
    const scoops = new Map<string, RegisteredScoop>();
    const { manager } = makeManager(scoops);

    await manager.register(root());

    expect(modelFor(scoops.get('cone_1')!)).toEqual({
      provider: 'seed-provider',
      id: 'seed-model',
    });
  });

  it('copies the creating cone’s model onto a scoop at creation', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([[cone.jid, cone]]);
    const { manager } = makeManager(scoops);

    await manager.register({ ...root({ jid: 'scoop_1', folder: 'worker' }), parentJid: cone.jid });

    expect(modelFor(scoops.get('scoop_1')!)).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
  });

  it('creates Gelatiere on the canonical leading cone, never the global seed', async () => {
    const olderExtra = root({
      jid: 'cone_2',
      folder: 'cone-research',
      addedAt: '2026-08-01T00:00:00.000Z',
      model: { provider: 'openai', id: 'gpt-5' },
    });
    const primary = root({
      addedAt: '2026-09-01T00:00:00.000Z',
      model: { provider: 'adobe', id: 'claude-opus-4-8' },
    });
    const scoops = new Map([
      [olderExtra.jid, olderExtra],
      [primary.jid, primary],
    ]);
    const { manager } = makeManager(scoops);

    await manager.register(gelatiere({ model: { provider: 'wrong', id: 'stale' } }));

    expect(modelFor(scoops.get('scoop_gelatiere')!)).toEqual({
      provider: 'adobe',
      id: 'claude-opus-4-8',
    });
  });

  it('never retargets a scoop when its cone’s model changes later', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([[cone.jid, cone]]);
    const { manager } = makeManager(scoops);
    await manager.register({ ...root({ jid: 'scoop_1', folder: 'worker' }), parentJid: cone.jid });

    await manager.setModel(cone.jid, { provider: 'openai', id: 'gpt-4.1' });

    expect(modelFor(scoops.get('cone_1')!)).toEqual({ provider: 'openai', id: 'gpt-4.1' });

    expect(modelFor(scoops.get('scoop_1')!)).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
  });

  it('retargets Gelatiere when the leading cone model changes, but no ordinary scoop', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const ordinary = root({
      jid: 'scoop_1',
      folder: 'worker',
      parentJid: cone.jid,
      model: { provider: 'anthropic', id: 'claude-opus-4-6' },
    });
    const system = gelatiere({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([
      [cone.jid, cone],
      [ordinary.jid, ordinary],
      [system.jid, system],
    ]);
    const { manager, saveScoop } = makeManager(scoops);
    await manager.createTab(system.jid);
    updateModel.mockClear();

    await manager.setModel(cone.jid, { provider: 'openai', id: 'gpt-5' });

    expect(modelFor(system)).toEqual({ provider: 'openai', id: 'gpt-5' });
    expect(modelFor(ordinary)).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
    expect(saveScoop).toHaveBeenCalledWith(system);
    expect(updateModel).toHaveBeenCalledOnce();
  });

  it('repairs a stale Gelatiere and re-resolves it immediately before a run', async () => {
    const cone = root({ model: { provider: 'adobe', id: 'claude-opus-4-8' } });
    const system = gelatiere({ model: { provider: 'old-provider', id: 'old-model' } });
    const scoops = new Map([
      [cone.jid, cone],
      [system.jid, system],
    ]);
    const { manager, saveScoop } = makeManager(scoops);

    await manager.sendPrompt(system.jid, 'nightly', 'cron', 'Cron');

    expect(modelFor(system)).toEqual({ provider: 'adobe', id: 'claude-opus-4-8' });
    expect(saveScoop).toHaveBeenCalledWith(system);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('re-resolves an already-current Gelatiere context before a scheduled run', async () => {
    const cone = root({ model: { provider: 'adobe', id: 'claude-opus-4-8' } });
    const system = gelatiere({ model: { provider: 'adobe', id: 'claude-opus-4-8' } });
    const scoops = new Map([
      [cone.jid, cone],
      [system.jid, system],
    ]);
    const { manager, saveScoop } = makeManager(scoops);
    await manager.createTab(system.jid);
    updateModel.mockClear();

    await manager.sendPrompt(system.jid, 'nightly', 'scheduler', 'Scheduled Task');

    expect(saveScoop).not.toHaveBeenCalledWith(system);
    expect(updateModel).toHaveBeenCalledOnce();
    expect(updateModel.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0]
    );
  });

  it('blocks a Gelatiere run when the leading-model repair cannot be persisted', async () => {
    const cone = root({ model: { provider: 'adobe', id: 'claude-opus-4-8' } });
    const system = gelatiere({ model: { provider: 'old-provider', id: 'old-model' } });
    const scoops = new Map([
      [cone.jid, cone],
      [system.jid, system],
    ]);
    const saveScoop = vi.fn(async () => {
      throw new Error('IndexedDB unavailable');
    });
    const { manager } = makeManager(scoops, saveScoop);

    await expect(
      manager.sendPrompt(system.jid, 'nightly', 'scheduler', 'Scheduled Task')
    ).rejects.toThrow('IndexedDB unavailable');

    expect(modelFor(system)).toEqual({ provider: 'old-provider', id: 'old-model' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('follows the oldest remaining root when the primary cone is removed', async () => {
    const primary = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const replacement = root({
      jid: 'cone_2',
      folder: 'cone-research',
      addedAt: '2026-08-01T00:00:00.000Z',
      model: { provider: 'openai', id: 'gpt-5' },
    });
    const system = gelatiere({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([
      [replacement.jid, replacement],
      [primary.jid, primary],
      [system.jid, system],
    ]);
    const { manager, saveScoop } = makeManager(scoops);

    await manager.unregister(primary.jid);

    expect(modelFor(system)).toEqual({ provider: 'openai', id: 'gpt-5' });
    expect(saveScoop).toHaveBeenCalledWith(system);
  });

  it('follows a newly registered primary cone that replaces the fallback leader', async () => {
    const fallback = root({
      jid: 'cone_2',
      folder: 'cone-research',
      addedAt: '2026-08-01T00:00:00.000Z',
      model: { provider: 'openai', id: 'gpt-5' },
    });
    const system = gelatiere({ model: { provider: 'openai', id: 'gpt-5' } });
    const scoops = new Map([
      [fallback.jid, fallback],
      [system.jid, system],
    ]);
    const { manager, saveScoop } = makeManager(scoops);
    const primary = root({
      jid: 'cone_primary',
      folder: 'cone',
      addedAt: '2026-09-01T00:00:00.000Z',
      model: { provider: 'adobe', id: 'claude-opus-4-8' },
    });

    await manager.register(primary);

    expect(modelFor(system)).toEqual({ provider: 'adobe', id: 'claude-opus-4-8' });
    expect(saveScoop).toHaveBeenCalledWith(system);
  });

  it('does not retarget Gelatiere when a non-leading cone changes model', async () => {
    const primary = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const extra = root({
      jid: 'cone_2',
      folder: 'cone-research',
      model: { provider: 'openai', id: 'gpt-4.1' },
    });
    const system = gelatiere({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([
      [primary.jid, primary],
      [extra.jid, extra],
      [system.jid, system],
    ]);
    const { manager, saveScoop } = makeManager(scoops);

    await manager.setModel(extra.jid, { provider: 'openai', id: 'gpt-5' });

    expect(modelFor(system)).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
    expect(saveScoop).not.toHaveBeenCalledWith(system);
  });

  it('never seeds a model-less Gelatiere from selected-model', async () => {
    const cone = root();
    const scoops = new Map([[cone.jid, cone]]);
    const { manager } = makeManager(scoops);

    await manager.register(gelatiere());

    expect(modelFor(scoops.get('scoop_gelatiere')!)).toBeUndefined();
  });

  it('does not touch another cone when one cone’s model is set', async () => {
    const coneA = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const coneB = root({
      jid: 'cone_2',
      folder: 'cone-research',
      model: { provider: 'adobe', id: 'claude-sonnet-4-6' },
    });
    const scoops = new Map([
      [coneA.jid, coneA],
      [coneB.jid, coneB],
    ]);
    const { manager, saveScoop } = makeManager(scoops);

    await expect(manager.setModel(coneB.jid, { provider: 'openai', id: 'gpt-4.1' })).resolves.toBe(
      true
    );

    expect(modelFor(coneA)).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
    expect(modelFor(coneB)).toEqual({ provider: 'openai', id: 'gpt-4.1' });
    expect(saveScoop).toHaveBeenCalledTimes(1);
    expect(saveScoop).toHaveBeenCalledWith(coneB);
  });

  it('rolls back and reports failure when the record cannot be persisted', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([[cone.jid, cone]]);
    let diskFails = false;
    const saveScoop = vi.fn(async () => {
      if (diskFails) throw new Error('QuotaExceededError');
    });
    const { manager } = makeManager(scoops, saveScoop);
    await manager.register(cone);
    diskFails = true;
    updateModel.mockClear();

    await expect(manager.setModel(cone.jid, { provider: 'openai', id: 'gpt-4.1' })).resolves.toBe(
      false
    );

    expect(modelFor(cone)).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });

    expect(updateModel).toHaveBeenCalledTimes(2);
  });

  it('rejects a model change for a jid the registry does not know', async () => {
    const { manager, saveScoop } = makeManager(new Map());
    await expect(manager.setModel('ghost', { provider: 'openai', id: 'gpt-4.1' })).resolves.toBe(
      false
    );
    expect(saveScoop).not.toHaveBeenCalled();
  });

  it('re-resolves every live context against its own record, without changing any', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([[cone.jid, cone]]);
    const { manager } = makeManager(scoops);
    await manager.register(cone);
    updateModel.mockClear();

    manager.refreshModels();

    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(modelFor(cone)).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
  });

  it('persists a thinking level on the record, next to the model', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([[cone.jid, cone]]);
    const { manager, saveScoop } = makeManager(scoops);

    await manager.setThinkingLevel(cone.jid, 'xhigh', 'max');

    expect(cone.thinking).toEqual({ level: 'xhigh', effortOverride: 'max' });
    expect(cone.config?.thinkingLevel).toBeUndefined();
    expect(saveScoop).toHaveBeenCalledWith(cone);
  });
});
