import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Api, Model } from '@mariozechner/pi-ai';

const completeSimple = vi.fn();

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: (...args: unknown[]) => completeSimple(...args),
}));

const providerSettings = {
  apiKey: 'sk-test',
  providerId: 'anthropic',
  modelId: 'claude-opus-4-7',
  models: [] as Model<Api>[],
};

vi.mock('../../src/ui/provider-settings.js', () => ({
  getApiKey: () => providerSettings.apiKey,
  getSelectedProvider: () => providerSettings.providerId,
  getSelectedModelId: () => providerSettings.modelId,
  getProviderModels: () => providerSettings.models,
}));

import { quickLabel, __test__ } from '../../src/ui/quick-llm.js';

function makeModel(
  id: string,
  cost: number,
  provider: string = 'anthropic',
  reasoning = false
): Model<Api> {
  return {
    id,
    name: id,
    api: 'anthropic-messages' as Api,
    provider,
    baseUrl: '',
    reasoning,
    input: ['text'],
    cost: { input: cost, output: cost * 5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } as unknown as Model<Api>;
}

function assistantTextMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
}

beforeEach(() => {
  completeSimple.mockReset();
  __test__.resetAdobeSession();
  providerSettings.apiKey = 'sk-test';
  providerSettings.providerId = 'anthropic';
  providerSettings.modelId = 'claude-opus-4-7';
  providerSettings.models = [];
});

describe('quickLabel', () => {
  it('returns null when no API key is configured', async () => {
    providerSettings.apiKey = '';
    const result = await quickLabel({ prompt: 'hi' });
    expect(result).toBeNull();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it('returns null when provider has no models', async () => {
    providerSettings.models = [];
    expect(await quickLabel({ prompt: 'hi' })).toBeNull();
  });

  it('returns null when LLM call throws', async () => {
    providerSettings.models = [makeModel('claude-opus-4-7', 15)];
    completeSimple.mockRejectedValue(new Error('network down'));
    expect(await quickLabel({ prompt: 'hi' })).toBeNull();
  });

  it('returns trimmed assistant text on success', async () => {
    providerSettings.models = [makeModel('claude-opus-4-7', 15)];
    completeSimple.mockResolvedValue(assistantTextMessage('  Comparing files in drafts.  '));
    expect(await quickLabel({ prompt: 'summarize' })).toBe('Comparing files in drafts.');
  });

  it('prefers haiku over opus in the Claude family', async () => {
    providerSettings.models = [
      makeModel('claude-opus-4-7', 15),
      makeModel('claude-sonnet-4-6', 3),
      makeModel('claude-haiku-4-5', 1),
    ];
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi' });

    const [model] = completeSimple.mock.calls[0];
    expect((model as Model<Api>).id).toBe('claude-haiku-4-5');
  });

  it('prefers gpt-mini over gpt for the GPT family', async () => {
    providerSettings.providerId = 'openai';
    providerSettings.modelId = 'gpt-5';
    providerSettings.models = [
      makeModel('gpt-5', 10, 'openai'),
      makeModel('gpt-5-mini', 1, 'openai'),
      makeModel('gpt-5-nano', 0.5, 'openai'),
    ];
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi' });

    const [model] = completeSimple.mock.calls[0];
    expect((model as Model<Api>).id).toBe('gpt-5-nano');
  });

  it('prefers gemini-flash over gemini-pro', async () => {
    providerSettings.providerId = 'google';
    providerSettings.modelId = 'gemini-2.5-pro';
    providerSettings.models = [
      makeModel('gemini-2.5-pro', 5, 'google'),
      makeModel('gemini-2.5-flash', 0.3, 'google'),
    ];
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi' });

    const [model] = completeSimple.mock.calls[0];
    expect((model as Model<Api>).id).toBe('gemini-2.5-flash');
  });

  it('falls back to active model when no cheaper sibling exists', async () => {
    providerSettings.models = [makeModel('claude-haiku-4-5', 1)];
    providerSettings.modelId = 'claude-haiku-4-5';
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi' });

    const [model] = completeSimple.mock.calls[0];
    expect((model as Model<Api>).id).toBe('claude-haiku-4-5');
  });

  it('honors an explicit modelId override', async () => {
    providerSettings.models = [makeModel('claude-opus-4-7', 15), makeModel('claude-haiku-4-5', 1)];
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi', modelId: 'claude-opus-4-7' });

    const [model] = completeSimple.mock.calls[0];
    expect((model as Model<Api>).id).toBe('claude-opus-4-7');
  });

  it('attaches X-Session-Id header for adobe provider', async () => {
    providerSettings.providerId = 'adobe';
    providerSettings.modelId = 'claude-opus-4-7';
    providerSettings.models = [
      makeModel('claude-opus-4-7', 15, 'adobe'),
      makeModel('claude-haiku-4-5', 1, 'adobe'),
    ];
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi' });

    const [, , options] = completeSimple.mock.calls[0] as [
      unknown,
      unknown,
      { headers?: Record<string, string> },
    ];
    expect(options.headers?.['X-Session-Id']).toMatch(/[0-9a-f-]{36}/i);
  });

  it('does not attach X-Session-Id for non-adobe providers', async () => {
    providerSettings.models = [makeModel('claude-haiku-4-5', 1)];
    providerSettings.modelId = 'claude-haiku-4-5';
    completeSimple.mockResolvedValue(assistantTextMessage('ok'));

    await quickLabel({ prompt: 'hi' });

    const [, , options] = completeSimple.mock.calls[0] as [
      unknown,
      unknown,
      { headers?: Record<string, string> },
    ];
    expect(options.headers).toBeUndefined();
  });

  it('passes prompt as user message and forwards system prompt', async () => {
    providerSettings.models = [makeModel('claude-haiku-4-5', 1)];
    providerSettings.modelId = 'claude-haiku-4-5';
    completeSimple.mockResolvedValue(assistantTextMessage('label'));

    await quickLabel({ prompt: 'describe', system: 'be brief' });

    const [, context] = completeSimple.mock.calls[0] as [
      unknown,
      { systemPrompt?: string; messages: Array<{ role: string; content: string }> },
    ];
    expect(context.systemPrompt).toBe('be brief');
    expect(context.messages[0].role).toBe('user');
    expect(context.messages[0].content).toBe('describe');
  });
});

describe('familyOf', () => {
  it('classifies Claude, GPT, Gemini, Grok, and unknown ids', () => {
    expect(__test__.familyOf('claude-opus-4-7')).toBe('claude');
    expect(__test__.familyOf('gpt-5-mini')).toBe('gpt');
    expect(__test__.familyOf('o4-mini')).toBe('gpt');
    expect(__test__.familyOf('gemini-2.5-flash')).toBe('gemini');
    expect(__test__.familyOf('grok-4-fast')).toBe('grok');
    expect(__test__.familyOf('llama-3.1-70b')).toBe('unknown');
  });
});
