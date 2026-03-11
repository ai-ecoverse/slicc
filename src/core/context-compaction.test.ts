import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

const mockGenerateSummary = vi.fn().mockResolvedValue('## Summary\nGoal: testing\nProgress: done');

// Mock the pi-coding-agent compaction submodule (deep import path used in context-compaction.ts)
vi.mock('@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js', () => ({
  estimateTokens: (msg: any) => {
    // Simple chars/4 heuristic matching the real implementation
    let chars = 0;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
      }
    }
    return Math.ceil(chars / 4);
  },
  shouldCompact: (contextTokens: number, contextWindow: number, settings: any) => {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
  },
  generateSummary: (...args: any[]) => mockGenerateSummary(...args),
  DEFAULT_COMPACTION_SETTINGS: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}));

import { compactContext, createCompactContext } from './context-compaction.js';
import { MAX_SINGLE_RESULT_CHARS } from './tool-adapter.js';

/** Helper to create an AgentMessage */
function createMessage(role: 'user' | 'assistant' | 'toolResult', text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text' as const, text }],
  } as any;
}

/** Helper to create a toolResult message */
function createToolResult(text: string, toolCallId = 'tool-1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    content: [{ type: 'text' as const, text }],
  } as any;
}

/** Helper to create an assistant message with tool calls */
function createAssistantWithToolCalls(text: string, toolCallIds: string[]): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text' as const, text },
      ...toolCallIds.map((id) => ({
        type: 'toolCall' as const,
        id,
        name: 'test_tool',
        arguments: {},
      })),
    ],
  } as any;
}

describe('compactContext (legacy)', () => {
  it('returns empty array for empty input', async () => {
    const result = await compactContext([]);
    expect(result).toEqual([]);
  });

  it('passes through messages under limit unchanged', async () => {
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi there'),
      createMessage('user', 'How are you?'),
    ];
    const result = await compactContext(messages);
    expect(result).toEqual(messages);
    expect(result.length).toBe(3);
  });

  it('drops older messages when total exceeds threshold', async () => {
    // Each message ~65K chars => ~16250 tokens. 12 messages => ~195000 tokens, exceeds 200000-16384=183616
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, (_, i) => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    // Should be smaller than original
    expect(result.length).toBeLessThan(messages.length);
    // First message should be the compaction marker
    expect((result[0].content as any)[0].text).toContain('Earlier conversation');
  });

  it('inserts compaction marker', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 20 }, () => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    const marker = result.find(
      (msg) => msg.role === 'user' && (msg.content as any)[0]?.text?.includes('Earlier conversation'),
    );
    expect(marker).toBeDefined();
    expect(marker!.role).toBe('user');
  });

  it('does not split assistant+toolResult pairs when compacting', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages: AgentMessage[] = [
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createAssistantWithToolCalls(baseMsg, ['tool-a', 'tool-b']),
      createToolResult(baseMsg, 'tool-a'),
      createToolResult(baseMsg, 'tool-b'),
      createMessage('user', 'follow up'),
      createMessage('assistant', 'response'),
    ];

    const result = await compactContext(messages);

    // Every toolResult must have a preceding assistant with matching toolCall
    for (let i = 0; i < result.length; i++) {
      const msg = result[i] as any;
      if (msg.role === 'toolResult' && msg.toolCallId) {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = result[j] as any;
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: any) => c.type === 'toolCall' && c.id === msg.toolCallId,
            );
            if (hasToolCall) { found = true; break; }
          }
          if (prev.role !== 'toolResult') break;
        }
        expect(found).toBe(true);
      }
    }
  });

  it('does not modify input messages array', async () => {
    const messages = [createMessage('user', 'hello'), createMessage('assistant', 'hi')];
    const original = [...messages];
    await compactContext(messages);
    expect(messages).toEqual(original);
  });

  it('returns messages unchanged when all messages form one large block (no valid cut point)', async () => {
    // Single huge message: cutIndex would be 0 which is <= 0, so no compaction
    const hugeMsg = 'x'.repeat(800000);
    const messages = [createMessage('user', hugeMsg)];
    const result = await compactContext(messages);
    expect(result).toEqual(messages);
  });

  it('does not split assistant+toolResult pairs in legacy compaction', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages: AgentMessage[] = [
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createAssistantWithToolCalls(baseMsg, ['t1']),
      createToolResult(baseMsg, 't1'),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
    ];

    const result = await compactContext(messages);

    // If toolResult t1 is in the result, its assistant must also be present
    for (let i = 0; i < result.length; i++) {
      const msg = result[i] as any;
      if (msg.role === 'toolResult' && msg.toolCallId) {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = result[j] as any;
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: any) => c.type === 'toolCall' && c.id === msg.toolCallId,
            );
            if (hasToolCall) { found = true; break; }
          }
          if (prev.role !== 'toolResult') break;
        }
        expect(found).toBe(true);
      }
    }
  });
});

describe('createCompactContext', () => {
  const mockModel = { id: 'test-model' } as any;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 200000,
  };

  beforeEach(() => {
    mockGenerateSummary.mockClear();
    mockGenerateSummary.mockResolvedValue('## Summary\nGoal: testing\nProgress: done');
  });

  it('returns messages unchanged when under threshold', async () => {
    const compact = createCompactContext(mockConfig);
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi'),
    ];

    const result = await compact(messages);
    expect(result).toEqual(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it('returns empty array for empty input', async () => {
    const compact = createCompactContext(mockConfig);
    const result = await compact([]);
    expect(result).toEqual([]);
  });

  it('calls generateSummary when threshold exceeded', async () => {
    const compact = createCompactContext(mockConfig);
    // ~16250 tokens each, 12 messages = ~195K tokens, exceeds 200000-16384
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    // Result should contain the summary + kept recent messages
    expect(result.length).toBeLessThan(messages.length);
    expect((result[0].content as any)[0].text).toContain('<context-summary>');
    expect((result[0].content as any)[0].text).toContain('Summary');
  });

  it('preserves recent messages after summarization', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = [
      ...Array.from({ length: 10 }, () => createMessage('user', baseMsg)),
      createMessage('user', 'recent-1'),
      createMessage('assistant', 'recent-2'),
    ];

    const result = await compact(messages);

    // Last messages should be preserved
    const lastMsg = result[result.length - 1];
    expect((lastMsg.content as any)[0].text).toBe('recent-2');
  });

  it('falls back to naive drop when generateSummary fails', async () => {
    mockGenerateSummary.mockRejectedValueOnce(new Error('API error'));

    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    // Should still compact, just without summary
    expect(result.length).toBeLessThan(messages.length);
    expect((result[0].content as any)[0].text).toContain('Earlier conversation');
  });

  it('falls back to naive drop when no API key', async () => {
    const compact = createCompactContext({
      ...mockConfig,
      getApiKey: () => undefined,
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(result.length).toBeLessThan(messages.length);
    expect((result[0].content as any)[0].text).toContain('Earlier conversation');
  });

  it('does not split assistant+toolResult pairs', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages: AgentMessage[] = [
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createAssistantWithToolCalls(baseMsg, ['t1']),
      createToolResult(baseMsg, 't1'),
      createMessage('user', 'last'),
      createMessage('assistant', 'done'),
    ];

    const result = await compact(messages);

    // Every toolResult must have its assistant
    for (let i = 0; i < result.length; i++) {
      const msg = result[i] as any;
      if (msg.role === 'toolResult' && msg.toolCallId) {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = result[j] as any;
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: any) => c.type === 'toolCall' && c.id === msg.toolCallId,
            );
            if (hasToolCall) { found = true; break; }
          }
          if (prev.role !== 'toolResult') break;
        }
        expect(found).toBe(true);
      }
    }
  });

  it('respects custom contextWindow and reserveTokens', async () => {
    const compact = createCompactContext({
      ...mockConfig,
      contextWindow: 100000,
      reserveTokens: 10000,
    });
    // At 100K window with 10K reserve, threshold is 90K tokens
    // 6 messages at ~16250 tokens each = ~97500, exceeds 90K
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 6 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);
    expect(result.length).toBeLessThan(messages.length);
  });

  it('wraps summary in context-summary tags', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    const summaryText = (result[0].content as any)[0].text;
    expect(summaryText).toMatch(/^<context-summary>\n/);
    expect(summaryText).toMatch(/\n<\/context-summary>$/);
  });

  it('passes signal to generateSummary', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));
    const controller = new AbortController();

    await compact(messages, controller.signal);

    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    // 5th argument is the signal
    const callArgs = mockGenerateSummary.mock.calls[0];
    expect(callArgs[4]).toBe(controller.signal);
  });

  it('passes model and reserveTokens to generateSummary', async () => {
    const compact = createCompactContext({
      ...mockConfig,
      reserveTokens: 8000,
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    const callArgs = mockGenerateSummary.mock.calls[0];
    // generateSummary(messages, model, reserveTokens, apiKey, signal)
    expect(callArgs[1]).toBe(mockConfig.model); // model
    expect(callArgs[2]).toBe(8000); // reserveTokens
    expect(callArgs[3]).toBe('test-key'); // apiKey
  });

  it('returns messages unchanged when single message exceeds window (no valid cut)', async () => {
    const compact = createCompactContext(mockConfig);
    // Single 800K char message (~200K tokens), exceeds window but can't be split
    const hugeMsg = 'x'.repeat(800000);
    const messages = [createMessage('user', hugeMsg)];

    const result = await compact(messages);
    expect(result).toEqual(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it('full-size tool results survive until compaction', async () => {
    const compact = createCompactContext(mockConfig);
    // A 40K tool result should NOT be truncated (under 50K safety cap)
    const largeResult = 'x'.repeat(40000);
    const messages = [
      createMessage('user', 'run tool'),
      createAssistantWithToolCalls('calling tool', ['t1']),
      createToolResult(largeResult, 't1'),
      createMessage('user', 'thanks'),
    ];

    const result = await compact(messages);

    // Under threshold, messages pass through unchanged
    expect(result).toEqual(messages);
    // Tool result preserved at full size
    expect((result[2].content as any)[0].text).toBe(largeResult);
  });
});

describe('MAX_SINGLE_RESULT_CHARS', () => {
  it('is 50000', () => {
    expect(MAX_SINGLE_RESULT_CHARS).toBe(50000);
  });
});
