import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyModelPolicy,
  parseModelPolicy,
  setActiveModelPolicy,
} from '../../src/providers/model-policy.js';

const storage = new Map<string, string>();
const storageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    storage.set(k, v);
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => {
    storage.clear();
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: storageStub,
  configurable: true,
  writable: true,
});

const SELECTED = 'test-adobe-proxy';
const OTHER = 'test-openrouter-proxy';
const SECOND_OTHER = 'test-third-proxy';

async function registerProviders(): Promise<void> {
  const { registerProviderConfig } = await import('../../src/providers/index.js');
  registerProviderConfig({
    id: SELECTED,
    name: 'Test Adobe Proxy',
    description: 'test',
    requiresApiKey: false,
    requiresBaseUrl: false,
    isOAuth: true,
    getModelIds: () => [
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ],
  });
  registerProviderConfig({
    id: OTHER,
    name: 'Test OpenRouter Proxy',
    description: 'test',
    requiresApiKey: true,
    requiresBaseUrl: false,
    getModelIds: () => [
      { id: 'openai/gpt-5.6-terra-pro', name: 'GPT-5.6 Terra Pro', api: 'openai' },
      { id: 'shared/ambiguous-model', name: 'Shared Ambiguous', api: 'openai' },
    ],
  });
  registerProviderConfig({
    id: SECOND_OTHER,
    name: 'Test Third Proxy',
    description: 'test',
    requiresApiKey: true,
    requiresBaseUrl: false,
    getModelIds: () => [{ id: 'shared/ambiguous-model', name: 'Shared Ambiguous', api: 'openai' }],
  });
}

describe('resolveModelSelectionForScoop (two providers configured)', () => {
  beforeEach(async () => {
    storage.clear();
    await registerProviders();
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: SELECTED, apiKey: '', accessToken: 'x' },
        { providerId: OTHER, apiKey: 'sk-or-x' },
        { providerId: SECOND_OTHER, apiKey: 'sk-third-x' },
      ])
    );
    storage.set('selected-model', `${SELECTED}:claude-opus-5`);

    setActiveModelPolicy(parseModelPolicy(`[${SELECTED}]\n${OTHER}:*\n${SECOND_OTHER}:*\n`));
  });

  afterEach(async () => {
    setActiveModelPolicy(emptyModelPolicy());
    const { unregisterProviderConfig } = await import('../../src/providers/index.js');
    for (const id of [SELECTED, OTHER, SECOND_OTHER]) unregisterProviderConfig(id);
  });

  it('accepts a qualified id for the SELECTED provider (the form `models` prints)', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop(`${SELECTED}:claude-haiku-4-5`)).toEqual({
      ok: true,
      selection: { modelId: 'claude-haiku-4-5', providerId: SELECTED },
    });
  });

  it('accepts a qualified id for a NON-selected provider', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop(`${OTHER}:openai/gpt-5.6-terra-pro`)).toEqual({
      ok: true,
      selection: { modelId: 'openai/gpt-5.6-terra-pro', providerId: OTHER },
    });
  });

  it('rejects a qualified id whose provider is not configured', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop('openai:gpt-5');
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.error).toContain('is not configured');
  });

  it('rejects a qualified id the named provider does not offer', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop(`${OTHER}:claude-haiku-4-5`);
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.error).toContain('does not offer');
  });

  it('pins a bare id that only a non-selected provider offers', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop('openai/gpt-5.6-terra-pro')).toEqual({
      ok: true,
      selection: { modelId: 'openai/gpt-5.6-terra-pro', providerId: OTHER },
    });
  });

  it('fails a bare id offered by several providers, listing the qualified candidates', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop('shared/ambiguous-model');
    expect(resolution.ok).toBe(false);
    const error = resolution.ok === false ? resolution.error : '';
    expect(error).toContain('ambiguous model');
    expect(error).toContain(`${OTHER}:shared/ambiguous-model`);
    expect(error).toContain(`${SECOND_OTHER}:shared/ambiguous-model`);
  });

  it('keeps a bare id from the selected provider behaving exactly as before', async () => {
    const { resolveModelIdForScoop, resolveModelSelectionForScoop } = await import(
      '../../src/providers/account-store.js'
    );
    expect(resolveModelSelectionForScoop('claude-haiku-4-5')).toEqual({
      ok: true,
      selection: { modelId: 'claude-haiku-4-5', providerId: SELECTED },
    });
    expect(resolveModelIdForScoop('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('lets the selected provider win a shorthand both providers could match', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');

    expect(resolveModelSelectionForScoop('opus')).toEqual({
      ok: true,
      selection: { modelId: 'claude-opus-5', providerId: SELECTED },
    });
  });

  it('rejects an id no configured provider offers', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop('this-model-does-not-exist-xyz');
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.error).toContain('unknown model');
  });

  it('does not read a colon inside a model id as a provider prefix', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');

    const resolution = resolveModelSelectionForScoop('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.error).not.toContain('is not configured');
  });

  it('resolves a cross-provider selection on ITS provider, not the selected one', async () => {
    const { resolveCurrentModel, resolveModelById, resolveModelSelectionForScoop } = await import(
      '../../src/providers/account-store.js'
    );
    const resolution = resolveModelSelectionForScoop(`${OTHER}:openai/gpt-5.6-terra-pro`);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const model = resolveModelById(resolution.selection.modelId, resolution.selection.providerId);
    expect(model.id).toBe('openai/gpt-5.6-terra-pro');
    expect(model.provider).toBe(OTHER);

    expect(model.provider).not.toBe(SELECTED);
    expect(model.id).not.toBe(resolveCurrentModel().id);
  });

  it('throws rather than degrading to the selected model for a pinned id the provider lacks', async () => {
    const { resolveModelById } = await import('../../src/providers/account-store.js');
    expect(() => resolveModelById('definitely-not-a-model-xyz', OTHER)).toThrow();
  });
});

describe('modelRunsOnProvider (registry aliases)', () => {
  beforeEach(() => {
    storage.clear();
    storage.set(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'azure-ai-foundry', apiKey: 'azure-key' }])
    );
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-6');
  });

  it('accepts a model served under the provider’s registry alias', async () => {
    const { modelRunsOnProvider, resolveModelById } = await import(
      '../../src/providers/account-store.js'
    );
    const model = resolveModelById('claude-sonnet-4-6', 'azure-ai-foundry');
    expect(model.provider).toBe('anthropic');
    expect(modelRunsOnProvider(model, 'azure-ai-foundry')).toBe(true);
  });

  it('still rejects a model from an unrelated provider', async () => {
    const { modelRunsOnProvider, resolveModelById } = await import(
      '../../src/providers/account-store.js'
    );
    const model = resolveModelById('claude-sonnet-4-6', 'azure-ai-foundry');
    expect(modelRunsOnProvider(model, 'openai')).toBe(false);
  });

  it('resolves the qualified azure id without a provider mismatch', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop('azure-ai-foundry:claude-sonnet-4-6')).toEqual({
      ok: true,
      selection: { modelId: 'claude-sonnet-4-6', providerId: 'azure-ai-foundry' },
    });
  });
});

describe('resolveModelSelectionForScoop (/etc/models policy)', () => {
  beforeEach(async () => {
    storage.clear();
    await registerProviders();
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: SELECTED, apiKey: '', accessToken: 'x' },
        { providerId: OTHER, apiKey: 'sk-or-x' },
      ])
    );
    storage.set('selected-model', `${SELECTED}:claude-opus-5`);
    setActiveModelPolicy(emptyModelPolicy());
  });

  afterEach(async () => {
    setActiveModelPolicy(emptyModelPolicy());
    const { unregisterProviderConfig } = await import('../../src/providers/index.js');
    for (const id of [SELECTED, OTHER, SECOND_OTHER]) unregisterProviderConfig(id);
  });

  it('refuses a resolvable cross-provider model when no policy allows it', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop(`${OTHER}:openai/gpt-5.6-terra-pro`);
    expect(resolution.ok).toBe(false);
    const error = resolution.ok === false ? resolution.error : '';
    expect(error).toContain('model not allowed');
    expect(error).toContain('/etc/models');
  });

  it('names the exact line to add, so the fix is copy-pasteable', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop(`${OTHER}:openai/gpt-5.6-terra-pro`);
    const error = resolution.ok === false ? resolution.error : '';
    expect(error).toContain(`[${SELECTED}]`);
    expect(error).toContain(`${OTHER}:openai/gpt-5.6-terra-pro`);
  });

  it('keeps the selected provider’s own models usable with no policy at all', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop('claude-haiku-4-5')).toEqual({
      ok: true,
      selection: { modelId: 'claude-haiku-4-5', providerId: SELECTED },
    });
  });

  it('admits a cross-provider model once a wildcard entry allows it', async () => {
    setActiveModelPolicy(parseModelPolicy(`[${SELECTED}]\n${OTHER}:*\n`));
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop(`${OTHER}:openai/gpt-5.6-terra-pro`)).toEqual({
      ok: true,
      selection: { modelId: 'openai/gpt-5.6-terra-pro', providerId: OTHER },
    });
  });

  it('admits exactly the model a single-entry allow names, and no sibling', async () => {
    setActiveModelPolicy(parseModelPolicy(`[${SELECTED}]\n${OTHER}:openai/gpt-5.6-terra-pro\n`));
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop(`${OTHER}:openai/gpt-5.6-terra-pro`).ok).toBe(true);
    expect(resolveModelSelectionForScoop(`${OTHER}:shared/ambiguous-model`).ok).toBe(false);
  });

  it('refuses a denied model from the SELECTED provider too', async () => {
    setActiveModelPolicy(parseModelPolicy(`[${SELECTED}]\n-${SELECTED}:claude-haiku-4-5\n`));
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop('claude-haiku-4-5');
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.error).toContain('model not allowed');
  });

  it('does not let a blocked model make an allowed one ambiguous', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: SELECTED, apiKey: '', accessToken: 'x' },
        { providerId: OTHER, apiKey: 'sk-or-x' },
        { providerId: SECOND_OTHER, apiKey: 'sk-third-x' },
      ])
    );
    setActiveModelPolicy(parseModelPolicy(`[${SELECTED}]\n${SECOND_OTHER}:*\n`));
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelSelectionForScoop('shared/ambiguous-model')).toEqual({
      ok: true,
      selection: { modelId: 'shared/ambiguous-model', providerId: SECOND_OTHER },
    });
  });

  it('reports the policy, not "unknown model", when every bare match is blocked', async () => {
    const { resolveModelSelectionForScoop } = await import('../../src/providers/account-store.js');
    const resolution = resolveModelSelectionForScoop('openai/gpt-5.6-terra-pro');
    expect(resolution.ok).toBe(false);
    const error = resolution.ok === false ? resolution.error : '';
    expect(error).toContain('model not allowed');
    expect(error).not.toContain('unknown model');
  });

  it('hides an explicitly denied model from the picker', async () => {
    setActiveModelPolicy(parseModelPolicy(`[${SELECTED}]\n-${SELECTED}:claude-haiku-4-5\n`));
    const { getAllAvailableModels } = await import('../../src/providers/account-store.js');
    const ids = getAllAvailableModels()
      .flatMap((g) => g.models)
      .map((m) => m.id);
    expect(ids).not.toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-opus-5');
  });

  it('leaves a merely un-allowed provider visible in the picker', async () => {
    const { getAllAvailableModels } = await import('../../src/providers/account-store.js');
    const providers = getAllAvailableModels().map((g) => g.providerId);
    expect(providers).toContain(OTHER);
  });
});

describe('getAlternativeModelProviders', () => {
  beforeEach(async () => {
    storage.clear();
    await registerProviders();
    storage.set('selected-model', `${SELECTED}:claude-opus-5`);
  });

  afterEach(async () => {
    setActiveModelPolicy(emptyModelPolicy());
    const { unregisterProviderConfig } = await import('../../src/providers/index.js');
    for (const id of [SELECTED, OTHER, SECOND_OTHER]) unregisterProviderConfig(id);
  });

  it('lists the other connected providers, never the excluded one', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: SELECTED, apiKey: '', accessToken: 'x' },
        { providerId: OTHER, apiKey: 'sk-or-x' },
      ])
    );
    const { getAlternativeModelProviders } = await import('../../src/providers/account-store.js');
    expect(getAlternativeModelProviders(SELECTED)).toEqual([OTHER]);
  });

  it('is empty when the exhausted provider is the only account', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([{ providerId: SELECTED, apiKey: '', accessToken: 'x' }])
    );
    const { getAlternativeModelProviders } = await import('../../src/providers/account-store.js');
    expect(getAlternativeModelProviders(SELECTED)).toEqual([]);
  });

  it('omits a provider whose models the picker would not show either', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: SELECTED, apiKey: '', accessToken: 'x' },
        { providerId: SECOND_OTHER, apiKey: 'sk-third-x' },
      ])
    );
    setActiveModelPolicy(
      parseModelPolicy(`[${SELECTED}]\n-${SECOND_OTHER}:shared/ambiguous-model\n`)
    );
    const { getAlternativeModelProviders } = await import('../../src/providers/account-store.js');
    expect(getAlternativeModelProviders(SELECTED)).toEqual([]);
  });

  it('keeps every provider when nothing is excluded', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: SELECTED, apiKey: '', accessToken: 'x' },
        { providerId: OTHER, apiKey: 'sk-or-x' },
      ])
    );
    const { getAlternativeModelProviders } = await import('../../src/providers/account-store.js');
    expect(getAlternativeModelProviders(null)).toEqual([SELECTED, OTHER]);
  });
});
