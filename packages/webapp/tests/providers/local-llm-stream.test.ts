/**
 * Verifies the local-llm provider's stream registration and api-rewrite
 * delegation. This is the riskiest part of the design: pi-ai's api-registry
 * wraps every registered stream with a strict `model.api === api` check.
 * If the rewrite from `local-llm-openai` to `openai-completions` is wrong,
 * dispatching a chat completes silently or throws "Mismatched api".
 *
 * These tests stub @mariozechner/pi-ai/openai-completions so we can observe
 * what the local-llm handler passes downstream without making real fetches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub provider-settings so the local-llm module can import it
// without dragging in the full storage layer.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

const { mockStreamOpenAICompletions, mockStreamSimple } = vi.hoisted(() => ({
  mockStreamOpenAICompletions: vi.fn(),
  mockStreamSimple: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai/openai-completions', () => ({
  streamOpenAICompletions: mockStreamOpenAICompletions,
  streamSimpleOpenAICompletions: mockStreamSimple,
}));

import { register } from '../../src/providers/built-in/local-llm.js';
import { getApiProvider, clearApiProviders } from '@mariozechner/pi-ai';
import type { Api, Model } from '@mariozechner/pi-ai';

const LOCAL_LLM_API = 'local-llm-openai' as Api;

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'llama3.1:8b',
    name: 'llama3.1:8b',
    provider: 'local-llm',
    api: LOCAL_LLM_API,
    baseUrl: 'http://localhost:11434/v1',
    contextWindow: 32_000,
    maxTokens: 4_096,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as Model<Api>;
}

describe('local-llm api registration and delegation', () => {
  beforeEach(() => {
    clearApiProviders();
    vi.clearAllMocks();
    // Re-register builtins-equivalent: only what local-llm needs.
    register();
  });

  it('register() places a stream provider under "local-llm-openai"', () => {
    expect(getApiProvider(LOCAL_LLM_API)).toBeDefined();
  });

  it('dispatching with model.api="local-llm-openai" reaches our handler (no api mismatch throw)', () => {
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel();
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    // streamSimple is what pi-agent-core actually invokes.
    expect(() => provider.streamSimple(model, ctx, { apiKey: 'k' })).not.toThrow();
  });

  it('streamSimple delegates to pi-ai with model.api rewritten to "openai-completions"', () => {
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel();
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    provider.streamSimple(model, ctx, { apiKey: 'k' });

    expect(mockStreamSimple).toHaveBeenCalledTimes(1);
    const [forwardedModel, forwardedCtx, forwardedOpts] = mockStreamSimple.mock.calls[0];
    expect(forwardedModel.api).toBe('openai-completions');
    // Other fields preserved.
    expect(forwardedModel.id).toBe('llama3.1:8b');
    expect(forwardedModel.baseUrl).toBe('http://localhost:11434/v1');
    expect(forwardedCtx).toBe(ctx);
    expect(forwardedOpts.apiKey).toBe('k');
  });

  it('stream() also rewrites api before delegating', () => {
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel();
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    provider.stream(model, ctx, { apiKey: 'k' });

    expect(mockStreamOpenAICompletions).toHaveBeenCalledTimes(1);
    expect(mockStreamOpenAICompletions.mock.calls[0][0].api).toBe('openai-completions');
  });

  it('injects the placeholder apiKey when caller supplies an empty one', () => {
    // Local servers don't validate the key but pi-ai requires it non-empty.
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel();
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    provider.streamSimple(model, ctx, {});

    const forwardedOpts = mockStreamSimple.mock.calls[0][2];
    expect(forwardedOpts.apiKey).toBe('local');
  });

  it('preserves a user-supplied apiKey instead of clobbering with the placeholder', () => {
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel();
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    provider.streamSimple(model, ctx, { apiKey: 'real-token' });

    const forwardedOpts = mockStreamSimple.mock.calls[0][2];
    expect(forwardedOpts.apiKey).toBe('real-token');
  });

  it('returns an error stream (does NOT delegate) when baseUrl is missing', async () => {
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel({ baseUrl: '' });
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    const stream = provider.streamSimple(model, ctx, { apiKey: 'k' });

    expect(mockStreamSimple).not.toHaveBeenCalled();
    // Drain the stream and find the error event.
    const events: Array<{ type: string }> = [];
    for await (const event of stream) events.push(event);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('returns an error stream when the unconfigured-placeholder model id leaks through', async () => {
    const provider = getApiProvider(LOCAL_LLM_API)!;
    const model = makeModel({ id: 'local-llm-unconfigured' });
    const ctx = { systemPrompt: '', messages: [], tools: [] };
    const stream = provider.streamSimple(model, ctx, { apiKey: 'k' });

    expect(mockStreamSimple).not.toHaveBeenCalled();
    const events: Array<{ type: string }> = [];
    for await (const event of stream) events.push(event);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
