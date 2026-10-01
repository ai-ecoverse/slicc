import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { adaptTools } from '../../../src/core/tool-adapter.js';
import { createScoopAgent } from '../../../src/scoops/scoop-context/agent-factory.js';
import { createStructuredOutputTool } from '../../../src/scoops/structured-output-tool.js';
import type { ToolDefinition } from '../../../src/tools/types.js';

const model = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} as Model<'anthropic-messages'>;

type Block = AssistantMessage['content'][number];

function reply(content: Block[]): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

let callSeq = 0;
function call(name: string, args: Record<string, string>): Block {
  return { type: 'toolCall', id: `call_${++callSeq}`, name, arguments: args };
}

function scriptedStream(turns: AssistantMessage[]): StreamFn & { calls: number } {
  const fn = Object.assign(
    () => {
      const message = turns[Math.min(fn.calls, turns.length - 1)];
      fn.calls++;
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason as 'stop', message });
      }, 0);
      return stream;
    },
    { calls: 0 }
  );
  return fn as unknown as StreamFn & { calls: number };
}

const noop: ToolDefinition = {
  name: 'noop',
  description: 'does nothing',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'ok' }),
};

function buildAgent(stream: StreamFn, capture: (v: unknown) => void) {
  const schema = { type: 'object', properties: { action: { type: 'string' } } };
  return createScoopAgent({
    model,
    tools: adaptTools([createStructuredOutputTool(schema, capture), noop]),
    systemPrompt: '',
    messages: [],
    thinkingLevel: 'off',
    getApiKey: () => 'key',
    transformContext: (async (messages: unknown) => messages) as never,
    streamFn: stream as never,
    captureStructuredOutput: capture,
  });
}

describe('createScoopAgent — StructuredOutput ends the run', () => {
  it('stops after the first call even when the model would keep calling it', async () => {
    const stream = scriptedStream([
      ...Array.from({ length: 5 }, (_, i) =>
        reply([call('StructuredOutput', { action: `step ${i + 1}` })])
      ),
      reply([{ type: 'text', text: 'done' }]),
    ]);
    const capture = vi.fn();

    await buildAgent(stream, capture).prompt('decide');

    expect(stream.calls).toBe(1);
    expect(capture).toHaveBeenCalledWith({ action: 'step 1' });
    expect(capture.mock.calls.every(([v]) => (v as { action: string }).action === 'step 1')).toBe(
      true
    );
  });

  it('ends the run when StructuredOutput shares a batch with another tool', async () => {
    const stream = scriptedStream([
      reply([call('noop', {}), call('StructuredOutput', { action: 'final' })]),
      reply([call('noop', {})]),
      reply([call('noop', {})]),
      reply([{ type: 'text', text: 'done' }]),
    ]);

    await buildAgent(stream, vi.fn()).prompt('decide');

    expect(stream.calls).toBe(1);
  });

  it('keeps going for a model that has not called it yet', async () => {
    const stream = scriptedStream([
      reply([call('noop', {})]),
      reply([call('noop', {})]),
      reply([call('StructuredOutput', { action: 'late' })]),
      reply([{ type: 'text', text: 'never reached' }]),
    ]);
    const capture = vi.fn();

    await buildAgent(stream, capture).prompt('decide');

    expect(stream.calls).toBe(3);
    expect(capture).toHaveBeenCalledWith({ action: 'late' });
  });
});
