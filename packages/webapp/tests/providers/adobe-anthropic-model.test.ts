import type { Model } from '@earendil-works/pi-ai';
import { streamAnthropic, streamSimpleAnthropic } from '@earendil-works/pi-ai/compat';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adobeAnthropicModel } from '../../src/providers/adobe-anthropic-model.js';

const nativeModel: Model<'anthropic-messages'> = {
  id: 'claude-opus-4-6',
  name: 'Claude Opus 4.6',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://native.example',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    supportsEagerToolInputStreaming: false,
    forceAdaptiveThinking: true,
  },
};

function curatorContext() {
  const context = normalizeContext({
    systemPrompt: 'Curate memory.',
    tools: [{ name: 'bash', description: 'Shell', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'Read the archive.', timestamp: 1 }],
  });
  context.messages.push({
    role: 'system',
    content: 'Updated curator instructions.',
    timestamp: 2,
    toolsAdded: [
      { name: 'read', description: 'Read draft', parameters: { type: 'object', properties: {} } },
    ],
    toolsRemoved: [{ name: 'bash' }],
  });
  context.messages.push({ role: 'user', content: 'Write the draft.', timestamp: 3 });
  return context;
}

async function outgoingBody(
  model: Model<'anthropic-messages'>,
  simple: boolean,
  thinking: boolean
) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'test response' } }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }
    )
  );
  vi.stubGlobal('fetch', fetchMock);
  const options = { apiKey: 'test-key', cacheRetention: 'none' as const };
  const stream = simple
    ? streamSimpleAnthropic(model, curatorContext(), {
        ...options,
        ...(thinking ? { reasoning: 'medium' as const } : {}),
      })
    : streamAnthropic(model, curatorContext(), {
        ...options,
        thinkingEnabled: thinking,
        effort: 'medium',
      });
  await stream.result();
  expect(fetchMock).toHaveBeenCalledOnce();
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

afterEach(() => vi.unstubAllGlobals());

describe('Adobe Anthropic transport', () => {
  it('overrides native transport flags without mutating catalog metadata or unrelated compat', () => {
    const adobe = adobeAnthropicModel(nativeModel, 'https://proxy.example');
    expect(adobe.api).toBe('anthropic-messages');
    expect(adobe.baseUrl).toBe('https://proxy.example');
    expect(adobe.compat).toEqual({
      ...nativeModel.compat,
      supportsMidConvoEffort: false,
      supportsMidConvoSystemMessages: false,
      supportsMidConvoToolChanges: false,
    });
    expect(nativeModel.compat?.supportsMidConvoEffort).toBe(true);
    expect(nativeModel.baseUrl).toBe('https://native.example');
  });

  it.each([false, true])('serializes Bedrock-compatible messages (simple=%s)', async (simple) => {
    const model = adobeAnthropicModel(
      { ...nativeModel, provider: 'adobe' },
      'https://proxy.example'
    );
    const body = await outgoingBody(model, simple, true);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'user',
    ]);
    for (const message of body.messages) {
      expect(Object.keys(message).sort()).toEqual(['content', 'role']);
    }
    expect(body.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Updated curator instructions.') }),
      ])
    );
    expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read' })]));
    expect(body.tools.some((tool: { name: string }) => tool.name === 'bash')).toBe(false);
    expect(body.thinking.type).toBe('adaptive');
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it.each([false, true])('keeps thinking disabled when requested (simple=%s)', async (simple) => {
    const body = await outgoingBody(
      adobeAnthropicModel(nativeModel, 'https://proxy.example'),
      simple,
      false
    );
    expect(body).not.toHaveProperty('output_config');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('retains native Anthropic effort messages for the original provider', async () => {
    const body = await outgoingBody(nativeModel, false, true);
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', output_config: { effort: 'medium' } }),
      ])
    );
  });
});
