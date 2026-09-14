import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompleteSimple = vi.fn();

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
  };
});

import { estimateTokens } from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { createCompactContext } from '../../src/core/context-compaction.js';

function createToolResult(text: string, toolCallId = 'tool-1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'open',
    content: [{ type: 'text' as const, text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

function createUser(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text' as const, text }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function createAssistantWithToolCall(text: string, toolCallId: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text' as const, text },
      { type: 'toolCall' as const, id: toolCallId, name: 'open', arguments: {} },
    ],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function createThinkingTurn(signatureChars: number, thinking = 'brief'): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking' as const, thinking, thinkingSignature: 's'.repeat(signatureChars) },
      { type: 'text' as const, text: 'ok' },
    ],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function createTextTurn(
  text: string,
  usage?: Record<string, unknown>,
  stopReason?: string
): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text' as const, text }],
    timestamp: 0,
    ...(usage ? { usage } : {}),
    ...(stopReason ? { stopReason } : {}),
  } as unknown as AgentMessage;
}

function usageRecord(totalTokens: number) {
  return {
    input: 0,
    output: 0,
    cacheRead: totalTokens,
    cacheWrite: 0,
    totalTokens,
    cost: {},
  };
}

function upstreamTotal(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function llmResponse(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    timestamp: 0,
  };
}

describe('estimateTokens (real implementation)', () => {
  it('counts text bytes inside a toolResult content block', () => {
    const oneMb = 'x'.repeat(1_000_000);
    const tokens = estimateTokens(createToolResult(oneMb));

    expect(tokens).toBeGreaterThan(200_000);
  });

  it('counts text bytes inside a toolResult when content is a plain string', () => {
    const oneMb = 'x'.repeat(1_000_000);
    const msg = {
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'open',
      content: oneMb,
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;
    expect(estimateTokens(msg)).toBeGreaterThan(200_000);
  });
});

describe('createCompactContext with the real estimator', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,

    contextWindow: 100_000,
  };

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('summary'));
  });

  it('triggers compaction when one ~1 MB toolResult dominates the window', async () => {
    const oneMb = 'x'.repeat(1_000_000);
    const messages: AgentMessage[] = [
      createUser('please read the image'),
      createAssistantWithToolCall('opening it now', 'tool-1'),
      createToolResult(oneMb, 'tool-1'),
      createUser('what did you find?'),
    ];

    const result = await createCompactContext(mockConfig)(messages);

    const resultText = JSON.stringify(result);
    expect(resultText).not.toContain('x'.repeat(1000));
    expect(resultText).toContain('Tool result elided');

    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('does NOT trigger compaction when toolResult payloads are small', async () => {
    const small = 'x'.repeat(100);
    const messages: AgentMessage[] = [
      createUser('hi'),
      createAssistantWithToolCall('calling', 'tool-1'),
      createToolResult(small, 'tool-1'),
      createUser('thanks'),
    ];

    await createCompactContext(mockConfig)(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });
});

describe('thinkingSignature accounting', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 100_000,
  };

  const threshold = 100_000 - 16_384;

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('summary'));
  });

  it('upstream estimateTokens does not count thinkingSignature', () => {
    const turn = createThinkingTurn(400_000, 'brief');
    expect(estimateTokens(turn)).toBeLessThan(100);
  });

  it('triggers compaction when thinkingSignature blobs fill the window', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), createThinkingTurn(80_000));
    }

    expect(upstreamTotal(messages)).toBeLessThan(threshold);

    const result = await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result[0])).toContain('<context-summary>');
    expect(result.length).toBeLessThan(messages.length);
  });

  it('does NOT trigger when the same turns carry no signature', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'brief' }],
        timestamp: 0,
      } as unknown as AgentMessage);
    }

    const result = await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });

  it('prices the kept tail by signature weight too', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), createThinkingTurn(80_000));
    }

    const result = await createCompactContext(mockConfig)(messages);

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(messages[messages.length - 1]);
  });
});

describe('provider-reported usage in the compaction trigger', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 100_000,
  };
  const threshold = 100_000 - 16_384;

  function conversation(usage?: Record<string, unknown>, stopReason?: string): AgentMessage[] {
    const body = 'a'.repeat(40_000);
    return [
      createUser('one'),
      createTextTurn(body),
      createUser('two'),
      createTextTurn(body),
      createUser('three'),
      createTextTurn(body),
      createUser('four'),
      createTextTurn(body, usage, stopReason),
    ];
  }

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('summary'));
  });

  it('trusts the reported usage over the optimistic heuristic', async () => {
    const messages = conversation(usageRecord(95_000));
    expect(upstreamTotal(messages)).toBeLessThan(threshold);

    const result = await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result[0])).toContain('<context-summary>');
  });

  it('ignores usage from an errored or aborted turn', async () => {
    for (const stopReason of ['error', 'aborted']) {
      mockCompleteSimple.mockClear();
      const messages = conversation(usageRecord(95_000), stopReason);

      const result = await createCompactContext(mockConfig)(messages);
      expect(mockCompleteSimple, stopReason).not.toHaveBeenCalled();
      expect(result).toBe(messages);
    }
  });

  it('ignores an all-zero usage record', async () => {
    const messages = conversation(usageRecord(0));
    const result = await createCompactContext(mockConfig)(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });

  it('still triggers when the heuristic exceeds a stale small usage', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), createThinkingTurn(80_000));
    }
    (messages[messages.length - 1] as unknown as { usage: unknown }).usage = usageRecord(500);

    await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });

  it('counts messages appended after the last reported usage', async () => {
    const messages = [...conversation(usageRecord(80_000))];
    expect(upstreamTotal(messages)).toBeLessThan(threshold);
    messages.push(createUser('x'.repeat(40_000)));

    await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });
});
