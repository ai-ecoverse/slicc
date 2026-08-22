/**
 * Per-cone model selection through the lifecycle manager (#2310):
 * inheritance at creation, one-record writes, and the scoop rule (copy once,
 * never retarget).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ScoopLifecycleDeps,
  ScoopLifecycleManager,
} from '../../src/scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { modelFor } from '../../src/work-unit/record.js';

const updateModel = vi.fn();

vi.mock('../../src/scoops/scoop-context.js', () => ({
  ScoopContext: class {
    async init(): Promise<void> {}
    updateModel(): void {
      updateModel();
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
    isCone: true,
    type: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
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

  it('never retargets a scoop when its cone’s model changes later', async () => {
    const cone = root({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } });
    const scoops = new Map([[cone.jid, cone]]);
    const { manager } = makeManager(scoops);
    await manager.register({ ...root({ jid: 'scoop_1', folder: 'worker' }), parentJid: cone.jid });

    await manager.setModel(cone.jid, { provider: 'openai', id: 'gpt-4.1' });

    expect(modelFor(scoops.get('cone_1')!)).toEqual({ provider: 'openai', id: 'gpt-4.1' });
    // The scoop keeps the model it was created with: a picker change is not a
    // fleet-wide retarget.
    expect(modelFor(scoops.get('scoop_1')!)).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
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

  // Codex review (P2): a model that never reached disk is not a per-cone
  // choice — it would revert on reload while the panel showed it as applied.
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
    // The live agent is put back too, not left running the model that failed
    // to persist.
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
