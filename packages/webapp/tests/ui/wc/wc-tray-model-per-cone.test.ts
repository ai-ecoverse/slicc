// @vitest-environment jsdom

/**
 * Leader-side per-cone model selection over the tray (#2310): a follower
 * changes the model of the cone IT is looking at, and the leader's own
 * selection is untouched.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { createLeaderOptionsFactory } from '../../../src/ui/wc/wc-tray.js';

vi.mock('../../../src/ui/provider-settings.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/ui/provider-settings.js'
  );
  return {
    ...actual,
    getAllAvailableModels: () => [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true },
        ],
      },
    ],
    resolveCurrentModel: () => ({ id: 'claude-sonnet-4-6', provider: 'anthropic' }),
  };
});

function cone(jid: string, folder: string, model?: RegisteredScoop['model']): RegisteredScoop {
  return {
    jid,
    name: folder,
    folder,
    isCone: true,
    type: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: folder,
    addedAt: '2026-08-22T00:00:00.000Z',
    ...(model ? { model } : {}),
  };
}

function makeOptions(scoops: RegisteredScoop[], selectedJid: string, applied = true) {
  const setScoopModel = vi.fn().mockResolvedValue(applied);
  const composerMeta = document.createElement('div') as HTMLElement & { model?: string };
  const modelChanges: string[] = [];
  composerMeta.addEventListener('model-change', (event) => {
    modelChanges.push((event as CustomEvent<{ id: string }>).detail.id);
  });
  const deps = {
    refs: { composerMeta, switcher: { scoops: [] }, floatbar: document.createElement('div') },
    client: {
      getScoops: () => scoops,
      getScoop: (jid: string) => scoops.find((s) => s.jid === jid),
      setScoopModel,
    },
    window,
    getSelectedJid: () => selectedJid,
    sprinkleManager: { opened: () => [], available: () => [] },
  } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
  const state = {
    leader: null,
    follower: null,
    persistenceGuard: { activate: vi.fn(), deactivate: vi.fn() },
    lockRelease: null,
  } as unknown as Parameters<typeof createLeaderOptionsFactory>[1];
  const options = createLeaderOptionsFactory(
    deps,
    state,
    {} as Parameters<typeof createLeaderOptionsFactory>[2]
  )('https://tray.example');
  return { options, setScoopModel, modelChanges, composerMeta };
}

describe('follower model selection is per cone (#2310)', () => {
  const coneA = cone('cone_1', 'cone', { provider: 'anthropic', id: 'claude-sonnet-4-6' });
  const coneB = cone('cone_2', 'cone-research', {
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
  });

  it('changes cone B while cone A is selected on the leader, and only cone B', async () => {
    const { options, setScoopModel, modelChanges, composerMeta } = makeOptions(
      [coneA, coneB],
      coneA.jid
    );

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', coneB.jid)
    ).resolves.toBe(true);

    expect(setScoopModel).toHaveBeenCalledTimes(1);
    expect(setScoopModel).toHaveBeenCalledWith(coneB.jid, {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
    // The leader is on cone A: its pill and picker must not move.
    expect(modelChanges).toEqual([]);
    expect(composerMeta.model).toBeUndefined();
  });

  it('reflects the pick locally when the follower is on the cone the leader has selected', async () => {
    const { options, setScoopModel, modelChanges, composerMeta } = makeOptions(
      [coneA, coneB],
      coneA.jid
    );

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', coneA.jid)
    ).resolves.toBe(true);

    expect(setScoopModel).toHaveBeenCalledWith(coneA.jid, {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
    expect(modelChanges).toEqual(['anthropic:claude-opus-4-6']);
    expect(composerMeta.getAttribute('model')).toBe('Claude Opus 4.6');
  });

  it('applies a pick made while viewing a scoop to the cone that owns it', async () => {
    const scoop: RegisteredScoop = {
      ...cone('scoop_1', 'worker'),
      isCone: false,
      type: 'scoop',
      parentJid: coneB.jid,
    };
    const { options, setScoopModel } = makeOptions([coneA, coneB, scoop], coneA.jid);

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', scoop.jid)
    ).resolves.toBe(true);

    expect(setScoopModel).toHaveBeenCalledWith(coneB.jid, {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
  });

  it('resolves false and leaves the pill alone when the write does not persist', async () => {
    const { options, modelChanges, composerMeta } = makeOptions([coneA, coneB], coneA.jid, false);

    await expect(
      options.onFollowerModelSelect?.('anthropic:claude-opus-4-6', coneA.jid)
    ).resolves.toBe(false);

    expect(modelChanges).toEqual([]);
    expect(composerMeta.getAttribute('model')).toBeNull();
  });

  it('rejects a model id that is not in the advertised catalogue', () => {
    const { options, setScoopModel } = makeOptions([coneA, coneB], coneA.jid);
    expect(options.onFollowerModelSelect?.('evil:secret-model', coneB.jid)).toBe(false);
    expect(setScoopModel).not.toHaveBeenCalled();
  });

  it('reports each cone’s own model in the state a follower renders', () => {
    const { options } = makeOptions([coneA, coneB], coneA.jid);
    const opusCone = cone('cone_3', 'cone-writing', {
      provider: 'anthropic',
      id: 'claude-opus-4-6',
    });
    const withOpus = makeOptions([coneA, opusCone], coneA.jid);

    expect(options.getModelSelectionState?.(coneB.jid).activeModelId).toBe(
      'anthropic:claude-sonnet-4-6'
    );
    expect(withOpus.options.getModelSelectionState?.(opusCone.jid).activeModelId).toBe(
      'anthropic:claude-opus-4-6'
    );
  });
});
