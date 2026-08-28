/**
 * Pins the onboarding-orchestrator factory's catalogue builder and the
 * lazy handle so the boy-scout `OnboardingFinalLickPayload` rename stays
 * behaviour-preserving.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildOnboardingProviderCatalogue,
  createOnboardingOrchestratorSetup,
  narrowOnboardingFinalLickPayload,
  type OnboardingProviderHelpers,
} from '../../../src/ui/boot/setup-onboarding-orchestrator.js';

function makeProviders(
  overrides: Partial<OnboardingProviderHelpers> = {}
): OnboardingProviderHelpers {
  return {
    getAvailableProviders: () => ['anthropic', 'openai'],
    providerOffersLlmModels: () => true,
    getProviderConfig: (id) => ({
      id,
      name: id === 'anthropic' ? 'Anthropic' : 'OpenAI',
      description: `${id} models`,
      requiresApiKey: true,
    }),
    getProviderModels: (id) =>
      id === 'anthropic'
        ? [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'hidden-model', name: 'Hidden' },
          ]
        : [{ id: 'gpt-4o', name: 'GPT-4o' }],
    isModelHiddenFromPicker: (id) => id === 'hidden-model',
    addAccount: () => {},
    setSelectedModelId: () => {},
    ...overrides,
  };
}

describe('buildOnboardingProviderCatalogue', () => {
  it('filters non-LLM providers, sorts by name, and hides picker-hidden models', () => {
    const catalogue = buildOnboardingProviderCatalogue(
      makeProviders({
        getAvailableProviders: () => ['openai', 'anthropic', 'github'],
        providerOffersLlmModels: (id) => id !== 'github',
      })
    );

    expect(catalogue.providers.map((p) => p.id)).toEqual(['anthropic', 'openai']);
    expect(catalogue.models.anthropic).toEqual([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    ]);
    expect(catalogue.models.openai).toEqual([{ id: 'gpt-4o', name: 'GPT-4o' }]);
    expect(catalogue.models.github).toBeUndefined();
  });

  it('returns an empty model list when getProviderModels throws', () => {
    const catalogue = buildOnboardingProviderCatalogue(
      makeProviders({
        getAvailableProviders: () => ['broken'],
        getProviderConfig: () => ({ id: 'broken', name: 'Broken' }),
        getProviderModels: () => {
          throw new Error('boom');
        },
      })
    );

    expect(catalogue.models.broken).toEqual([]);
  });
});

describe('narrowOnboardingFinalLickPayload', () => {
  it('types known fields and drops non-string action/provider values', () => {
    const narrowed = narrowOnboardingFinalLickPayload({
      action: 'onboarding-complete-with-provider',
      extra: true,
      data: {
        profile: { name: 'Ada' },
        provider: 'anthropic',
        providerName: 'Anthropic',
        model: 'claude-opus-4-6',
        modelLabel: 'Claude Opus 4.6',
        validation: 'ok',
        leftover: 1,
      },
    });

    expect(narrowed.action).toBe('onboarding-complete-with-provider');
    expect(narrowed.extra).toBe(true);
    expect(narrowed.data).toEqual({
      profile: { name: 'Ada' },
      provider: 'anthropic',
      providerName: 'Anthropic',
      model: 'claude-opus-4-6',
      modelLabel: 'Claude Opus 4.6',
      validation: 'ok',
      leftover: 1,
    });
  });

  it('clears malformed action and nested scalar fields', () => {
    const narrowed = narrowOnboardingFinalLickPayload({
      action: 42,
      data: {
        provider: 7,
        model: false,
        validation: null,
      },
    });

    expect(narrowed.action).toBeUndefined();
    expect(narrowed.data?.provider).toBeUndefined();
    expect(narrowed.data?.model).toBeUndefined();
    expect(narrowed.data?.validation).toBeUndefined();
  });
});

describe('createOnboardingOrchestratorSetup', () => {
  it('lazily constructs a cached orchestrator and exposes the catalogue', async () => {
    const onFireFinalLick = vi.fn();
    const handle = await createOnboardingOrchestratorSetup({
      fs: {} as never,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      providers: makeProviders(),
      deviceCode: {
        createSprinkleDeviceCodePrompter: () =>
          ({
            present: vi.fn(),
            waitForDecision: vi.fn(),
          }) as never,
      },
      postSystemMessage: () => {},
      postDipReference: () => {},
      broadcastToDip: () => {},
      onFireFinalLick,
    });

    expect(handle.peek()).toBeNull();
    const first = handle.get();
    expect(handle.peek()).toBe(first);
    expect(handle.get()).toBe(first);
    expect(handle.buildCatalogue().providers.map((p) => p.id)).toEqual(['anthropic', 'openai']);
    expect(onFireFinalLick).not.toHaveBeenCalled();
  });
});
