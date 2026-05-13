import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';

/** Structural views used in test helpers and assertions to avoid `any`. */
type TestContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};
type TestMessage = {
  role: string;
  content: TestContentBlock[] | string;
  toolCallId?: string;
};
type CompactionSettingsArg = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

const mockGenerateSummary = vi.fn().mockResolvedValue('## Summary\nGoal: testing\nProgress: done');

// Mock the pi-coding-agent compaction submodule (deep import path used in context-compaction.ts)
vi.mock('@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', () => ({
  estimateTokens: (msg: TestMessage) => {
    // Simple chars/4 heuristic matching the real implementation
    let chars = 0;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
      }
    }
    return Math.ceil(chars / 4);
  },
  shouldCompact: (
    contextTokens: number,
    contextWindow: number,
    settings: CompactionSettingsArg
  ) => {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
  },
  generateSummary: (...args: unknown[]) => mockGenerateSummary(...args),
  DEFAULT_COMPACTION_SETTINGS: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}));

import {
  compactContext,
  createCompactContext,
  stripOrphanedToolResults,
} from '../../src/core/context-compaction.js';

/** Cast helper used in assertions where a typed AgentMessage view of an array of content blocks is needed. */
function asTestMessage(message: AgentMessage): TestMessage {
  return message as unknown as TestMessage;
}

/** Read the text of the first content block on an `AgentMessage`. Tests assert on this often. */
function firstText(message: AgentMessage): string {
  const content = asTestMessage(message).content;
  if (!Array.isArray(content)) return '';
  return content[0]?.text ?? '';
}

/** Helper to create an AgentMessage */
function createMessage(role: 'user' | 'assistant' | 'toolResult', text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text' as const, text }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

/** Helper to create a toolResult message */
function createToolResult(text: string, toolCallId = 'tool-1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'test_tool',
    content: [{ type: 'text' as const, text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
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
    timestamp: 0,
  } as unknown as AgentMessage;
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
    expect(firstText(result[0])).toContain('Earlier conversation');
  });

  it('inserts compaction marker', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 20 }, () => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    const marker = result.find(
      (msg) => msg.role === 'user' && firstText(msg).includes('Earlier conversation')
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
      const msg = asTestMessage(result[i]);
      if (msg.role === 'toolResult' && msg.toolCallId) {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = asTestMessage(result[j]);
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: TestContentBlock) => c.type === 'toolCall' && c.id === msg.toolCallId
            );
            if (hasToolCall) {
              found = true;
              break;
            }
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
      const msg = asTestMessage(result[i]);
      if (msg.role === 'toolResult' && msg.toolCallId) {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = asTestMessage(result[j]);
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: TestContentBlock) => c.type === 'toolCall' && c.id === msg.toolCallId
            );
            if (hasToolCall) {
              found = true;
              break;
            }
          }
          if (prev.role !== 'toolResult') break;
        }
        expect(found).toBe(true);
      }
    }
  });
});

describe('createCompactContext', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
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
    const messages = [createMessage('user', 'Hello'), createMessage('assistant', 'Hi')];

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
    expect(firstText(result[0])).toContain('<context-summary>');
    expect(firstText(result[0])).toContain('Summary');
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
    expect(firstText(lastMsg)).toBe('recent-2');
  });

  it('falls back to naive drop when generateSummary fails', async () => {
    mockGenerateSummary.mockRejectedValueOnce(new Error('API error'));

    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    // Should still compact, just without summary
    expect(result.length).toBeLessThan(messages.length);
    expect(firstText(result[0])).toContain('Earlier conversation');
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
    expect(firstText(result[0])).toContain('Earlier conversation');
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
      const msg = asTestMessage(result[i]);
      if (msg.role === 'toolResult' && msg.toolCallId) {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = asTestMessage(result[j]);
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: TestContentBlock) => c.type === 'toolCall' && c.id === msg.toolCallId
            );
            if (hasToolCall) {
              found = true;
              break;
            }
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

    const summaryText = firstText(result[0]);
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
    // pi-coding-agent generateSummary positional signature is
    //   (messages, model, reserveTokens, apiKey, headers, signal, ...)
    // signal lands at index 5; index 4 is reserved for headers.
    const callArgs = mockGenerateSummary.mock.calls[0];
    expect(callArgs[5]).toBe(controller.signal);
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
    // generateSummary(messages, model, reserveTokens, apiKey, headers, signal, ...)
    expect(callArgs[1]).toBe(mockConfig.model); // model
    expect(callArgs[2]).toBe(8000); // reserveTokens
    expect(callArgs[3]).toBe('test-key'); // apiKey
  });

  it('forwards configured headers to generateSummary', async () => {
    // Regression test: SLICC's Adobe LLM proxy needs the X-Session-Id header
    // on compaction calls. Without this wiring the header lands as undefined
    // and the proxy falls back to its content-derived hash, fragmenting
    // sessions across multiple ids.
    const compact = createCompactContext({
      ...mockConfig,
      headers: { 'X-Session-Id': 'cone_42/abcd1234' },
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    const callArgs = mockGenerateSummary.mock.calls[0];
    // headers lands at index 4 (between apiKey and signal).
    expect(callArgs[4]).toEqual({ 'X-Session-Id': 'cone_42/abcd1234' });
  });

  it('passes undefined headers when not configured', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    const callArgs = mockGenerateSummary.mock.calls[0];
    expect(callArgs[4]).toBeUndefined();
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

  it('walk-back guard keeps assistant+toolResult pair together across the cut', async () => {
    // Verifies the walk-back guard (lines 137-141 in context-compaction.ts):
    // when the naive cut would land on a toolResult, cutIndex is walked back
    // to include the preceding assistant, so the kept slice never starts with
    // an orphaned toolResult. Note: `stripOrphanedToolResults` is a no-op
    // here — the guard is what makes this pass.
    const compact = createCompactContext({ ...mockConfig, getApiKey: () => undefined });
    const baseMsg = 'x'.repeat(65000);
    const messages: AgentMessage[] = [
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createMessage('assistant', baseMsg),
      createMessage('user', baseMsg),
      createAssistantWithToolCalls(baseMsg, ['orphan-id']),
      createToolResult('small result', 'orphan-id'),
      createMessage('user', 'follow up'),
    ];

    const result = await compact(messages);

    // The result must never start with a toolResult
    expect(asTestMessage(result[0]).role).not.toBe('toolResult');

    // No toolResult in the output should be orphaned
    for (let i = 0; i < result.length; i++) {
      const msg = asTestMessage(result[i]);
      if (msg.role !== 'toolResult' || !msg.toolCallId) continue;
      let found = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = asTestMessage(result[j]);
        if (prev.role === 'assistant' && Array.isArray(prev.content)) {
          if (
            prev.content.some(
              (c: TestContentBlock) => c.type === 'toolCall' && c.id === msg.toolCallId
            )
          ) {
            found = true;
            break;
          }
        }
        if (prev.role !== 'toolResult') break;
      }
      expect(found).toBe(true);
    }
  });

  it('full-size tool results survive until compaction', async () => {
    const compact = createCompactContext(mockConfig);
    // Tool results pass through at full fidelity — overflow recovery handles sizing if needed
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
    expect(firstText(result[2])).toBe(largeResult);
  });
});

describe('stripOrphanedToolResults', () => {
  it('returns the array unchanged when it does not start with a toolResult', () => {
    const messages: AgentMessage[] = [
      createMessage('user', 'hello'),
      createAssistantWithToolCalls('calling', ['t1']),
      createToolResult('result', 't1'),
    ];
    const result = stripOrphanedToolResults(messages);
    expect(result).toBe(messages); // same reference — no copy made
  });

  it('returns empty array unchanged', () => {
    const result = stripOrphanedToolResults([]);
    expect(result).toEqual([]);
  });

  it('drops a single orphaned toolResult at the head', () => {
    const messages: AgentMessage[] = [
      createToolResult('orphan', 'orphan-id'),
      createMessage('user', 'follow up'),
      createMessage('assistant', 'response'),
    ];
    const result = stripOrphanedToolResults(messages);
    expect(result).toHaveLength(2);
    expect(asTestMessage(result[0]).role).toBe('user');
  });

  it('drops multiple consecutive orphaned toolResults at the head', () => {
    const messages: AgentMessage[] = [
      createToolResult('orphan-1', 'id-1'),
      createToolResult('orphan-2', 'id-2'),
      createMessage('user', 'next turn'),
    ];
    const result = stripOrphanedToolResults(messages);
    expect(result).toHaveLength(1);
    expect(asTestMessage(result[0]).role).toBe('user');
  });

  it('does not drop toolResults that appear after an assistant message', () => {
    const messages: AgentMessage[] = [
      createMessage('user', 'hello'),
      createAssistantWithToolCalls('calling', ['t1', 't2']),
      createToolResult('result-1', 't1'),
      createToolResult('result-2', 't2'),
    ];
    const result = stripOrphanedToolResults(messages);
    expect(result).toHaveLength(4);
  });

  it('returns all-toolResult array as empty', () => {
    const messages: AgentMessage[] = [createToolResult('a', 'id-a'), createToolResult('b', 'id-b')];
    const result = stripOrphanedToolResults(messages);
    expect(result).toEqual([]);
  });
});
