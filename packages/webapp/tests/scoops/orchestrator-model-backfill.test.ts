/**
 * Restore-time model backfill (#2310): records saved before per-cone model
 * selection get one, written back, following the same inheritance rule
 * creation follows — a root from the global seed, a scoop from its owner.
 */

import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteScoop, getAllScoops, initDB, saveScoop } from '../../src/scoops/db.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const seed = vi.fn(
  () =>
    ({ provider: 'seed-provider', id: 'seed-model' }) as
      | { provider: string; id: string }
      | undefined
);

vi.mock('../../src/scoops/model-seed.js', () => ({
  globalSeedModel: () => seed(),
}));

function record(overrides: Partial<RegisteredScoop>): RegisteredScoop {
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

describe('Orchestrator model backfill on restore (#2310)', () => {
  let orch: Orchestrator | undefined;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = priorWindow;
    }
  });

  beforeEach(async () => {
    seed.mockReturnValue({ provider: 'seed-provider', id: 'seed-model' });
    await initDB();
    for (const jid of Object.keys(await getAllScoops())) await deleteScoop(jid);
  });

  afterEach(async () => {
    const sharedFs = orch?.getSharedFS();
    await orch?.shutdown();
    await sharedFs?.dispose();
    orch = undefined;
  });

  async function boot(): Promise<Orchestrator> {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getBrowserAPI: vi.fn(() => ({}) as any),
    } as never);
    await orch.init();
    return orch;
  }

  it('seeds a root from the global selection and its scoop from the root', async () => {
    await saveScoop(record({}));
    await saveScoop(
      record({
        jid: 'scoop_1',
        name: 'worker',
        folder: 'worker',
        parentJid: 'cone_1',
      })
    );

    const o = await boot();

    expect(o.getScoop('cone_1')?.model).toEqual({ provider: 'seed-provider', id: 'seed-model' });
    expect(o.getScoop('scoop_1')?.model).toEqual({ provider: 'seed-provider', id: 'seed-model' });
    // Written back: a model that only lived in memory would look like a
    // per-cone choice that never stuck.
    const persisted = await getAllScoops();
    expect(persisted.cone_1.model).toEqual({ provider: 'seed-provider', id: 'seed-model' });
    expect(persisted.scoop_1.model).toEqual({ provider: 'seed-provider', id: 'seed-model' });
  });

  it('migrates a legacy config pin instead of overwriting it with the seed', async () => {
    await saveScoop(
      record({
        jid: 'cone_pinned',
        config: { modelId: 'claude-opus-4-6', modelProviderId: 'adobe' },
      })
    );

    const o = await boot();

    expect(o.getScoop('cone_pinned')?.model).toEqual({ provider: 'adobe', id: 'claude-opus-4-6' });
    expect(o.getScoop('cone_pinned')?.config?.modelId).toBeUndefined();
  });

  it('gives a scoop its owning cone’s model, not the global seed', async () => {
    await saveScoop(record({ model: { provider: 'anthropic', id: 'claude-opus-4-6' } }));
    await saveScoop(
      record({
        jid: 'scoop_1',
        name: 'worker',
        folder: 'worker',
        parentJid: 'cone_1',
      })
    );

    const o = await boot();

    expect(o.getScoop('scoop_1')?.model).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
  });

  it('writes nothing when no global selection is resolvable yet, and retries next boot', async () => {
    seed.mockReturnValue(undefined);
    await saveScoop(record({}));

    const o = await boot();

    expect(o.getScoop('cone_1')?.model).toBeUndefined();
    expect((await getAllScoops()).cone_1.model).toBeUndefined();
  });
});
