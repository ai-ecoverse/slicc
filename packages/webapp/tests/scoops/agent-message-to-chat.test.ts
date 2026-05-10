import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { agentMessagesToChatMessages } from '../../src/scoops/agent-message-to-chat.js';

/**
 * Build an AgentMessage with a content array. Cast to `AgentMessage`
 * because the union also includes pi-agent-core's `CustomAgentMessages`
 * extension point — the basic shape we test here matches the public
 * pi-ai types.
 */
function userMsg(text: string, timestamp = 1): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp,
  } as AgentMessage;
}

function assistantMsg(
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  >,
  timestamp = 2
): AgentMessage {
  return {
    role: 'assistant',
    content: blocks,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  } as AgentMessage;
}

function toolResultMsg(
  toolCallId: string,
  text: string,
  isError = false,
  timestamp = 3
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError,
    timestamp,
  } as AgentMessage;
}

let counter = 0;
const seedId = (): string => `id-${++counter}`;

describe('agentMessagesToChatMessages', () => {
  it('returns an empty array for empty input', () => {
    expect(agentMessagesToChatMessages([])).toEqual([]);
  });

  it('translates a plain user/assistant exchange', () => {
    counter = 0;
    const input: AgentMessage[] = [
      userMsg('hello', 1),
      assistantMsg([{ type: 'text', text: 'hi there' }], 2),
    ];

    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out).toEqual([
      { id: 'id-1', role: 'user', content: 'hello', timestamp: 1 },
      {
        id: 'id-2',
        role: 'assistant',
        content: 'hi there',
        timestamp: 2,
        source: 'cone',
      },
    ]);
  });

  it('joins multiple text blocks into a single content string', () => {
    counter = 0;
    const input: AgentMessage[] = [
      assistantMsg(
        [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'second' },
        ],
        2
      ),
    ];

    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out[0].content).toBe('first second');
  });

  it('collapses tool calls + tool results into the assistant message', () => {
    counter = 0;
    const input: AgentMessage[] = [
      userMsg('list files', 1),
      assistantMsg(
        [
          { type: 'text', text: 'Listing now.' },
          {
            type: 'toolCall',
            id: 'tc-1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
        2
      ),
      toolResultMsg('tc-1', 'a.txt\nb.txt\n', false, 3),
    ];

    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out).toHaveLength(2);
    const assistant = out[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('Listing now.');
    expect(assistant.toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'bash',
        input: { command: 'ls' },
        result: 'a.txt\nb.txt\n',
        isError: false,
      },
    ]);
  });

  it('attaches the error flag when a tool result is an error', () => {
    counter = 0;
    const input: AgentMessage[] = [
      assistantMsg(
        [
          {
            type: 'toolCall',
            id: 'tc-fail',
            name: 'bash',
            arguments: { command: 'badcmd' },
          },
        ],
        2
      ),
      toolResultMsg('tc-fail', 'bash: badcmd: command not found', true, 3),
    ];

    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out[0].toolCalls?.[0].isError).toBe(true);
    expect(out[0].toolCalls?.[0].result).toContain('command not found');
  });

  it('passes the source label through to assistant messages', () => {
    counter = 0;
    const input: AgentMessage[] = [assistantMsg([{ type: 'text', text: 'from a scoop' }], 2)];
    const out = agentMessagesToChatMessages(input, { idSeed: seedId, source: 'todo-app' });
    expect(out[0].source).toBe('todo-app');
  });

  it('skips empty user messages', () => {
    counter = 0;
    const input: AgentMessage[] = [userMsg('', 1), assistantMsg([{ type: 'text', text: 'hi' }], 2)];
    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
  });

  it('drops orphan tool results that have no preceding tool call', () => {
    counter = 0;
    const input: AgentMessage[] = [
      userMsg('hi', 1),
      toolResultMsg('tc-orphan', 'whatever', false, 2),
    ];
    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('keeps multi-turn exchanges in order', () => {
    counter = 0;
    const input: AgentMessage[] = [
      userMsg('first', 1),
      assistantMsg([{ type: 'text', text: 'one' }], 2),
      userMsg('second', 3),
      assistantMsg([{ type: 'text', text: 'two' }], 4),
    ];
    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:first',
      'assistant:one',
      'user:second',
      'assistant:two',
    ]);
  });

  it('omits the toolCalls field entirely when there are none', () => {
    counter = 0;
    const input: AgentMessage[] = [assistantMsg([{ type: 'text', text: 'just text' }], 2)];
    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out[0]).not.toHaveProperty('toolCalls');
  });

  it('drops internal orchestration tools (send_message / list_scoops / list_tasks)', () => {
    counter = 0;
    const input: AgentMessage[] = [
      assistantMsg(
        [
          { type: 'text', text: 'thinking…' },
          { type: 'toolCall', id: 'tc-keep', name: 'bash', arguments: { command: 'ls' } },
          {
            type: 'toolCall',
            id: 'tc-hidden-1',
            name: 'send_message',
            arguments: { to: 'cone' },
          },
          { type: 'toolCall', id: 'tc-hidden-2', name: 'list_scoops', arguments: {} },
          { type: 'toolCall', id: 'tc-hidden-3', name: 'list_tasks', arguments: {} },
        ],
        2
      ),
      toolResultMsg('tc-keep', 'a.txt\n', false, 3),
      // Results for the hidden tool calls must also be skipped — they
      // have no visible target to attach to.
      toolResultMsg('tc-hidden-1', 'sent', false, 4),
      toolResultMsg('tc-hidden-2', '[]', false, 5),
    ];

    const out = agentMessagesToChatMessages(input, { idSeed: seedId });
    expect(out).toHaveLength(1);
    expect(out[0].toolCalls).toEqual([
      { id: 'tc-keep', name: 'bash', input: { command: 'ls' }, result: 'a.txt\n', isError: false },
    ]);
  });

  it('honors a custom hiddenToolNames override', () => {
    counter = 0;
    const input: AgentMessage[] = [
      assistantMsg(
        [
          { type: 'toolCall', id: 'tc-bash', name: 'bash', arguments: { command: 'ls' } },
          { type: 'toolCall', id: 'tc-x', name: 'experimental_thing', arguments: {} },
        ],
        2
      ),
    ];

    const out = agentMessagesToChatMessages(input, {
      idSeed: seedId,
      hiddenToolNames: new Set(['experimental_thing']),
    });
    expect(out[0].toolCalls?.map((t) => t.name)).toEqual(['bash']);
  });
});
