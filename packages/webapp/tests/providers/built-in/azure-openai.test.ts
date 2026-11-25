import { getApiProvider } from '@earendil-works/pi-ai/compat';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The openai SDK must load on the first Azure request, never with the
// provider chunk: registerProviders() awaits every built-in provider chunk
// at page and kernel-worker boot. The vi.mock factory only runs when
// `openai` is actually imported, so `sdk.loads` proves the import is lazy.
const sdk = vi.hoisted(() => ({
  loads: 0,
  clientOptions: [] as Record<string, unknown>[],
  createParams: [] as Record<string, unknown>[],
  chunks: [] as unknown[],
}));

vi.mock('openai', () => {
  sdk.loads += 1;
  class AzureOpenAI {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sdk.createParams.push(params);
          return (async function* () {
            yield* sdk.chunks;
          })();
        },
      },
    };
    constructor(options: Record<string, unknown>) {
      sdk.clientOptions.push(options);
    }
  }
  return { AzureOpenAI };
});

vi.mock('../../../src/providers/account-store.js', () => ({
  getApiVersionForProvider: vi.fn(() => ''),
  getDeploymentForProvider: vi.fn(() => 'gpt-4o, o4-mini ,'),
}));

const { config, register } = await import('../../../src/providers/built-in/azure-openai.js');
register();

const model = {
  id: 'gpt-4o',
  name: 'gpt-4o (Azure)',
  provider: 'azure-openai',
  api: 'azure-openai-anthropic',
  baseUrl: 'https://res.cognitiveservices.azure.com//',
  headers: { 'x-model': 'm' },
  maxTokens: 4096,
  input: ['text'],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

async function collect(stream: AsyncIterable<{ type: string }>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function streamWith(options: Record<string, unknown>) {
  const provider = getApiProvider('azure-openai-anthropic' as any);
  return provider!.stream(
    model,
    {
      systemPrompt: 'be brief',
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    } as any,
    options as any
  );
}

describe('azure-openai built-in provider', () => {
  beforeEach(() => {
    sdk.clientOptions.length = 0;
    sdk.createParams.length = 0;
    sdk.chunks = [];
  });

  it('does not load the openai SDK until a request is made', () => {
    expect(config.id).toBe('azure-openai');
    expect(getApiProvider('azure-openai-anthropic' as any)).toBeDefined();
    expect(sdk.loads).toBe(0);
  });

  it('lists one model per configured deployment', () => {
    expect(config.getModelIds?.()).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o (Azure)', reasoning: false, input: ['text', 'image'] },
      { id: 'o4-mini', name: 'o4-mini (Azure)', reasoning: true, input: ['text', 'image'] },
    ]);
  });

  it('reports a missing API key as a stream error without loading the SDK', async () => {
    const events = await collect(streamWith({}));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      error: { errorMessage: 'Azure API key is required' },
    });
    expect(sdk.loads).toBe(0);
  });

  it('loads the SDK on first use and streams text and tool calls', async () => {
    sdk.chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { arguments: 'th":"a"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ];

    const events = await collect(
      streamWith({ apiKey: 'k', maxTokens: 256, temperature: 0.2, headers: { 'x-opt': 'o' } })
    );

    expect(sdk.loads).toBe(1);
    expect(sdk.clientOptions).toEqual([
      {
        endpoint: 'https://res.cognitiveservices.azure.com',
        apiKey: 'k',
        deployment: 'gpt-4o',
        apiVersion: '2024-12-01-preview',
        dangerouslyAllowBrowser: true,
        defaultHeaders: { 'x-model': 'm', 'x-opt': 'o' },
      },
    ]);
    expect(sdk.createParams[0]).toMatchObject({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 256,
      temperature: 0.2,
      tools: [
        {
          type: 'function',
          function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
        },
      ],
    });

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_delta',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_delta',
      'text_end',
      'toolcall_end',
      'done',
    ]);
    const done = events.at(-1);
    expect(done.reason).toBe('toolUse');
    expect(done.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a' } },
    ]);
    expect(done.message.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
  });
});
