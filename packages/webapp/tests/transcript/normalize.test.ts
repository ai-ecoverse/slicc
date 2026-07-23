import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { normalizeConversations } from '../../src/transcript/normalize.js';
import { makeAgentMessages, makeTranscriptDocument, makeUsage } from './fixtures.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const messages: AgentMessage[] = [
  { role: 'user', content: 'inspect it', timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private chain' },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'cat big.txt' } },
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 20,
      output: 5,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 35,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
    },
    stopReason: 'toolUse',
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(70_000) }],
    isError: false,
    timestamp: 3,
  },
];

// ---------------------------------------------------------------------------
// Core: content ordering + reasoning exclusion (spec case from brief)
// ---------------------------------------------------------------------------

describe('normalizeConversations', () => {
  it('preserves ordered public content and excludes reasoning', () => {
    const result = normalizeConversations([{ id: 'cone', kind: 'cone', name: 'Sliccy', messages }]);
    expect(result.excludedReasoningBlocks).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private chain');
    expect(result.conversations[0].messages[1].content).toEqual([
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool-call', id: 'call-1', name: 'bash', input: { command: 'cat big.txt' } },
    ]);
    expect(result.conversations[0].messages[2].content[0]).toEqual({
      type: 'text',
      text: 'x'.repeat(70_000),
    });
  });

  // ---------------------------------------------------------------------------
  // Message IDs and sequence numbers
  // ---------------------------------------------------------------------------

  it('generates IDs using conversationId-msg-NNNNNN pattern', () => {
    const result = normalizeConversations([
      { id: 'conv-abc', kind: 'cone', name: 'Test', messages: messages.slice(0, 1) },
    ]);
    const msg = result.conversations[0].messages[0];
    expect(msg.id).toBe('conv-abc-msg-000001');
    expect(msg.sequence).toBe(1);
  });

  it('assigns monotonically increasing sequence numbers', () => {
    const result = normalizeConversations([{ id: 'conv-1', kind: 'cone', name: 'Mono', messages }]);
    const seqs = result.conversations[0].messages.map((m) => m.sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });

  // ---------------------------------------------------------------------------
  // Metadata: timestamps, model, usage, stopReason
  // ---------------------------------------------------------------------------

  it('converts numeric timestamps to ISO 8601 strings', () => {
    const result = normalizeConversations([
      {
        id: 'c1',
        kind: 'cone',
        name: 'T',
        messages: [{ role: 'user', content: 'hi', timestamp: 1_000 }],
      },
    ]);
    expect(result.conversations[0].messages[0].timestamp).toBe(new Date(1_000).toISOString());
  });

  it('includes model metadata on assistant messages', () => {
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: messages.slice(1, 2) },
    ]);
    const msg = result.conversations[0].messages[0];
    expect(msg.model).toEqual({
      provider: 'anthropic',
      id: 'claude-sonnet-4-6',
      api: 'anthropic-messages',
    });
  });

  it('includes usage on assistant messages', () => {
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: messages.slice(1, 2) },
    ]);
    const msg = result.conversations[0].messages[0];
    expect(msg.usage).toEqual({
      input: 20,
      output: 5,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 35,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
    });
  });

  it('includes stopReason on assistant messages', () => {
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: messages.slice(1, 2) },
    ]);
    expect(result.conversations[0].messages[0].stopReason).toBe('toolUse');
  });

  // ---------------------------------------------------------------------------
  // tool-result: toolCallId, isError
  // ---------------------------------------------------------------------------

  it('includes toolCallId and isError on tool-result messages', () => {
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: messages.slice(2, 3) },
    ]);
    const msg = result.conversations[0].messages[0];
    expect(msg.role).toBe('tool-result');
    expect(msg.toolCallId).toBe('call-1');
    expect(msg.isError).toBe(false);
  });

  it('marks error tool-results with isError: true', () => {
    const errMsg: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'err-call',
      toolName: 'bash',
      content: [{ type: 'text', text: 'command not found' }],
      isError: true,
      timestamp: 99,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [errMsg] },
    ]);
    expect(result.conversations[0].messages[0].isError).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // User block arrays
  // ---------------------------------------------------------------------------

  it('handles user messages with array content (text blocks)', () => {
    const userArr: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: 5,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [userArr] },
    ]);
    expect(result.conversations[0].messages[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('handles user string content (wraps in text block)', () => {
    const result = normalizeConversations([
      {
        id: 'c1',
        kind: 'cone',
        name: 'T',
        messages: [{ role: 'user', content: 'hello', timestamp: 5 }],
      },
    ]);
    expect(result.conversations[0].messages[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  // ---------------------------------------------------------------------------
  // Image blocks → attachment-ref
  // ---------------------------------------------------------------------------

  it('converts user image blocks to attachment-ref', () => {
    const imgMsg: AgentMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ],
      timestamp: 10,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [imgMsg] },
    ]);
    const content = result.conversations[0].messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'see this' });
    expect(content[1]).toMatchObject({ type: 'attachment-ref', attachmentId: expect.any(String) });
  });

  it('converts tool-result image blocks to attachment-ref', () => {
    const imgResult: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'img-call',
      toolName: 'screenshot',
      content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      isError: false,
      timestamp: 15,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [imgResult] },
    ]);
    expect(result.conversations[0].messages[0].content[0]).toMatchObject({
      type: 'attachment-ref',
      attachmentId: expect.any(String),
    });
  });

  // ---------------------------------------------------------------------------
  // Empty text blocks are dropped
  // ---------------------------------------------------------------------------

  it('drops empty text blocks from assistant content', () => {
    const assistantWithEmpty: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: '' },
        { type: 'text', text: 'real content' },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage(),
      stopReason: 'stop',
      timestamp: 20,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [assistantWithEmpty] },
    ]);
    expect(result.conversations[0].messages[0].content).toEqual([
      { type: 'text', text: 'real content' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Multiple reasoning blocks are all excluded and counted
  // ---------------------------------------------------------------------------

  it('counts all thinking blocks across the conversation', () => {
    const twoThinking: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thought 1' },
        { type: 'thinking', thinking: 'thought 2' },
        { type: 'text', text: 'answer' },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage(),
      stopReason: 'stop',
      timestamp: 25,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [twoThinking] },
    ]);
    expect(result.excludedReasoningBlocks).toBe(2);
    expect(result.conversations[0].messages[0].content).toEqual([{ type: 'text', text: 'answer' }]);
  });

  // ---------------------------------------------------------------------------
  // Source / channel: normalizer must not fabricate UI-only fields
  // ---------------------------------------------------------------------------

  it('does not fabricate source or channel fields absent from Pi message types', () => {
    // Pi AgentMessage subtypes carry no source/channel. The normalizer must
    // not invent undefined fields on any output message.
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: messages.slice(2, 3) },
    ]);
    const msg = result.conversations[0].messages[0];
    expect('source' in msg).toBe(false);
    expect('channel' in msg).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Parent conversation delegations
  // ---------------------------------------------------------------------------

  it('builds delegations for scoops with parentConversationId', () => {
    const result = normalizeConversations([
      { id: 'cone', kind: 'cone', name: 'Root', messages: [] },
      {
        id: 'scoop-1',
        kind: 'scoop',
        name: 'Child',
        parentConversationId: 'cone',
        originToolCallId: 'tool-xyz',
        messages: [],
      },
    ]);
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]).toMatchObject({
      sourceConversationId: 'cone',
      targetConversationId: 'scoop-1',
      toolCallId: 'tool-xyz',
    });
  });

  it('builds no delegations when no parentConversationId exists', () => {
    const result = normalizeConversations([
      { id: 'cone', kind: 'cone', name: 'Root', messages: [] },
    ]);
    expect(result.delegations).toHaveLength(0);
  });

  it('preserves folder on conversations', () => {
    const result = normalizeConversations([
      { id: 'c1', kind: 'scoop', name: 'Sub', folder: 'my-folder', messages: [] },
    ]);
    expect(result.conversations[0].folder).toBe('my-folder');
  });

  // ---------------------------------------------------------------------------
  // Multiple conversations: reasoning count is cumulative
  // ---------------------------------------------------------------------------

  it('sums excludedReasoningBlocks across multiple conversations', () => {
    const thinking: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'private' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage(),
      stopReason: 'stop',
      timestamp: 30,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'A', messages: [thinking] },
      { id: 'c2', kind: 'scoop', name: 'B', messages: [thinking] },
    ]);
    expect(result.excludedReasoningBlocks).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Assistant error messages
  // ---------------------------------------------------------------------------

  it('includes errorMessage on failed assistant messages', () => {
    const errAssistant: AgentMessage = {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage({ input: 0, output: 0, totalTokens: 0 }),
      stopReason: 'error',
      errorMessage: 'upstream timeout',
      timestamp: 40,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [errAssistant] },
    ]);
    expect(result.conversations[0].messages[0].error).toBe('upstream timeout');
  });

  // ---------------------------------------------------------------------------
  // Fixture helpers are self-consistent
  // ---------------------------------------------------------------------------

  it('makeAgentMessages returns messages normalizable without error', () => {
    const msgs = makeAgentMessages();
    const result = normalizeConversations([
      { id: 'test-cone', kind: 'cone', name: 'Fixture', messages: msgs },
    ]);
    expect(result.excludedReasoningBlocks).toBe(1);
    expect(result.conversations[0].messages).toHaveLength(3);
  });

  it('makeTranscriptDocument returns a valid document shape', () => {
    const doc = makeTranscriptDocument({ text: 'custom text', toolInput: { x: 1 } });
    expect(doc.schemaVersion).toBe(1);
    expect(doc.privacy.reasoningExcluded).toBe(true);
    expect(doc.conversations[0].messages[1].content[0]).toEqual({
      type: 'text',
      text: 'custom text',
    });
  });

  // ---------------------------------------------------------------------------
  // createdAt / updatedAt timing metadata forwarding
  // ---------------------------------------------------------------------------

  it('forwards createdAt from source to conversation', () => {
    const result = normalizeConversations([
      {
        id: 'c1',
        kind: 'cone',
        name: 'T',
        createdAt: '2024-01-01T00:00:00.000Z',
        messages: [],
      },
    ]);
    expect(result.conversations[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('forwards updatedAt from source to conversation', () => {
    const result = normalizeConversations([
      {
        id: 'c1',
        kind: 'cone',
        name: 'T',
        updatedAt: '2024-06-15T12:00:00.000Z',
        messages: [],
      },
    ]);
    expect(result.conversations[0].updatedAt).toBe('2024-06-15T12:00:00.000Z');
  });

  it('omits createdAt and updatedAt when absent from source', () => {
    const result = normalizeConversations([{ id: 'c1', kind: 'cone', name: 'T', messages: [] }]);
    expect('createdAt' in result.conversations[0]).toBe(false);
    expect('updatedAt' in result.conversations[0]).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Thinking-only assistant message (empty-content edge case)
  // ---------------------------------------------------------------------------

  it('produces empty content array for assistant with only thinking blocks', () => {
    const thinkingOnly: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'chain of thought' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage(),
      stopReason: 'stop',
      timestamp: 50,
    };
    const result = normalizeConversations([
      { id: 'c1', kind: 'cone', name: 'T', messages: [thinkingOnly] },
    ]);
    const msg = result.conversations[0].messages[0];
    expect(msg.content).toEqual([]);
    expect(result.excludedReasoningBlocks).toBe(1);
    expect(JSON.stringify(result)).not.toContain('chain of thought');
  });

  // ---------------------------------------------------------------------------
  // canonicalImages — assistant and tool-result image bytes
  // ---------------------------------------------------------------------------

  it('returns canonicalImages with data from assistant image blocks', () => {
    // Pi's AssistantMessage type doesn't include ImageContent in its union at the
    // TypeScript level but the runtime processes image blocks — cast needed.
    const img = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'here is the image' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage(),
      stopReason: 'stop',
      timestamp: 10,
    } as unknown as AgentMessage;
    const result = normalizeConversations([
      { id: 'conv-asst', kind: 'cone', name: 'Sliccy', messages: [img] },
    ]);
    // One attachment-ref should appear in the assistant message
    const msg = result.conversations[0].messages[0];
    const ref = msg.content.find((b) => b.type === 'attachment-ref');
    expect(ref).toBeDefined();
    const attachmentId = (ref as { type: 'attachment-ref'; attachmentId: string }).attachmentId;
    // canonicalImages must contain the bytes for this ref
    expect(result.canonicalImages).toBeDefined();
    const entry = result.canonicalImages.get(attachmentId);
    expect(entry).toBeDefined();
    expect(entry?.data).toBe('aGVsbG8=');
    expect(entry?.mimeType).toBe('image/png');
  });

  it('returns canonicalImages with data from tool-result image blocks', () => {
    // Same cast: Pi tool-result content at the TS level lacks an image union member.
    const toolResMsg = {
      role: 'toolResult',
      toolCallId: 'call-img',
      toolName: 'screenshot',
      content: [{ type: 'image', data: 'd29ybGQ=', mimeType: 'image/jpeg' }],
      isError: false,
      timestamp: 20,
    } as unknown as AgentMessage;
    const result = normalizeConversations([
      { id: 'conv-tr', kind: 'cone', name: 'Sliccy', messages: [toolResMsg] },
    ]);
    const msg = result.conversations[0].messages[0];
    const ref = msg.content.find((b) => b.type === 'attachment-ref');
    expect(ref).toBeDefined();
    const attachmentId = (ref as { type: 'attachment-ref'; attachmentId: string }).attachmentId;
    expect(result.canonicalImages).toBeDefined();
    const entry = result.canonicalImages.get(attachmentId);
    expect(entry).toBeDefined();
    expect(entry?.data).toBe('d29ybGQ=');
    expect(entry?.mimeType).toBe('image/jpeg');
  });

  it('accumulates canonicalImages across multiple conversations', () => {
    const assistantMsg = {
      role: 'assistant',
      content: [{ type: 'image', data: 'QQ==', mimeType: 'image/png' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: makeUsage(),
      stopReason: 'stop',
      timestamp: 1,
    } as unknown as AgentMessage;
    const toolMsg = {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'tool',
      content: [{ type: 'image', data: 'Qg==', mimeType: 'image/gif' }],
      isError: false,
      timestamp: 2,
    } as unknown as AgentMessage;
    const result = normalizeConversations([
      { id: 'conv-a', kind: 'cone', name: 'A', messages: [assistantMsg] },
      { id: 'conv-b', kind: 'scoop', name: 'B', messages: [toolMsg] },
    ]);
    expect(result.canonicalImages.size).toBe(2);
  });

  it('canonicalImages is empty when no non-user image blocks exist', () => {
    const result = normalizeConversations([
      {
        id: 'conv-text',
        kind: 'cone',
        name: 'T',
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      },
    ]);
    expect(result.canonicalImages.size).toBe(0);
  });
});
