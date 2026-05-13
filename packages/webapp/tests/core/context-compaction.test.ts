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

/**
 * The compaction module now drives both LLM calls through pi-ai's
 * `completeSimple` directly (so the conversation can be embedded in the
 * system prompt and Anthropic prompt caching can hit the prefix on the
 * second call). Each test controls per-call responses via `mockResponses`.
 */
type CompleteSimpleArgs = {
  systemPrompt?: string;
  messages: { content: { type: string; text: string }[] }[];
};
const mockCompleteSimple = vi.fn();

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
  };
});

vi.mock('@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', () => ({
  estimateTokens: (msg: TestMessage) => {
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
  runOneOffCompactionCall,
  COMPACTION_MEMORY_INSTRUCTION,
  COMPACTION_TITLE_INSTRUCTION,
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

/** Build a `completeSimple` response shape with a single text content block. */
function llmResponse(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    timestamp: 0,
  };
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
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    expect(result.length).toBeLessThan(messages.length);
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
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('## Goal\ntesting\n\n## Progress\ndone'));
  });

  it('returns messages unchanged when under threshold', async () => {
    const compact = createCompactContext(mockConfig);
    const messages = [createMessage('user', 'Hello'), createMessage('assistant', 'Hi')];

    const result = await compact(messages);
    expect(result).toEqual(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('returns empty array for empty input', async () => {
    const compact = createCompactContext(mockConfig);
    const result = await compact([]);
    expect(result).toEqual([]);
  });

  it('calls completeSimple once when threshold exceeded (no memory callback)', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    // One call: summary only. No memory callback was wired.
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(result.length).toBeLessThan(messages.length);
    expect(firstText(result[0])).toContain('<context-summary>');
  });

  it('calls completeSimple twice when onMemoryUpdates wired', async () => {
    const onMemoryUpdates = vi.fn();
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('## Goal\ndo a thing'))
      .mockResolvedValueOnce(llmResponse('- user prefers vim\n- project uses ESM'));

    const compact = createCompactContext({ ...mockConfig, onMemoryUpdates });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
    expect(onMemoryUpdates).toHaveBeenCalledOnce();
    expect(onMemoryUpdates.mock.calls[0][0]).toContain('user prefers vim');
  });

  it('emits compaction lifecycle states in order, ending with idle', async () => {
    const onMemoryUpdates = vi.fn();
    const onCompactionStateChange = vi.fn();
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('summary'))
      .mockResolvedValueOnce(llmResponse('- a memory'));

    const compact = createCompactContext({
      ...mockConfig,
      onMemoryUpdates,
      onCompactionStateChange,
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));
    await compact(messages);

    const states = onCompactionStateChange.mock.calls.map((c) => c[0]);
    expect(states).toEqual(['summarizing', 'extracting-memory', 'idle']);
  });

  it('skips the extracting-memory state when onMemoryUpdates is not wired', async () => {
    const onCompactionStateChange = vi.fn();
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('summary'));
    const compact = createCompactContext({ ...mockConfig, onCompactionStateChange });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));
    await compact(messages);
    expect(onCompactionStateChange.mock.calls.map((c) => c[0])).toEqual(['summarizing', 'idle']);
  });

  it('emits idle even when the summary call fails (fallback path)', async () => {
    const onCompactionStateChange = vi.fn();
    mockCompleteSimple.mockRejectedValueOnce(new Error('boom'));
    const compact = createCompactContext({ ...mockConfig, onCompactionStateChange });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));
    await compact(messages);
    // Whatever else fired, the LAST emission must be 'idle' so the UI
    // never gets stuck showing the ghost bubble.
    const states = onCompactionStateChange.mock.calls.map((c) => c[0]);
    expect(states[states.length - 1]).toBe('idle');
  });

  it('summary and memory calls share an identical system prompt (prefix-cache invariant)', async () => {
    const onMemoryUpdates = vi.fn();
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('summary text'))
      .mockResolvedValueOnce(llmResponse('- a memory'));

    const compact = createCompactContext({ ...mockConfig, onMemoryUpdates });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    const [, ctx1] = mockCompleteSimple.mock.calls[0] as [unknown, CompleteSimpleArgs];
    const [, ctx2] = mockCompleteSimple.mock.calls[1] as [unknown, CompleteSimpleArgs];
    expect(ctx1.systemPrompt).toBeTruthy();
    expect(ctx2.systemPrompt).toBe(ctx1.systemPrompt);
    // Sanity: instructions differ between the two calls.
    expect(ctx1.messages[0].content[0].text).not.toBe(ctx2.messages[0].content[0].text);
    expect(ctx2.messages[0].content[0].text).toBe(COMPACTION_MEMORY_INSTRUCTION);
  });

  it('skips memory callback when LLM returns NONE', async () => {
    const onMemoryUpdates = vi.fn();
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('summary'))
      .mockResolvedValueOnce(llmResponse('NONE'));

    const compact = createCompactContext({ ...mockConfig, onMemoryUpdates });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
    expect(onMemoryUpdates).not.toHaveBeenCalled();
  });

  it('memory call failure does not block compaction', async () => {
    const onMemoryUpdates = vi.fn();
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('summary'))
      .mockRejectedValueOnce(new Error('memory call exploded'));

    const compact = createCompactContext({ ...mockConfig, onMemoryUpdates });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    // Summary still applied — first message is the context-summary wrapper.
    expect(firstText(result[0])).toContain('<context-summary>');
    expect(onMemoryUpdates).not.toHaveBeenCalled();
  });

  it('memory callback throwing does not break compaction', async () => {
    const onMemoryUpdates = vi.fn().mockRejectedValue(new Error('vfs write failed'));
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('summary'))
      .mockResolvedValueOnce(llmResponse('- a memory'));

    const compact = createCompactContext({ ...mockConfig, onMemoryUpdates });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);
    expect(firstText(result[0])).toContain('<context-summary>');
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
    const lastMsg = result[result.length - 1];
    expect(firstText(lastMsg)).toBe('recent-2');
  });

  it('falls back to naive drop when summary call fails', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('API error'));

    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);
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
    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(result.length).toBeLessThan(messages.length);
    expect(firstText(result[0])).toContain('Earlier conversation');
  });

  it('forwards configured headers to completeSimple', async () => {
    const compact = createCompactContext({
      ...mockConfig,
      headers: { 'X-Session-Id': 'cone_42/abcd1234' },
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);

    const opts = mockCompleteSimple.mock.calls[0][2] as { headers?: Record<string, string> };
    expect(opts.headers).toEqual({ 'X-Session-Id': 'cone_42/abcd1234' });
  });

  it('wraps summary in context-summary tags', async () => {
    const compact = createCompactContext(mockConfig);
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('## Goal\nsome work'));
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);
    const summaryText = firstText(result[0]);
    expect(summaryText).toMatch(/^<context-summary>\n/);
    expect(summaryText).toMatch(/\n<\/context-summary>$/);
  });

  it('returns messages unchanged when single message exceeds window (no valid cut)', async () => {
    const compact = createCompactContext(mockConfig);
    const hugeMsg = 'x'.repeat(800000);
    const messages = [createMessage('user', hugeMsg)];

    const result = await compact(messages);
    expect(result).toEqual(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('walk-back guard keeps assistant+toolResult pair together across the cut', async () => {
    // Verifies the walk-back guard: when the naive cut would land on a
    // toolResult, cutIndex is walked back to include the preceding
    // assistant, so the kept slice never starts with an orphaned
    // toolResult. `stripOrphanedToolResults` is a no-op here — the
    // guard is what makes this pass.
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

    expect(asTestMessage(result[0]).role).not.toBe('toolResult');
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
    const largeResult = 'x'.repeat(40000);
    const messages = [
      createMessage('user', 'run tool'),
      createAssistantWithToolCalls('calling tool', ['t1']),
      createToolResult(largeResult, 't1'),
      createMessage('user', 'thanks'),
    ];

    const result = await compact(messages);
    expect(result).toEqual(messages);
    expect(firstText(result[2])).toBe(largeResult);
  });

  it('passes abort signal to completeSimple', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));
    const controller = new AbortController();

    await compact(messages, controller.signal);

    const opts = mockCompleteSimple.mock.calls[0][2] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
  });
});

describe('runOneOffCompactionCall', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;

  beforeEach(() => {
    mockCompleteSimple.mockReset();
  });

  it('returns the LLM response trimmed', async () => {
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('  My Session Title  '));
    const result = await runOneOffCompactionCall({
      messages: [createMessage('user', 'hello'), createMessage('assistant', 'hi')],
      instruction: COMPACTION_TITLE_INSTRUCTION,
      model: mockModel,
      apiKey: 'k',
      maxTokens: 20,
    });
    expect(result).toBe('My Session Title');
  });

  it('forwards headers and signal', async () => {
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('title'));
    const controller = new AbortController();
    await runOneOffCompactionCall({
      messages: [createMessage('user', 'hello')],
      instruction: 'title please',
      model: mockModel,
      apiKey: 'k',
      maxTokens: 20,
      headers: { 'X-Session-Id': 'abc' },
      signal: controller.signal,
    });
    const opts = mockCompleteSimple.mock.calls[0][2] as {
      headers?: Record<string, string>;
      signal?: AbortSignal;
    };
    expect(opts.headers).toEqual({ 'X-Session-Id': 'abc' });
    expect(opts.signal).toBe(controller.signal);
  });

  it('throws when stopReason is error', async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      ...llmResponse(''),
      stopReason: 'error',
      errorMessage: 'rate limited',
    });
    await expect(
      runOneOffCompactionCall({
        messages: [createMessage('user', 'hi')],
        instruction: 'do',
        model: mockModel,
        apiKey: 'k',
        maxTokens: 20,
      })
    ).rejects.toThrow(/rate limited/);
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
