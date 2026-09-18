import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLogLevel,
  LogLevel,
  resetLoggerDedupForTests,
  setLogLevel,
} from '../../src/base/logger.js';

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

type CompleteSimpleArgs = {
  systemPrompt?: string;
  messages: { content: { type: string; text: string }[] }[];
};
const mockCompleteSimple = vi.fn();

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
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
  COMPACTION_MEMORY_INSTRUCTION,
  COMPACTION_TITLE_INSTRUCTION,
  compactContext,
  createCompactContext,
  hasCompactionProgress,
  runOneOffCompactionCall,
  stripOrphanedToolResults,
} from '../../src/core/context-compaction.js';

function asTestMessage(message: AgentMessage): TestMessage {
  return message as unknown as TestMessage;
}

function firstText(message: AgentMessage): string {
  const content = asTestMessage(message).content;
  if (!Array.isArray(content)) return '';
  return content[0]?.text ?? '';
}

function createMessage(role: 'user' | 'assistant' | 'toolResult', text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text' as const, text }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

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
    expect(result).toBe(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('forces the existing compaction path when under threshold', async () => {
    const compact = createCompactContext(mockConfig);
    const baseMsg = 'x'.repeat(30_000);
    const messages = Array.from({ length: 4 }, () => createMessage('user', baseMsg));

    const result = await compact(messages, undefined, { force: true });

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(firstText(result[0])).toContain('<context-summary>');
    expect(hasCompactionProgress(messages, result)).toBe(true);
  });

  it('reports no progress for an unchanged copy', () => {
    const messages = [createMessage('user', 'Hello'), createMessage('assistant', 'Hi')];

    expect(hasCompactionProgress(messages, [...messages])).toBe(false);
  });

  it('reports progress when changed content has a larger estimate', () => {
    const messages = [createMessage('user', 'short')];
    const compacted = [createMessage('user', 'a longer natural-language summary')];

    expect(totalEstimatedTokens(compacted)).toBeGreaterThan(totalEstimatedTokens(messages));
    expect(hasCompactionProgress(messages, compacted)).toBe(true);
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

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(result.length).toBeLessThan(messages.length);
    expect(firstText(result[0])).toContain('<context-summary>');
  });

  it('elides an oversized tool result instead of summarizing it (#2011)', async () => {
    const compact = createCompactContext(mockConfig);

    const giant = createToolResult('x'.repeat(1_000_000), 'tool-1');
    const messages = [
      createMessage('user', 'inspect the app'),
      createAssistantWithToolCalls('running', ['tool-1']),
      giant,
    ];

    const result = await compact(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(hasCompactionProgress(messages, result)).toBe(true);

    expect(result.some((m) => firstText(m).includes('Tool result elided'))).toBe(true);
    expect(result.every((m) => firstText(m).length < 2000)).toBe(true);
  });

  it('force-compacts by eliding an oversized message under the normal threshold (#2012)', async () => {
    const compact = createCompactContext(mockConfig);

    const giant = createToolResult('y'.repeat(500_000), 'tool-1');
    const messages = [
      createMessage('user', 'hi'),
      createAssistantWithToolCalls('ok', ['tool-1']),
      giant,
    ];

    expect(await compact(messages)).toBe(messages);

    const result = await compact(messages, undefined, { force: true });
    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(hasCompactionProgress(messages, result)).toBe(true);
    expect(result.some((m) => firstText(m).includes('Tool result elided'))).toBe(true);
  });

  it('never serializes oversized content into the summary prompt (#2012 guard)', async () => {
    const compact = createCompactContext(mockConfig);

    const giant = createToolResult('z'.repeat(500_000), 'tool-1');
    const filler = Array.from({ length: 8 }, (_, i) =>
      createMessage('user', 'w'.repeat(100_000) + ` #${i}`)
    );
    const messages = [
      createMessage('user', 'inspect'),
      createAssistantWithToolCalls('run', ['tool-1']),
      giant,
      ...filler,
    ];

    await compact(messages);

    expect(mockCompleteSimple).toHaveBeenCalled();

    const call = mockCompleteSimple.mock.calls[0][1] as { systemPrompt?: string };
    expect(call.systemPrompt).toBeDefined();
    expect(call.systemPrompt).not.toContain('z'.repeat(1000));
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

  it('shouldExtractMemories false skips the memory call, the append, and its state (#2003)', async () => {
    const onMemoryUpdates = vi.fn();
    const onCompactionStateChange = vi.fn();
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('## Goal\ndo a thing'));

    const compact = createCompactContext({
      ...mockConfig,
      onMemoryUpdates,
      onCompactionStateChange,
      shouldExtractMemories: () => false,
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));
    await compact(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(onMemoryUpdates).not.toHaveBeenCalled();
    const states = onCompactionStateChange.mock.calls.map((c) => c[0]);
    expect(states).not.toContain('extracting-memory');
  });

  it('shouldExtractMemories is consulted per compaction — a flipped gate extracts again', async () => {
    const onMemoryUpdates = vi.fn();
    mockCompleteSimple
      .mockResolvedValueOnce(llmResponse('summary one'))
      .mockResolvedValueOnce(llmResponse('summary two'))
      .mockResolvedValueOnce(llmResponse('- a memory'));

    let extract = false;
    const compact = createCompactContext({
      ...mockConfig,
      onMemoryUpdates,
      shouldExtractMemories: () => extract,
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    await compact(messages);
    expect(onMemoryUpdates).not.toHaveBeenCalled();

    extract = true;
    await compact(messages);
    expect(onMemoryUpdates).toHaveBeenCalledOnce();
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
    expect(result).toBe(messages);
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

function totalEstimatedTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content = asTestMessage(msg).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

describe('createCompactContext hopeless branch', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 200000,
  };

  let prevLogLevel: LogLevel;

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('## Goal\nstub'));

    prevLogLevel = getLogLevel();
    setLogLevel(LogLevel.WARN);

    resetLoggerDedupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel(prevLogLevel);
  });

  it(
    'skips LLM, elides oversized toolResult, emits structured warn, ' +
      'and returns under the soft threshold',
    async () => {
      const hugeText = 'x'.repeat(4_000_000);
      const messages: AgentMessage[] = [
        createMessage('user', 'run tool'),
        createAssistantWithToolCalls('calling', ['t1']),
        createToolResult(hugeText, 't1'),
        createMessage('user', 'follow up'),
      ];

      const compact = createCompactContext(mockConfig);
      const result = await compact(messages);

      expect(mockCompleteSimple).not.toHaveBeenCalled();

      const stubs = result.filter((m) => firstText(m).includes('Tool result elided'));
      expect(stubs.length).toBeGreaterThanOrEqual(1);
      expect(firstText(stubs[0])).toMatch(
        /Tool result elided: \d+ KB, exceeds half the context window/
      );

      expect(totalEstimatedTokens(result)).toBeLessThan(200000 - 16384);

      const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls;
      const hopelessCall = warnCalls.find(
        (c) => typeof c[1] === 'string' && c[1] === 'Compaction oversized-message elision'
      );
      expect(hopelessCall).toBeDefined();
      const fields = hopelessCall![2] as Record<string, unknown>;
      expect(fields).toEqual({
        totalTokens: expect.any(Number),
        postSizeTokens: expect.any(Number),
        contextWindow: 200000,
        isHopeless: false,
        elidedCount: expect.any(Number),
        elidedBytes: expect.any(Number),
      });
      expect(fields.elidedCount as number).toBeGreaterThanOrEqual(1);
      expect(fields.elidedBytes as number).toBeGreaterThanOrEqual(1024);
    }
  );

  it('still uses the LLM summary path when only over the soft threshold', async () => {
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('summary'));
    const compact = createCompactContext(mockConfig);

    const baseMsg = 'x'.repeat(200000);
    const messages = Array.from({ length: 5 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(firstText(result[0])).toContain('<context-summary>');
  });

  it('preserves tool-call/tool-result ID pairing across elision', async () => {
    const huge = 'x'.repeat(4_000_000);
    const messages: AgentMessage[] = [
      createMessage('user', 'kick off'),
      createAssistantWithToolCalls('first', ['t1']),
      createToolResult(huge, 't1'),
      createAssistantWithToolCalls(huge, ['t2']),
      createToolResult('small ok', 't2'),
      createMessage('user', 'thanks'),
    ];

    const compact = createCompactContext(mockConfig);
    const result = await compact(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();

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

    const toolResultStubs = result.filter((m) => firstText(m).includes('Tool result elided'));
    const assistantStubs = result.filter((m) => firstText(m).includes('Assistant message elided'));
    expect(toolResultStubs.length).toBe(1);
    expect(assistantStubs.length).toBe(1);
  });

  it(
    'rewrites oversized toolCall arguments to a stub while preserving id/name ' +
      'and keeping the following toolResult pairing valid',
    async () => {
      const hugeArgValue = 'x'.repeat(4_000_000);
      const hugePreamble = 'p'.repeat(4_000_000);
      const assistantMsg = {
        role: 'assistant',
        content: [
          { type: 'text', text: hugePreamble },
          {
            type: 'toolCall',
            id: 'tc-huge',
            name: 'write_file',
            arguments: { path: '/workspace/huge.txt', content: hugeArgValue },
          },
        ],
        timestamp: 0,
      } as unknown as AgentMessage;

      const messages: AgentMessage[] = [
        createMessage('user', 'please write the file'),
        assistantMsg,
        createToolResult('ok', 'tc-huge'),
        createMessage('user', 'thanks'),
      ];

      const compact = createCompactContext(mockConfig);
      const result = await compact(messages);

      expect(mockCompleteSimple).not.toHaveBeenCalled();

      const elidedAssistant = result.find((m) => {
        const tm = asTestMessage(m);
        return (
          tm.role === 'assistant' &&
          Array.isArray(tm.content) &&
          tm.content.some((b) => b.type === 'text' && b.text?.includes('Assistant message elided'))
        );
      });
      expect(elidedAssistant).toBeDefined();
      const content = asTestMessage(elidedAssistant!).content as TestContentBlock[];
      const elidedToolCall = content.find((b) => b.type === 'toolCall');
      expect(elidedToolCall).toBeDefined();

      expect(elidedToolCall!.id).toBe('tc-huge');
      expect(elidedToolCall!.name).toBe('write_file');

      expect(elidedToolCall!.arguments).toEqual({
        elided: true,
        originalBytes: expect.any(Number),
      });
      expect(
        (elidedToolCall!.arguments as { originalBytes: number }).originalBytes
      ).toBeGreaterThan(1_000_000);

      const tr = result.find((m) => asTestMessage(m).role === 'toolResult');
      expect(tr).toBeDefined();
      expect(asTestMessage(tr!).toolCallId).toBe('tc-huge');
    }
  );

  it('honors a custom hopelessMultiplier', async () => {
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('summary'));
    const compact = createCompactContext({ ...mockConfig, hopelessMultiplier: 10 });
    const baseMsg = 'x'.repeat(400000);
    const messages = Array.from({ length: 10 }, () => createMessage('user', baseMsg));

    await compact(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });
});

describe('createCompactContext image elision (#1986)', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;

  beforeEach(() => {
    mockCompleteSimple.mockReset();
  });

  function createMessageWithImage(
    role: 'user' | 'toolResult',
    text: string,
    imageChars = 4096
  ): AgentMessage {
    return {
      role,
      ...(role === 'toolResult' ? { toolCallId: 'img-tool-1', toolName: 'test_tool' } : {}),
      content: [
        { type: 'text' as const, text },
        { type: 'image' as const, source: { data: 'A'.repeat(imageChars) } },
      ],
      timestamp: 0,
    } as unknown as AgentMessage;
  }

  function imageBlocks(message: AgentMessage): TestContentBlock[] {
    const content = asTestMessage(message).content;
    return Array.isArray(content) ? content.filter((b) => b.type === 'image') : [];
  }

  function elisionStubs(message: AgentMessage): TestContentBlock[] {
    const content = asTestMessage(message).content;
    return Array.isArray(content)
      ? content.filter((b) => b.type === 'text' && b.text?.includes('[image elided'))
      : [];
  }

  it('elides images kept BEFORE the latest user message; the latest user message keeps its image', async () => {
    mockCompleteSimple.mockResolvedValue(llmResponse('SUMMARY'));
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 2000,
      reserveTokens: 500,
      keepRecentTokens: 600,
    });

    const messages = [
      createMessage('user', 'x'.repeat(10_000)),
      createMessage('assistant', 'working on it'),
      createAssistantWithToolCalls('running tool', ['img-tool-1']),
      createMessageWithImage('toolResult', 'screenshot taken'),
      createMessageWithImage('user', 'here is my photo, use it'),
    ];

    const result = await compact(messages);

    expect(firstText(result[0])).toContain('<context-summary>');
    const keptToolResult = result.find(
      (m) => asTestMessage(m).role === 'toolResult'
    ) as AgentMessage;
    const keptUser = result[result.length - 1];

    expect(imageBlocks(keptToolResult)).toHaveLength(0);
    expect(elisionStubs(keptToolResult)).toHaveLength(1);
    expect(elisionStubs(keptToolResult)[0]?.text).toContain('~4 KB');

    expect(asTestMessage(keptUser).role).toBe('user');
    expect(imageBlocks(keptUser)).toHaveLength(1);
    expect(elisionStubs(keptUser)).toHaveLength(0);
  });

  it('progressively elides the latest user image too when the result is still over the threshold', async () => {
    mockCompleteSimple.mockResolvedValue(llmResponse('SUMMARY'));
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 2000,
      reserveTokens: 500,

      keepRecentTokens: 1900,
    });
    const messages = [
      createMessage('user', 'x'.repeat(10_000)),
      createMessage('assistant', 'y'.repeat(6_500)),
      createMessageWithImage('user', 'z'.repeat(500)),
    ];

    const result = await compact(messages);

    const keptUser = result[result.length - 1];
    expect(asTestMessage(keptUser).role).toBe('user');
    expect(imageBlocks(keptUser)).toHaveLength(0);
    expect(elisionStubs(keptUser)).toHaveLength(1);
  });

  it('naive fallback emits the fallback state and still elides kept images', async () => {
    mockCompleteSimple.mockRejectedValue(new Error('provider 500'));
    const states: string[] = [];
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 2000,
      reserveTokens: 500,
      keepRecentTokens: 600,
      onCompactionStateChange: (state) => states.push(state),
    });
    const messages = [
      createMessage('user', 'x'.repeat(10_000)),
      createMessage('assistant', 'ok'),
      createAssistantWithToolCalls('running tool', ['img-tool-1']),
      createMessageWithImage('toolResult', 'screenshot taken'),
      createMessage('user', 'and now?'),
    ];

    const result = await compact(messages);

    expect(states.indexOf('summarizing')).toBeGreaterThanOrEqual(0);
    expect(states.indexOf('fallback')).toBeGreaterThan(states.indexOf('summarizing'));
    expect(states[states.length - 1]).toBe('idle');
    expect(firstText(result[0])).toContain('compacted to save context space');
    const keptToolResult = result.find(
      (m) => asTestMessage(m).role === 'toolResult'
    ) as AgentMessage;
    expect(imageBlocks(keptToolResult)).toHaveLength(0);
    expect(elisionStubs(keptToolResult)).toHaveLength(1);
  });

  it('strips images (except the latest) when the oversized-tool-result early return fires (Codex P1 on #2013)', async () => {
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 2000,
      reserveTokens: 500,
      keepRecentTokens: 600,
    });

    const messages = [
      createMessageWithImage('user', 'earlier screenshot', 40_000),
      createAssistantWithToolCalls('running', ['big-1']),
      createToolResult('x'.repeat(20_000), 'big-1'),
      createMessageWithImage('user', 'latest screenshot', 40_000),
    ];

    const result = await compact(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();

    expect(result.some((m) => firstText(m).includes('Tool result elided'))).toBe(true);

    const users = result.filter((m) => asTestMessage(m).role === 'user');
    expect(imageBlocks(users[0])).toHaveLength(0);
    expect(imageBlocks(users[users.length - 1])).toHaveLength(1);
  });

  it('hopeless branch strips image blocks from user messages', async () => {
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 1000,
      reserveTokens: 200,
      keepRecentTokens: 200,
      hopelessMultiplier: 2,
    });

    const messages = [
      createMessageWithImage('user', 'x'.repeat(20_000)),
      createMessage('assistant', 'ack'),
      createMessageWithImage('user', 'y'.repeat(20_000)),
    ];

    const result = await compact(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();
    for (const m of result) {
      expect(imageBlocks(m)).toHaveLength(0);
    }
    const withStub = result.filter((m) => elisionStubs(m).length > 0);
    expect(withStub.length).toBeGreaterThan(0);
  });
});

describe('createCompactContext elision-only round is observable (#2843)', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('## Goal\ntesting'));
  });

  it('emits summarizing → idle when elision alone brings it under the threshold', async () => {
    const states: string[] = [];
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 200000,
      onCompactionStateChange: (state) => states.push(state),
    });

    const messages = [
      createMessage('user', 'inspect the app'),
      createAssistantWithToolCalls('running', ['tool-1']),
      createToolResult('x'.repeat(1_000_000), 'tool-1'),
    ];

    const result = await compact(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(hasCompactionProgress(messages, result)).toBe(true);

    expect(states).toEqual(['summarizing', 'idle']);
  });

  it('stays silent when nothing was compacted at all', async () => {
    const states: string[] = [];
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 200000,
      onCompactionStateChange: (state) => states.push(state),
    });

    const result = await compact([createMessage('user', 'hello')]);

    expect(result).toHaveLength(1);
    expect(states).toEqual([]);
  });
});

describe('createCompactContext abort (#2843)', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;

  const overThreshold = () => [
    createMessage('user', 'x'.repeat(10_000)),
    createMessage('assistant', 'ok'),
    createMessage('user', 'and now?'),
  ];

  const tinyWindow = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 2000,
    reserveTokens: 500,
    keepRecentTokens: 600,
  };

  beforeEach(() => {
    mockCompleteSimple.mockReset();

    mockCompleteSimple.mockRejectedValue(new Error('aborted'));
  });

  it('returns the history untouched when the signal fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const compact = createCompactContext(tinyWindow);
    const messages = overThreshold();

    const result = await compact(messages, controller.signal);

    expect(result).toBe(messages);
    expect(hasCompactionProgress(messages, result)).toBe(false);
  });

  it('emits cancelled → idle and never fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    const states: string[] = [];
    const compact = createCompactContext({
      ...tinyWindow,
      onCompactionStateChange: (state) => states.push(state),
    });

    await compact(overThreshold(), controller.signal);

    expect(states).not.toContain('fallback');
    expect(states.indexOf('cancelled')).toBeGreaterThan(states.indexOf('summarizing'));

    expect(states[states.length - 1]).toBe('idle');
  });

  it('does not claim a truncation in the returned history', async () => {
    const controller = new AbortController();
    controller.abort();
    const compact = createCompactContext(tinyWindow);

    const result = await compact(overThreshold(), controller.signal);

    expect(result.some((m) => firstText(m).includes('compacted to save context space'))).toBe(
      false
    );
  });

  it('still degrades to the naive drop when the signal did NOT fire', async () => {
    const states: string[] = [];
    const compact = createCompactContext({
      ...tinyWindow,
      onCompactionStateChange: (state) => states.push(state),
    });
    const messages = overThreshold();

    const result = await compact(messages, new AbortController().signal);

    expect(states).toContain('fallback');
    expect(states).not.toContain('cancelled');
    expect(firstText(result[0])).toContain('compacted to save context space');
  });
});

describe('createCompactContext non-destructive idle failures (#3264)', () => {
  const model = { id: 'test-model' } as unknown as Model<Api>;
  const overThreshold = () => [
    createMessage('user', 'x'.repeat(10_000)),
    createMessage('assistant', 'prior answer'),
    createMessage('user', 'recent question'),
  ];
  const baseConfig = {
    model,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 2000,
    reserveTokens: 500,
    keepRecentTokens: 600,
  };

  beforeEach(() => mockCompleteSimple.mockReset());

  it.each([
    {
      name: 'rate limit',
      error: Object.assign(new Error('Too many requests'), { status: 429 }),
      failure: 'rate-limit',
    },
    {
      name: 'exhausted quota',
      error: new Error('Weekly budget exhausted'),
      failure: 'quota-exhausted',
    },
    {
      name: 'authentication refusal',
      error: Object.assign(new Error('Unauthorized'), { status: 401 }),
      failure: 'authentication',
    },
    {
      name: 'provider outage',
      error: Object.assign(new Error('Service unavailable'), { status: 503 }),
      failure: 'provider-unavailable',
    },
  ] as const)('preserves identity and content after a $name', async ({ error, failure }) => {
    mockCompleteSimple.mockRejectedValueOnce(error);
    const states: Array<{ state: string; failure?: string }> = [];
    const snapshot = vi.fn(async () => ({ transcriptPath: '/sessions/live-cone.md' }));
    const compact = createCompactContext({
      ...baseConfig,
      onBeforeCompaction: snapshot,
      onCompactionStateChange: (state, detail) =>
        states.push({ state, ...(detail.failure ? { failure: detail.failure } : {}) }),
    });
    const messages = overThreshold();
    const before = structuredClone(messages);

    const result = await compact(messages, undefined, {
      force: true,
      trigger: 'idle',
      allowNaiveDrop: false,
    });

    expect(result).toBe(messages);
    expect(result).toEqual(before);
    expect(hasCompactionProgress(messages, result)).toBe(false);
    expect(result.some((message) => firstText(message).includes('Earlier conversation'))).toBe(
      false
    );
    expect(states.map(({ state }) => state)).toEqual(['summarizing', 'cancelled', 'idle']);
    expect(states.slice(-2)).toEqual([
      { state: 'cancelled', failure },
      { state: 'idle', failure },
    ]);
    expect(snapshot).toHaveBeenCalledWith(messages, 'idle');
  });

  it.each([
    {
      name: 'empty summary',
      response: llmResponse('   '),
      failure: 'empty-response',
    },
    {
      name: 'invalid response envelope',
      response: { stopReason: 'stop', content: 'not-an-array' },
      failure: 'invalid-response',
    },
    {
      name: 'invalid text block',
      response: { ...llmResponse('ignored'), content: [{ type: 'text', text: 42 }] },
      failure: 'invalid-response',
    },
  ] as const)('preserves history for an $name', async ({ response, failure }) => {
    mockCompleteSimple.mockResolvedValueOnce(response);
    const failures: string[] = [];
    const compact = createCompactContext({
      ...baseConfig,
      onCompactionStateChange: (state, detail) => {
        if (state === 'cancelled' && detail.failure) failures.push(detail.failure);
      },
    });
    const messages = overThreshold();

    const result = await compact(messages, undefined, {
      force: true,
      trigger: 'idle',
      allowNaiveDrop: false,
    });

    expect(result).toBe(messages);
    expect(failures).toEqual([failure]);
  });

  it('keeps the snapshot and can retry the same untouched history later', async () => {
    mockCompleteSimple
      .mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { status: 429 }))
      .mockResolvedValueOnce(llmResponse('Recovered summary'));
    const snapshot = vi.fn(async () => ({ transcriptPath: '/sessions/live-cone.md' }));
    const compact = createCompactContext({ ...baseConfig, onBeforeCompaction: snapshot });
    const messages = overThreshold();
    const options = { force: true, trigger: 'idle' as const, allowNaiveDrop: false };

    const failed = await compact(messages, undefined, options);
    const retried = await compact(failed, undefined, options);

    expect(failed).toBe(messages);
    expect(firstText(retried[0])).toContain('<context-summary>');
    expect(firstText(retried[0])).toContain('/sessions/live-cone.md');
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('leaves overflow recovery on the emergency naive-drop policy', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('provider unavailable'));
    const states: string[] = [];
    const compact = createCompactContext({
      ...baseConfig,
      onCompactionStateChange: (state) => states.push(state),
    });
    const messages = overThreshold();

    const result = await compact(messages, undefined, { force: true, trigger: 'overflow' });

    expect(result).not.toBe(messages);
    expect(firstText(result[0])).toContain('Earlier conversation');
    expect(states).toContain('fallback');
  });

  it('preserves history when idle has no API key', async () => {
    const failures: string[] = [];
    const compact = createCompactContext({
      ...baseConfig,
      getApiKey: () => undefined,
      onCompactionStateChange: (state, detail) => {
        if (state === 'cancelled' && detail.failure) failures.push(detail.failure);
      },
    });
    const messages = overThreshold();

    const result = await compact(messages, undefined, {
      force: true,
      trigger: 'idle',
      allowNaiveDrop: false,
    });

    expect(result).toBe(messages);
    expect(failures).toEqual(['authentication']);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('skips destructive hopeless elision when idle forbids naive drop', async () => {
    const failures: string[] = [];
    const compact = createCompactContext({
      ...baseConfig,
      contextWindow: 2000,
      hopelessMultiplier: 2,
      onCompactionStateChange: (state, detail) => {
        if (state === 'cancelled' && detail.failure) failures.push(detail.failure);
      },
    });

    const messages = [
      createMessage('user', 'x'.repeat(50_000)),
      createMessage('assistant', 'y'.repeat(50_000)),
      createMessage('user', 'recent'),
    ];

    const result = await compact(messages, undefined, {
      force: true,
      trigger: 'idle',
      allowNaiveDrop: false,
    });

    expect(result).toBe(messages);
    expect(failures).toEqual(['context-too-large']);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });
});
