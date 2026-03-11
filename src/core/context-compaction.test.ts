import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { compactContext, MAX_RESULT_CHARS, MAX_CONTEXT_CHARS } from './context-compaction.js';

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

describe('compactContext', () => {
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

  it('truncates tool result content over 8000 chars', async () => {
    const longText = 'x'.repeat(MAX_RESULT_CHARS + 100);
    const messages = [createToolResult(longText)];
    const result = await compactContext(messages);

    expect(result).toHaveLength(1);
    expect((result[0].content as any)[0].text).toHaveLength(MAX_RESULT_CHARS + '\n... (truncated)'.length);
    expect((result[0].content as any)[0].text).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('does not truncate tool result content under 8000 chars', async () => {
    const text = 'x'.repeat(MAX_RESULT_CHARS - 100);
    const messages = [createToolResult(text)];
    const result = await compactContext(messages);

    expect(result).toHaveLength(1);
    expect((result[0].content as any)[0].text).toBe(text);
  });

  it('does not truncate non-toolResult messages regardless of size', async () => {
    const longText = 'x'.repeat(MAX_RESULT_CHARS + 100);
    const messages = [createMessage('user', longText), createMessage('assistant', longText)];
    const result = await compactContext(messages);

    expect(result).toHaveLength(2);
    expect((result[0].content as any)[0].text).toBe(longText);
    expect((result[1].content as any)[0].text).toBe(longText);
  });

  it('handles toolResult messages with multiple content blocks', async () => {
    const msg = {
      role: 'toolResult',
      content: [
        { type: 'text' as const, text: 'x'.repeat(MAX_RESULT_CHARS + 50) },
        { type: 'text' as const, text: 'y'.repeat(MAX_RESULT_CHARS + 100) },
      ],
    } as any;
    const result = await compactContext([msg]);

    expect(result).toHaveLength(1);
    const content = result[0].content as any;
    expect(content[0].text).toMatch(/\n\.\.\. \(truncated\)$/);
    expect(content[0].text.length).toBe(MAX_RESULT_CHARS + '\n... (truncated)'.length);
    expect(content[1].text).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('preserves messages with empty content array', async () => {
    const msg = { role: 'user' as const, content: [] } as any;
    const result = await compactContext([msg, createMessage('assistant', 'response')]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(msg);
  });

  it('preserves messages with non-text content types', async () => {
    const msg = {
      role: 'toolResult' as const,
      content: [
        { type: 'image', data: 'some-image-data' },
        { type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS + 100) },
      ],
    } as any;
    const result = await compactContext([msg]);

    expect(result).toHaveLength(1);
    const content = result[0].content as any;
    expect(content[0]).toEqual({ type: 'image', data: 'some-image-data' });
    expect(content[1].text).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('preserves first 2 messages when compacting', async () => {
    // Create messages that together exceed MAX_CONTEXT_CHARS
    // Each message is ~70K chars when serialized
    const baseMsg = 'x'.repeat(65000);
    const messages = [
      createMessage('user', baseMsg), // message 0 - preserved
      createMessage('assistant', baseMsg), // message 1 - preserved
      createMessage('user', baseMsg), // message 2 - will be dropped
      createMessage('assistant', baseMsg), // message 3 - will be dropped
      createMessage('user', baseMsg), // message 4 - will be dropped
      createMessage('user', baseMsg), // message 5 - will be dropped
      createMessage('user', baseMsg), // message 6 - will be dropped
      createMessage('user', baseMsg), // message 7 - will be dropped
      createMessage('user', baseMsg), // message 8 - will be dropped
      createMessage('user', baseMsg), // message 9 - will be dropped
      createMessage('user', baseMsg), // message 10 - will be dropped
      createMessage('user', baseMsg), // message 11 - will be dropped
      createMessage('user', baseMsg), // message 12 - preserved (last 10)
    ];

    const result = await compactContext(messages);

    // Should preserve messages 0, 1, and the last 10
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });

  it('preserves last 10 messages when compacting', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 20 }, (_, i) => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    // Last 10 messages should be preserved
    const lastTenInResult = result.slice(-10);
    expect(lastTenInResult).toEqual(messages.slice(-10));
  });

  it('inserts compaction marker between preserved ranges', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 20 }, (_, i) => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    // Find the compaction marker
    const markerIdx = result.findIndex(
      (msg) => msg.role === 'user' && (msg.content as any)[0]?.text?.includes('Earlier conversation'),
    );
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBe(2); // After first 2 messages
  });

  it('compaction marker has correct role and content', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 20 }, (_, i) => createMessage('user', baseMsg));

    const result = await compactContext(messages);

    const marker = result.find(
      (msg) => msg.role === 'user' && (msg.content as any)[0]?.text?.includes('Earlier conversation'),
    );
    expect(marker).toBeDefined();
    expect(marker!.role).toBe('user');
    expect((marker!.content as any)[0].type).toBe('text');
    expect((marker!.content as any)[0].text).toBe('[Earlier conversation messages were compacted to save context space]');
  });

  it('does not drop messages when total size is under limit', async () => {
    const messages = [
      createMessage('user', 'Short message 1'),
      createMessage('assistant', 'Short message 2'),
      createMessage('user', 'Short message 3'),
      createMessage('assistant', 'Short message 4'),
    ];

    const result = await compactContext(messages);
    expect(result).toEqual(messages);
  });

  it('handles single large message gracefully', async () => {
    const hugeMsg = 'x'.repeat(MAX_CONTEXT_CHARS + 100000);
    const messages = [createMessage('user', hugeMsg)];

    const result = await compactContext(messages);

    // Should at least preserve first message
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toEqual(messages[0]);
  });

  it('truncates multiple oversized tool results in sequence', async () => {
    const longText = 'x'.repeat(MAX_RESULT_CHARS + 100);
    const messages = [createToolResult(longText), createMessage('user', 'foo'), createToolResult(longText)];

    const result = await compactContext(messages);

    expect(result).toHaveLength(3);
    expect((result[0].content as any)[0].text).toMatch(/\n\.\.\. \(truncated\)$/);
    expect((result[2].content as any)[0].text).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('preserves exact text content before truncation point', async () => {
    const text = 'abc'.repeat(3000) + 'DEF'; // 9003 chars
    const messages = [createToolResult(text)];
    const result = await compactContext(messages);

    const resultText = (result[0].content as any)[0].text;
    expect(resultText).toContain('abc'.repeat(2666));
    expect(resultText).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('handles messages with undefined text gracefully', async () => {
    const msg = {
      role: 'toolResult' as const,
      content: [
        { type: 'text' as const, text: undefined },
        { type: 'text' as const, text: 'x'.repeat(MAX_RESULT_CHARS + 100) },
      ],
    } as any;
    const result = await compactContext([msg]);

    expect(result).toHaveLength(1);
    const content = result[0].content as any;
    expect(content[0].text).toBeUndefined();
    expect(content[1].text).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('handles messages with null text gracefully', async () => {
    const msg = {
      role: 'toolResult' as const,
      content: [
        { type: 'text' as const, text: null },
        { type: 'text' as const, text: 'x'.repeat(MAX_RESULT_CHARS + 100) },
      ],
    } as any;
    const result = await compactContext([msg]);

    expect(result).toHaveLength(1);
    const content = result[0].content as any;
    expect(content[0].text).toBeNull();
    expect(content[1].text).toMatch(/\n\.\.\. \(truncated\)$/);
  });

  it('exactly preserves the boundary at MAX_RESULT_CHARS', async () => {
    const text = 'x'.repeat(MAX_RESULT_CHARS);
    const messages = [createToolResult(text)];
    const result = await compactContext(messages);

    // Exactly at boundary should not be truncated
    expect((result[0].content as any)[0].text).toBe(text);
  });

  it('truncates at exactly MAX_RESULT_CHARS + 1', async () => {
    const text = 'x'.repeat(MAX_RESULT_CHARS + 1);
    const messages = [createToolResult(text)];
    const result = await compactContext(messages);

    expect((result[0].content as any)[0].text).toHaveLength(MAX_RESULT_CHARS + '\n... (truncated)'.length);
  });

  it('maintains message order after compaction', async () => {
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 20 }, (_, i) => createMessage('user', `message-${i}`));

    const result = await compactContext(messages);

    // Check that preserved messages are in correct order
    const firstMsg = result[0];
    const lastMsg = result[result.length - 1];
    expect((firstMsg.content as any)[0].text).toContain('message-0');
    expect((lastMsg.content as any)[0].text).toContain('message-19');
  });

  it('never splits assistant+toolResult pairs when compacting', async () => {
    // Reproduce the bug: compaction drops the assistant message with tool_use
    // but keeps the orphaned toolResult, causing API error:
    // "unexpected tool_use_id found in tool_result blocks"
    const baseMsg = 'x'.repeat(65000);
    const messages: AgentMessage[] = [
      createMessage('user', baseMsg),                                    // 0 - preserved (first 2)
      createMessage('assistant', baseMsg),                               // 1 - preserved (first 2)
      createMessage('user', baseMsg),                                    // 2 - droppable
      createMessage('assistant', baseMsg),                               // 3 - droppable
      createMessage('user', baseMsg),                                    // 4 - droppable
      createMessage('assistant', baseMsg),                               // 5 - droppable
      createMessage('user', baseMsg),                                    // 6 - droppable
      createMessage('assistant', baseMsg),                               // 7 - droppable
      createMessage('user', baseMsg),                                    // 8 - droppable
      createAssistantWithToolCalls(baseMsg, ['tool-a', 'tool-b']),       // 9 - has tool calls
      createToolResult(baseMsg, 'tool-a'),                               // 10 - must stay with 9
      createToolResult(baseMsg, 'tool-b'),                               // 11 - must stay with 9
      createMessage('user', 'follow up'),                                // 12
      createMessage('assistant', 'response'),                            // 13
    ];

    const result = await compactContext(messages);

    // Verify: every toolResult must have a preceding assistant with matching toolCall
    for (let i = 0; i < result.length; i++) {
      const msg = result[i] as any;
      if (msg.role === 'toolResult' && msg.toolCallId) {
        // Find the preceding assistant message
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = result[j] as any;
          if (prev.role === 'assistant' && Array.isArray(prev.content)) {
            const hasToolCall = prev.content.some(
              (c: any) => c.type === 'toolCall' && c.id === msg.toolCallId,
            );
            if (hasToolCall) { found = true; break; }
          }
          // Stop searching at non-toolResult, non-assistant boundaries
          if (prev.role !== 'toolResult') break;
        }
        expect(found).toBe(true);
      }
    }
  });

  it('keeps toolResult with its assistant when at compaction boundary', async () => {
    // The "last 10" boundary might land on a toolResult — compaction must
    // include the assistant message too
    const baseMsg = 'x'.repeat(65000);
    const messages: AgentMessage[] = [
      createMessage('user', baseMsg),                                    // 0
      createMessage('assistant', baseMsg),                               // 1
      createMessage('user', baseMsg),                                    // 2
      createMessage('assistant', baseMsg),                               // 3
      createAssistantWithToolCalls(baseMsg, ['t1']),                     // 4 - tool call
      createToolResult(baseMsg, 't1'),                                   // 5 - result
      createMessage('user', baseMsg),                                    // 6
      createMessage('assistant', baseMsg),                               // 7
      createMessage('user', baseMsg),                                    // 8
      createMessage('assistant', baseMsg),                               // 9
      createMessage('user', baseMsg),                                    // 10
      createMessage('assistant', baseMsg),                               // 11
      createMessage('user', baseMsg),                                    // 12
      createMessage('assistant', baseMsg),                               // 13
    ];

    const result = await compactContext(messages);

    // If toolResult 't1' is in the result, its assistant must also be present
    const hasToolResult = result.some((m: any) => m.toolCallId === 't1');
    if (hasToolResult) {
      const hasMatchingAssistant = result.some(
        (m: any) => m.role === 'assistant' && m.content?.some?.((c: any) => c.type === 'toolCall' && c.id === 't1'),
      );
      expect(hasMatchingAssistant).toBe(true);
    }
  });

  it('does not modify input messages array', async () => {
    const longText = 'x'.repeat(MAX_RESULT_CHARS + 100);
    const messages = [createToolResult(longText), createMessage('user', 'hello')];
    const originalFirstText = (messages[0].content as any)[0].text;

    await compactContext(messages);

    expect((messages[0].content as any)[0].text).toBe(originalFirstText);
  });
});
