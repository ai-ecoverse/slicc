/**
 * The first-boot seed (#2310) must name a provider the user actually has an
 * account for. The cone is bootstrapped before anyone has added one, and a
 * record model beats the global selection — so stamping the built-in default
 * would pin the primary cone to a provider that may never be configured.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  provider: 'anthropic',
  apiKeys: {} as Record<string, string | null>,
  currentModel: { id: 'claude-fable-5' } as { id: string },
  throws: false,
};

vi.mock('../../src/providers/account-store.js', () => ({
  getSelectedProvider: () => {
    if (state.throws) throw new Error('no storage');
    return state.provider;
  },
  getApiKeyForProvider: (providerId: string) => state.apiKeys[providerId] ?? null,
  resolveCurrentModel: () => state.currentModel,
}));

const { globalSeedModel } = await import('../../src/scoops/model-seed.js');

describe('globalSeedModel (#2310)', () => {
  beforeEach(() => {
    state.provider = 'anthropic';
    state.apiKeys = {};
    state.currentModel = { id: 'claude-fable-5' };
    state.throws = false;
  });

  it('seeds nothing on a fresh profile with no account', () => {
    // The default selection points at Anthropic before the user adds
    // anything; stamping it strands a user who then adds only Bedrock.
    expect(globalSeedModel()).toBeUndefined();
  });

  it('seeds the selected provider once it has an account', () => {
    state.provider = 'bedrock-camp';
    state.apiKeys['bedrock-camp'] = 'aws-token';
    state.currentModel = { id: 'us.anthropic.claude-sonnet-4-6' };

    expect(globalSeedModel()).toEqual({
      provider: 'bedrock-camp',
      id: 'us.anthropic.claude-sonnet-4-6',
    });
  });

  it('seeds nothing when a DIFFERENT provider is the one with an account', () => {
    state.provider = 'anthropic';
    state.apiKeys['bedrock-camp'] = 'aws-token';

    expect(globalSeedModel()).toBeUndefined();
  });

  it('seeds nothing when there is no storage at all', () => {
    state.throws = true;
    expect(globalSeedModel()).toBeUndefined();
  });
});
