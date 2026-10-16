import type { Api, Model } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const copilotStreamMocks = vi.hoisted(() => ({
  streamAnthropic: vi.fn(),
  streamSimpleAnthropic: vi.fn(),
  streamOpenAICompletions: vi.fn(),
  streamSimpleOpenAICompletions: vi.fn(),
  streamOpenAIResponses: vi.fn(),
  streamSimpleOpenAIResponses: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/compat')>();
  return { ...actual, ...copilotStreamMocks };
});

import {
  createAssistantMessageEventStream,
  getApiProvider,
  resetApiProviders,
} from '@earendil-works/pi-ai/compat';
import { register } from '../../providers/github-copilot.js';

const CATALOG_KEY = 'github-copilot.models.v1';

function endedStream() {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.end());
  return stream;
}

async function drain(stream: ReturnType<typeof endedStream>): Promise<void> {
  for await (const _event of stream) {
    // The mocked native stream intentionally emits no events.
  }
}

function catalogEntry(
  id: string,
  name: string,
  api: 'anthropic-messages' | 'openai-completions' | 'openai-responses'
) {
  return {
    id,
    name,
    vendor: api === 'anthropic-messages' ? 'Anthropic' : 'OpenAI',
    api,
    contextWindow: 128_000,
    maxTokens: 8192,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: true,
    policyState: 'enabled',
  };
}

describe('github-copilot temperature forwarding', () => {
  beforeEach(() => {
    const lsData: Record<string, string> = {};
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => lsData[k] ?? null,
      setItem: (k: string, v: string) => {
        lsData[k] = v;
      },
      removeItem: (k: string) => {
        delete lsData[k];
      },
      clear: () => {
        for (const k of Object.keys(lsData)) delete lsData[k];
      },
      key: () => null,
      length: 0,
    } as unknown as Storage;
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'github-copilot',
          apiKey: '',
          accessToken: 'copilot-token',
          refreshToken: 'github-token',
          tokenExpiresAt: Date.now() + 3_600_000,
        },
      ])
    );
    for (const mock of Object.values(copilotStreamMocks)) {
      mock.mockReset().mockImplementation(endedStream);
    }
    resetApiProviders();
    register();
  });

  it.each([
    [
      'stream',
      'gpt-6.1-sol',
      'GPT-6.1 Sol',
      'openai-responses',
      copilotStreamMocks.streamOpenAIResponses,
    ],
    [
      'streamSimple',
      'gpt-6.1-sol',
      'GPT-6.1 Sol',
      'openai-responses',
      copilotStreamMocks.streamSimpleOpenAIResponses,
    ],
    [
      'stream',
      'grok-4.7',
      'Grok 4.7',
      'openai-completions',
      copilotStreamMocks.streamOpenAICompletions,
    ],
    [
      'streamSimple',
      'kimi-k3',
      'Kimi K3',
      'openai-completions',
      copilotStreamMocks.streamSimpleOpenAICompletions,
    ],
    [
      'stream',
      'gpt-5.6-sol',
      'GPT-5.6 Sol',
      'openai-responses',
      copilotStreamMocks.streamOpenAIResponses,
    ],
  ] as const)('omits temperature through %s for %s', async (entry, id, name, api, native) => {
    localStorage.setItem(CATALOG_KEY, JSON.stringify([catalogEntry(id, name, api)]));
    const provider = getApiProvider('github-copilot-openai' as Api)!;
    const model = {
      id,
      name,
      api: 'github-copilot-openai',
      provider: 'github-copilot',
    } as Model<Api>;
    await drain(
      provider[entry](model, normalizeContext({ systemPrompt: '', messages: [], tools: [] }), {
        temperature: 0.3,
      })
    );

    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0][2]).toEqual(expect.objectContaining({ apiKey: 'copilot-token' }));
    expect(native.mock.calls[0][2]).not.toHaveProperty('temperature');
  });

  it('keeps temperature for a model that accepts it', async () => {
    localStorage.setItem(
      CATALOG_KEY,
      JSON.stringify([catalogEntry('claude-sonnet-4.6', 'Claude Sonnet 4.6', 'anthropic-messages')])
    );
    const provider = getApiProvider('github-copilot-anthropic' as Api)!;
    const model = {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      api: 'github-copilot-anthropic',
      provider: 'github-copilot',
    } as Model<Api>;
    await drain(
      provider.streamSimple(
        model,
        normalizeContext({ systemPrompt: '', messages: [], tools: [] }),
        { temperature: 0.3 }
      )
    );

    expect(copilotStreamMocks.streamSimpleAnthropic).toHaveBeenCalledOnce();
    expect(copilotStreamMocks.streamSimpleAnthropic.mock.calls[0][2]).toEqual(
      expect.objectContaining({ apiKey: 'copilot-token', temperature: 0.3 })
    );
  });
});
