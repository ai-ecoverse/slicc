import { getApiProvider } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The register() call in the built-in module registers 'bedrock-camp-converse'.
import {
  bedrockCampRegionFromBaseUrl,
  config,
  isBedrockCampCompatible,
  register,
  streamBedrockCamp,
  streamSimpleBedrockCamp,
} from '../../../src/providers/built-in/bedrock-camp.js';

// Call register manually since built-in modules use explicit registration
register();

function mockOkResponse(body: any = { output: { message: { content: [{ text: 'ok' }] } } }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'x-amzn-requestid': 'req-test-123' }),
    json: async () => ({
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'end_turn',
      ...body,
    }),
  });
}

function baseModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'us.anthropic.claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (US)',
    provider: 'amazon-bedrock',
    api: 'bedrock-camp-converse',
    baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
    maxTokens: 128_000,
    input: ['text'],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as any;
}

async function capturePayload(model: any, options: Record<string, unknown> = {}): Promise<any> {
  const fetchMock = mockOkResponse();
  vi.stubGlobal('fetch', fetchMock);
  let captured: any;
  const stream = streamSimpleBedrockCamp(
    model,
    { messages: [{ role: 'user', content: 'hi' }] } as any,
    {
      apiKey: 'ABSK-test',
      ...options,
      onPayload(payload: unknown) {
        captured = payload;
      },
    } as any
  );
  await stream.result();
  return captured;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bedrock-camp built-in provider', () => {
  it('exports a valid ProviderConfig', () => {
    expect(config).toBeDefined();
    expect(config.id).toBe('bedrock-camp');
    expect(config.name).toBe('AWS Bedrock');
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

  it('parses the endpoint region for FIPS and China runtime hosts', () => {
    expect(bedrockCampRegionFromBaseUrl('https://bedrock-runtime.us-west-2.amazonaws.com')).toBe(
      'us-west-2'
    );
    expect(
      bedrockCampRegionFromBaseUrl('https://bedrock-runtime-fips.us-east-1.amazonaws.com')
    ).toBe('us-east-1');
    expect(
      bedrockCampRegionFromBaseUrl('https://bedrock-runtime.cn-north-1.amazonaws.com.cn')
    ).toBe('cn-north-1');
    expect(bedrockCampRegionFromBaseUrl('not a url')).toBeNull();
    expect(bedrockCampRegionFromBaseUrl(null)).toBeNull();
  });

  it('filters CAMP-compatible models by region prefix', () => {
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-sonnet-4-6' }, 'us-west-2')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'eu.anthropic.claude-sonnet-4-6' }, 'us-west-2')).toBe(
      false
    );
    expect(isBedrockCampCompatible({ id: 'global.anthropic.claude-opus-4-7' }, 'eu-west-1')).toBe(
      true
    );
    expect(isBedrockCampCompatible({ id: 'anthropic.claude-sonnet-4-6' }, 'us-west-2')).toBe(false);
    expect(isBedrockCampCompatible({ id: 'us.anthropic.claude-3-5-sonnet' }, 'us-west-2')).toBe(
      false
    );
  });

  it('sends the request payload and resolved model to onPayload before fetching', async () => {
    const fetchMock = mockOkResponse({
      output: { message: { content: [{ text: 'hello from bedrock camp' }] } },
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const payloads: unknown[] = [];
    const models: unknown[] = [];
    const stream = streamSimpleBedrockCamp(
      baseModel({
        id: 'anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        input: ['text', 'image'],
        maxTokens: 200_000,
      }),
      { messages: [{ role: 'user', content: 'Say hello' }] } as any,
      {
        apiKey: 'ABSK-test',
        onPayload(payload: unknown, model: unknown) {
          payloads.push(payload);
          models.push(model);
        },
      } as any
    );

    const result = await stream.result();

    expect(result.stopReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-4-6/converse',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ABSK-test',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(payloads).toHaveLength(1);
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

  it.each([
    ['us.anthropic.claude-opus-4-6', 'max'],
    ['us.anthropic.claude-opus-4-7', 'xhigh'],
    ['global.anthropic.claude-opus-4-7', 'xhigh'],
    ['us.anthropic.claude-sonnet-4-6', 'high'],
  ])('uses adaptive thinking for Claude 4.6 / Opus 4.7 (%s -> effort=%s)', async (modelId, expectedEffort) => {
    const payload = await capturePayload(baseModel({ id: modelId, name: modelId }), {
      reasoning: 'xhigh',
    });
    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: expectedEffort },
    });
  });

  it('keeps non-adaptive Claude 4.x models on thinking.type=enabled with interleaved beta', async () => {
    const payload = await capturePayload(
      baseModel({ id: 'us.anthropic.claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }),
      { reasoning: 'medium' }
    );
    expect(payload.additionalModelRequestFields.thinking.type).toBe('enabled');
    expect(payload.additionalModelRequestFields.thinking.budget_tokens).toBeGreaterThan(0);
    expect(payload.additionalModelRequestFields.thinking.display).toBe('summarized');
    expect(payload.additionalModelRequestFields.anthropic_beta).toEqual([
      'interleaved-thinking-2025-05-14',
    ]);
  });

  it('skips the interleaved-thinking beta when interleavedThinking=false', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    let captured: any;
    const stream = streamBedrockCamp(
      baseModel({ id: 'us.anthropic.claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }),
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      {
        apiKey: 'ABSK-test',
        reasoning: 'medium',
        interleavedThinking: false,
        onPayload(payload) {
          captured = payload;
        },
      }
    );
    await stream.result();
    expect(captured.additionalModelRequestFields.thinking.type).toBe('enabled');
    expect(captured.additionalModelRequestFields.anthropic_beta).toBeUndefined();
  });

  it('omits thinking.display for GovCloud region endpoints', async () => {
    const payload = await capturePayload(
      baseModel({
        id: 'us.anthropic.claude-opus-4-7',
        baseUrl: 'https://bedrock-runtime.us-gov-west-1.amazonaws.com',
      }),
      { reasoning: 'high' }
    );
    expect(payload.additionalModelRequestFields.thinking).toEqual({ type: 'adaptive' });
    expect(payload.additionalModelRequestFields.output_config).toEqual({ effort: 'high' });
  });

  it('omits thinking.display for us-gov.* GovCloud model ids', async () => {
    const payload = await capturePayload(
      baseModel({ id: 'us-gov.anthropic.claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (GovCloud)' }),
      { reasoning: 'high' }
    );
    expect(payload.additionalModelRequestFields.thinking.type).toBe('enabled');
    expect(payload.additionalModelRequestFields.thinking.display).toBeUndefined();
  });

  it('matches the underlying model via model.name for application inference profiles', async () => {
    const payload = await capturePayload(
      baseModel({
        id: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile',
        name: 'Claude Opus 4.6',
      }),
      { reasoning: 'high' }
    );
    expect(payload.additionalModelRequestFields.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(payload.additionalModelRequestFields.output_config).toEqual({ effort: 'high' });
  });

  it('adds cache points to system prompt and last user message when model.name identifies Claude', async () => {
    const payload = await capturePayload(
      baseModel({
        id: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile',
        name: 'Claude Sonnet 4.6',
      }),
      {}
    );
    // System block + cachePoint
    expect(payload.system).toBeUndefined(); // no system prompt
    const lastMsg = payload.messages[payload.messages.length - 1];
    const lastContent = lastMsg.content[lastMsg.content.length - 1];
    expect(lastContent).toHaveProperty('cachePoint');
  });

  it('falls back to plain text for thinking blocks with empty signatures', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    let captured: any;
    const stream = streamBedrockCamp(
      baseModel(),
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I should respond.', thinkingSignature: '' },
              { type: 'text', text: 'Hi' },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      } as any,
      {
        apiKey: 'ABSK-test',
        onPayload(payload) {
          captured = payload;
        },
      }
    );
    await stream.result();
    const assistantMsg = captured.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.content[0]).toEqual({ text: 'I should respond.' });
    expect(assistantMsg.content[0]).not.toHaveProperty('reasoningContent');
  });

  it('attaches a 1h TTL to cache points when cacheRetention=long', async () => {
    const payload = await capturePayload(baseModel({ id: 'us.anthropic.claude-sonnet-4-6' }), {
      cacheRetention: 'long',
    });
    const lastMsg = payload.messages[payload.messages.length - 1];
    const cp = lastMsg.content.find((c: any) => c.cachePoint);
    expect(cp.cachePoint).toEqual({ type: 'default', ttl: '1h' });
  });

  it('omits all cache points when cacheRetention=none', async () => {
    const payload = await capturePayload(baseModel({ id: 'us.anthropic.claude-sonnet-4-6' }), {
      cacheRetention: 'none',
    });
    const lastMsg = payload.messages[payload.messages.length - 1];
    expect(lastMsg.content.some((c: any) => c.cachePoint)).toBe(false);
  });

  it('passes requestMetadata through verbatim', async () => {
    const payload = await capturePayload(baseModel(), {
      requestMetadata: { team: 'eng', cost_center: 'r-d' },
    });
    expect(payload.requestMetadata).toEqual({ team: 'eng', cost_center: 'r-d' });
  });

  it('omits temperature for Opus 4.7 (CAMP deprecates it)', async () => {
    const payload = await capturePayload(
      baseModel({ id: 'us.anthropic.claude-opus-4-7', name: 'Claude Opus 4.7 (US)' }),
      { temperature: 0.5, reasoning: 'high' }
    );
    expect(payload.inferenceConfig.temperature).toBeUndefined();
  });

  it('omits temperature for Opus 4.8 (CAMP deprecates it)', async () => {
    const payload = await capturePayload(
      baseModel({ id: 'us.anthropic.claude-opus-4-8', name: 'Claude Opus 4.8 (US)' }),
      { temperature: 0.5, reasoning: 'high' }
    );
    expect(payload.inferenceConfig.temperature).toBeUndefined();
  });

  it('keeps temperature for other models', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    let captured: any;
    const stream = streamBedrockCamp(
      baseModel({ id: 'us.anthropic.claude-sonnet-4-6' }),
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      {
        apiKey: 'ABSK-test',
        temperature: 0.5,
        onPayload(payload) {
          captured = payload;
        },
      }
    );
    await stream.result();
    expect(captured.inferenceConfig.temperature).toBe(0.5);
  });

  it('lets onPayload replace the request body when it returns a value', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    const stream = streamBedrockCamp(
      baseModel(),
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      {
        apiKey: 'ABSK-test',
        onPayload(payload: any) {
          return { ...payload, modelId: 'rewritten-model-id' };
        },
      }
    );
    await stream.result();
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(sentBody.modelId).toBe('rewritten-model-id');
  });

  it('invokes onResponse with status and headers from the http response', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    let response: any;
    const stream = streamBedrockCamp(
      baseModel(),
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      {
        apiKey: 'ABSK-test',
        onResponse(r) {
          response = r;
        },
      }
    );
    await stream.result();
    expect(response.status).toBe(200);
    expect(response.headers['x-amzn-requestid']).toBe('req-test-123');
  });

  it('merges custom headers into the outgoing request', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    const stream = streamBedrockCamp(
      baseModel(),
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      { apiKey: 'ABSK-test', headers: { 'X-Custom-Header': 'value-1' } }
    );
    await stream.result();
    const sentHeaders = (fetchMock.mock.calls[0][1] as any).headers;
    expect(sentHeaders).toEqual(
      expect.objectContaining({
        'X-Custom-Header': 'value-1',
        Authorization: 'Bearer ABSK-test',
      })
    );
  });

  it.each([
    [429, 'Throttling error'],
    [503, 'Service unavailable'],
    [502, 'Internal server error'],
    [500, 'Internal server error'],
    [400, 'Validation error'],
  ])('prefixes HTTP %s errors with %s', async (status, prefix) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers(),
      text: async () => 'upstream message',
    });
    vi.stubGlobal('fetch', fetchMock);
    const stream = streamBedrockCamp(
      baseModel(),
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      { apiKey: 'ABSK-test' }
    );
    const result = await stream.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain(prefix);
    expect(result.errorMessage).toContain('upstream message');
  });

  it('throws on unsupported image MIME types', async () => {
    const fetchMock = mockOkResponse();
    vi.stubGlobal('fetch', fetchMock);
    const stream = streamBedrockCamp(
      baseModel({ id: 'us.anthropic.claude-sonnet-4-6', input: ['text', 'image'] }),
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', mimeType: 'image/bmp', data: 'AAAA' }],
          },
        ],
      } as any,
      { apiKey: 'ABSK-test' }
    );
    const result = await stream.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('Unsupported image MIME type');
  });
});
