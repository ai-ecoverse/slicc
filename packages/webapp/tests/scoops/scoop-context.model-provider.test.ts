/**
 * Regression coverage for issue #2195 — a scoop spawned with a model from a
 * NON-selected provider must actually run on that provider.
 *
 * `resolveModelById(id)` resolves against the SELECTED provider and degrades
 * to the cone's own model for an id that provider doesn't offer, so storing a
 * cross-provider model id alone would silently run the scoop on the selected
 * provider's (typically far more expensive) model. `ScoopConfig.modelProviderId`
 * pins it: it is passed back into `resolveModelById(id, providerId)`, and a
 * mismatch fails init instead of quietly swapping the model.
 *
 * The assertions are on the model handed to the Agent — the provider actually
 * used — not merely on the configured id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../src/scoops/types.js';

type AgentCtorOptions = {
  initialState?: { model?: { id?: string; provider?: string } };
  getApiKey?: () => string | undefined;
};

const captures = vi.hoisted(() => ({
  agentCtorCalls: [] as AgentCtorOptions[],
}));

/** Two configured providers, mirroring the issue's adobe + openrouter setup. */
const CATALOGUES: Record<string, string[]> = {
  adobe: ['claude-opus-5', 'claude-haiku-4-5'],
  openrouter: ['openai/gpt-5.6-terra-pro'],
  // Azure proxies Anthropic's catalogue unchanged, so its models report
  // `provider: 'anthropic'` — the alias case the init guard must tolerate.
  'azure-ai-foundry': ['claude-sonnet-4-6'],
};
const PROVIDER_OF_MODEL: Record<string, string> = { 'azure-ai-foundry': 'anthropic' };
const API_KEYS: Record<string, string> = {
  adobe: 'adobe-token',
  openrouter: 'sk-or-key',
  'azure-ai-foundry': 'azure-key',
};
const SELECTED_PROVIDER = 'adobe';

vi.mock('../../src/core/feature-flags.js', () => ({
  isFeatureEnabled: () => false,
}));

vi.mock('../../src/core/index.js', () => {
  class MockAgent {
    constructor(options: AgentCtorOptions) {
      captures.agentCtorCalls.push(options);
    }
    subscribe = vi.fn(() => () => {});
    abort = vi.fn();
  }
  return {
    Agent: MockAgent,
    adaptTools: (tools: unknown[]) => tools,
    createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
  };
});

vi.mock('../../src/core/context-compaction.js', () => ({
  createCompactContext: () => async (messages: unknown[]) => messages,
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  isContextOverflow: () => false,
  streamSimple: () => ({ result: () => Promise.resolve(null) }),
  getSupportedThinkingLevels: () => ['off'],
}));

vi.mock('../../src/tools/index.js', () => ({
  createFileTools: () => [],
  createBashTool: () => ({ name: 'bash' }),
}));

vi.mock('../../src/shell/almost-bash-shell-headless.js', () => ({
  AlmostBashShellHeadless: vi.fn(function () {
    return {};
  }),
}));

vi.mock('../../src/providers/account-store.js', () => ({
  getApiKey: () => API_KEYS[SELECTED_PROVIDER],
  getApiKeyForProvider: (providerId: string) => API_KEYS[providerId] ?? null,
  modelRunsOnProvider: (model: { provider?: string }, providerId: string) =>
    model.provider === providerId || model.provider === PROVIDER_OF_MODEL[providerId],
  getSelectedProvider: () => SELECTED_PROVIDER,
  resolveCurrentModel: () => ({ id: 'claude-opus-5', provider: SELECTED_PROVIDER }),
  // Structural stand-in for the real resolver: a pinned provider that cannot
  // serve the id throws; an UNPINNED id the selected provider doesn't offer
  // degrades to the selected model (the behavior the pin exists to prevent).
  resolveModelById: (modelId?: string, providerId?: string) => {
    if (!modelId) return { id: 'claude-opus-5', provider: SELECTED_PROVIDER };
    if (providerId !== undefined) {
      if (!CATALOGUES[providerId]?.includes(modelId)) {
        throw new Error(`Model ${modelId} is not available from provider ${providerId}`);
      }
      return { id: modelId, provider: PROVIDER_OF_MODEL[providerId] ?? providerId };
    }
    if (CATALOGUES[SELECTED_PROVIDER].includes(modelId)) {
      return { id: modelId, provider: SELECTED_PROVIDER };
    }
    return { id: 'claude-opus-5', provider: SELECTED_PROVIDER };
  },
  resolveModelSelectionForScoop: (id: string) => ({
    ok: true,
    selection: { modelId: id, providerId: SELECTED_PROVIDER },
  }),
}));

vi.mock('../../src/scoops/skills.js', () => ({
  createDefaultSkills: async () => {},
  loadSkills: async () => [],
  formatSkillsForPrompt: () => '',
}));

vi.mock('../../src/scoops/scoop-management-tools.js', () => ({
  createScoopManagementTools: () => [],
}));

vi.mock('../../src/core/secret-env.js', () => ({
  fetchSecretEnvVars: async () => ({}),
  buildEnvFromMaskedEntries: () => ({}),
}));

const { ScoopContext } = await import('../../src/scoops/scoop-context.js');

function makeScoop(
  config: RegisteredScoop['config'],
  model?: RegisteredScoop['model']
): RegisteredScoop {
  return {
    jid: 'agent_jolly_mint',
    name: 'jolly-mint',
    folder: 'agent-jolly-mint',
    parentJid: 'cone',
    requiresTrigger: false,
    assistantLabel: 'agent-jolly-mint',
    addedAt: new Date().toISOString(),
    config,
    ...(model ? { model } : {}),
  };
}

function createMockCallbacks() {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({})),
  };
}

function createMockFs() {
  const files = new Map<string, string>();
  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path)!;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
  };
}

async function initWith(config: RegisteredScoop['config'], model?: RegisteredScoop['model']) {
  const callbacks = createMockCallbacks();
  const ctx = new ScoopContext(
    makeScoop(config, model),
    callbacks as never,
    createMockFs() as never
  );
  await ctx.init();
  const call = captures.agentCtorCalls[0];
  return {
    callbacks,
    ctx,
    model: call?.initialState?.model,
    apiKey: call?.getApiKey?.(),
  };
}

describe('ScoopContext model provider pinning (#2195)', () => {
  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
  });

  it('runs a cross-provider model on ITS provider, not the selected one', async () => {
    const { callbacks, model } = await initWith({
      modelId: 'openai/gpt-5.6-terra-pro',
      modelProviderId: 'openrouter',
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(model?.id).toBe('openai/gpt-5.6-terra-pro');
    expect(model?.provider).toBe('openrouter');
  });

  // The cost guard: without the pin the same config resolves to the SELECTED
  // provider's Opus — silently, at many times the intended price.
  it('would degrade to the selected provider without the pin (documents the bug)', async () => {
    const { model } = await initWith({ modelId: 'openai/gpt-5.6-terra-pro' });

    expect(model?.provider).toBe(SELECTED_PROVIDER);
    expect(model?.id).toBe('claude-opus-5');
  });

  it('fails init rather than running a pinned model the provider cannot serve', async () => {
    const { callbacks } = await initWith({
      modelId: 'claude-haiku-4-5',
      modelProviderId: 'openrouter',
    });

    expect(captures.agentCtorCalls).toHaveLength(0);
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize'));
  });

  // Codex review (P1): the agent must authenticate with the PINNED provider's
  // credential. `getApiKey()` returns the selected provider's key, which would
  // send the Adobe token to OpenRouter — an auth failure that also leaks one
  // provider's credential to another.
  it("authenticates with the pinned provider's API key, not the selected one", async () => {
    const { apiKey } = await initWith({
      modelId: 'openai/gpt-5.6-terra-pro',
      modelProviderId: 'openrouter',
    });

    expect(apiKey).toBe('sk-or-key');
    expect(apiKey).not.toBe('adobe-token');
  });

  it('keeps using the selected provider key when nothing is pinned', async () => {
    const { apiKey } = await initWith({ modelId: 'claude-haiku-4-5' });

    expect(apiKey).toBe('adobe-token');
  });

  // Codex review (P2): azure-ai-foundry proxies Anthropic's catalogue
  // unchanged, so its models report `provider: 'anthropic'`. A raw id
  // comparison would reject every explicit Azure spawn.
  it('accepts a provider whose catalogue models carry the aliased registry provider', async () => {
    const { callbacks, model } = await initWith({
      modelId: 'claude-sonnet-4-6',
      modelProviderId: 'azure-ai-foundry',
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(model?.id).toBe('claude-sonnet-4-6');
    expect(model?.provider).toBe('anthropic');
  });

  it('still runs a pinned model from the selected provider unchanged', async () => {
    const { callbacks, model } = await initWith({
      modelId: 'claude-haiku-4-5',
      modelProviderId: SELECTED_PROVIDER,
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(model?.id).toBe('claude-haiku-4-5');
    expect(model?.provider).toBe(SELECTED_PROVIDER);
  });
});

describe('per-cone model on the record (#2310)', () => {
  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
  });

  it('runs the unit on the model its RECORD names, provider included', async () => {
    const { callbacks, model, apiKey } = await initWith(undefined, {
      provider: 'openrouter',
      id: 'openai/gpt-5.6-terra-pro',
    });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(model?.id).toBe('openai/gpt-5.6-terra-pro');
    expect(model?.provider).toBe('openrouter');
    expect(apiKey).toBe('sk-or-key');
  });

  it('surfaces the missing account instead of crashing when the provider has none', async () => {
    // Per-cone model means per-cone PROVIDER: a cone can name one this device
    // has no account for (a follower picked it, or the account was removed).
    const { callbacks, ctx } = await initWith(undefined, {
      provider: 'never-configured',
      id: 'some-model',
    });

    // Init defers rather than throwing, and no agent is constructed.
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(captures.agentCtorCalls).toHaveLength(0);

    // The next prompt reports the same "no provider" state the UI already
    // knows how to render — naming the provider the cone actually wants.
    await (ctx as unknown as { ensureAgentReady(): Promise<boolean> }).ensureAgentReady();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining('No API key configured for provider "never-configured"')
    );
  });

  it('prefers the record over a stale legacy config pin', async () => {
    const { model } = await initWith(
      { modelId: 'claude-haiku-4-5', modelProviderId: 'adobe' },
      { provider: 'openrouter', id: 'openai/gpt-5.6-terra-pro' }
    );

    expect(model?.id).toBe('openai/gpt-5.6-terra-pro');
    expect(model?.provider).toBe('openrouter');
  });
});
