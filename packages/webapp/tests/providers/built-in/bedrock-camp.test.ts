import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiProvider } from '@mariozechner/pi-ai';

// The register() call in the built-in module registers 'bedrock-camp-converse'.
import {
  register,
  config,
  streamSimpleBedrockCamp,
} from '../../../src/providers/built-in/bedrock-camp.js';

// Call register manually since built-in modules use explicit registration
register();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bedrock-camp built-in provider', () => {
  it('exports a valid ProviderConfig', () => {
    expect(config).toBeDefined();
    expect(config.id).toBe('bedrock-camp');
    expect(config.name).toBe('AWS Bedrock (CAMP)');
    expect(config.requiresApiKey).toBe(true);
    expect(config.requiresBaseUrl).toBe(true);
  });

  it('registers bedrock-camp-converse in the API provider registry', () => {
    const provider = getApiProvider('bedrock-camp-converse' as any);
    expect(provider).toBeDefined();
    expect(provider!.api).toBe('bedrock-camp-converse');
  });

  it('registers both stream and streamSimple functions', () => {
    const provider = getApiProvider('bedrock-camp-converse' as any);
    expect(typeof provider!.stream).toBe('function');
    expect(typeof provider!.streamSimple).toBe('function');
  });

  it('passes the request payload and resolved model to onPayload before sending the converse request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: {
          message: {
            content: [{ text: 'hello from bedrock camp' }],
          },
        },
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        stopReason: 'end_turn',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const payloads: unknown[] = [];
    const models: unknown[] = [];
    const stream = streamSimpleBedrockCamp(
      {
        id: 'anthropic.claude-sonnet-4-6',
        provider: 'bedrock-camp',
        api: 'bedrock-camp-converse',
        baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
        maxTokens: 200000,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      } as any,
      {
        messages: [{ role: 'user', content: 'Say hello' }],
      } as any,
      {
        apiKey: 'ABSK-test',
        onPayload(payload, model) {
          expect(arguments).toHaveLength(2);
          payloads.push(payload);
          models.push(model);
        },
      }
    );

    const result = await stream.result();

    expect(result.stopReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/fetch-proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ABSK-test',
          'Content-Type': 'application/json',
          'X-Target-URL':
            'https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-4-6/converse',
        }),
      })
    );
    expect(payloads).toHaveLength(1);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'anthropic.claude-sonnet-4-6',
      api: 'bedrock-camp-converse',
    });
    expect(payloads[0]).toEqual(
      expect.objectContaining({
        modelId: 'anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Say hello' }, { cachePoint: { type: 'default' } }],
          },
        ],
      })
    );
  });
});
