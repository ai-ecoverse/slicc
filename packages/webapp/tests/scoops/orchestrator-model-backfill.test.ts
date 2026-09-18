import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GELATIERE_OWNER_JID } from '../../src/base/gelatiere-constants.js';
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

  it('repairs a stale persisted Gelatiere from the leading cone on boot', async () => {
    await saveScoop(record({ model: { provider: 'adobe', id: 'claude-opus-4-8' } }));
    await saveScoop(
      record({
        jid: 'scoop_gelatiere',
        name: 'gelatiere',
        folder: 'gelatiere',
        parentJid: GELATIERE_OWNER_JID,
        model: { provider: 'stale-provider', id: 'stale-model' },
      })
    );

    const o = await boot();

    expect(o.getScoop('scoop_gelatiere')?.model).toEqual({
      provider: 'adobe',
      id: 'claude-opus-4-8',
    });
    expect((await getAllScoops()).scoop_gelatiere.model).toEqual({
      provider: 'adobe',
      id: 'claude-opus-4-8',
    });
  });

  it('follows a promoted root when that ownership change makes it the leader', async () => {
    await saveScoop(
      record({
        jid: 'cone_existing',
        folder: 'cone-research',
        addedAt: '2026-08-01T00:00:00.000Z',
        model: { provider: 'openai', id: 'gpt-5' },
      })
    );
    await saveScoop(
      record({
        jid: 'scoop_old',
        name: 'old worker',
        folder: 'old-worker',
        parentJid: 'cone_existing',
        addedAt: '2026-07-01T00:00:00.000Z',
        model: { provider: 'adobe', id: 'claude-opus-4-8' },
      })
    );
    await saveScoop(
      record({
        jid: 'scoop_gelatiere',
        name: 'gelatiere',
        folder: 'gelatiere',
        parentJid: GELATIERE_OWNER_JID,
        model: { provider: 'openai', id: 'gpt-5' },
      })
    );
    const o = await boot();
    const promoted = o.getScoop('scoop_old')!;

    promoted.parentJid = null;
    await o.persistScoop(promoted);

    expect(o.getScoop('scoop_gelatiere')?.model).toEqual({
      provider: 'adobe',
      id: 'claude-opus-4-8',
    });
    expect((await getAllScoops()).scoop_gelatiere.model).toEqual({
      provider: 'adobe',
      id: 'claude-opus-4-8',
    });
  });

  it('writes nothing when no global selection is resolvable yet, and retries next boot', async () => {
    seed.mockReturnValue(undefined);
    await saveScoop(record({}));

    const o = await boot();

    expect(o.getScoop('cone_1')?.model).toBeUndefined();
    expect((await getAllScoops()).cone_1.model).toBeUndefined();
  });

  it('keeps boot available when Gelatiere repair cannot persist', async () => {
    await saveScoop(record({ model: { provider: 'adobe', id: 'claude-opus-4-8' } }));
    await saveScoop(
      record({
        jid: 'scoop_gelatiere',
        name: 'gelatiere',
        folder: 'gelatiere',
        parentJid: GELATIERE_OWNER_JID,
        model: { provider: 'stale-provider', id: 'stale-model' },
      })
    );
    const db = await import('../../src/scoops/db.js');
    const realSave = db.saveScoop.bind(db);
    const saveSpy = vi.spyOn(db, 'saveScoop').mockImplementation(async (scoop, ...rest) => {
      if (scoop.jid === 'scoop_gelatiere') throw new Error('quota exceeded');
      return realSave(scoop, ...rest);
    });

    try {
      const o = await boot();
      expect(o.getScoop('cone_1')?.model).toEqual({
        provider: 'adobe',
        id: 'claude-opus-4-8',
      });

      expect(o.getScoop('scoop_gelatiere')?.model).toEqual({
        provider: 'stale-provider',
        id: 'stale-model',
      });
    } finally {
      saveSpy.mockRestore();
    }
  });
});
