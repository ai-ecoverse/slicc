import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
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

  it('strips the orchestrator envelope from plain user messages', () => {
    counter = 0;
    const out = agentMessagesToChatMessages([userMsg('[May 11, 6:50 AM] User: hi', 100)], {
      idSeed: seedId,
    });
    expect(out).toEqual([
      {
        id: 'id-1',
        role: 'user',
        content: 'hi',
        timestamp: 100,
      },
    ]);
  });

  it('tags sprinkle lick messages with source=lick and channel=sprinkle', () => {
    counter = 0;
    const raw =
      '[May 11, 8:15 AM] sprinkle:welcome: [Sprinkle Event: welcome]\n```json\n{"foo":1}\n```';
    const out = agentMessagesToChatMessages([userMsg(raw, 200)], { idSeed: seedId });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].source).toBe('lick');
    expect(out[0].channel).toBe('sprinkle');
    // The inner lick body (the [Sprinkle Event: …] framing) is what
    // the chat panel feeds to the lick widget — preserve it intact.
    expect(out[0].content.startsWith('[Sprinkle Event: welcome]')).toBe(true);
  });

  it('handles upgrade lick senders with arrow-containing event names', () => {
    counter = 0;
    const raw =
      '[May 11, 9:12 AM] upgrade:2.37.0→2.38.1: [Upgrade Event: 2.37.0→2.38.1]\n\nSLICC was upgraded.';
    const out = agentMessagesToChatMessages([userMsg(raw, 300)], { idSeed: seedId });
    expect(out[0].source).toBe('lick');
    expect(out[0].channel).toBe('upgrade');
    expect(out[0].content).toBe('[Upgrade Event: 2.37.0→2.38.1]\n\nSLICC was upgraded.');
  });

  it('recognizes scoop-lifecycle channels (scoop-notify / scoop-wait)', () => {
    counter = 0;
    const out = agentMessagesToChatMessages(
      [
        userMsg('[May 11, 10:00 AM] scoop-notify:done: [@scout completed]', 400),
        userMsg('[May 11, 10:00 AM] scoop-wait:settle: [scoop_wait completed]', 401),
      ],
      { idSeed: seedId }
    );
    expect(out[0].channel).toBe('scoop-notify');
    expect(out[0].source).toBe('lick');
    expect(out[1].channel).toBe('scoop-wait');
    expect(out[1].source).toBe('lick');
  });

  it('leaves pre-envelope or unbracketed content unchanged', () => {
    counter = 0;
    const out = agentMessagesToChatMessages([userMsg('just text, no envelope', 500)], {
      idSeed: seedId,
    });
    expect(out[0].content).toBe('just text, no envelope');
    expect(out[0].source).toBeUndefined();
    expect(out[0].channel).toBeUndefined();
  });

  it('leaves an unknown sender as a plain user message (no lick tagging)', () => {
    counter = 0;
    // Bracketed envelope shape but sender is not a known lick channel.
    const out = agentMessagesToChatMessages(
      [userMsg('[May 11, 7:00 AM] cone: forwarded note', 600)],
      { idSeed: seedId }
    );
    expect(out[0].content).toBe('forwarded note');
    expect(out[0].source).toBeUndefined();
    expect(out[0].channel).toBeUndefined();
  });

  it('does not unwrap when the bracket spans a newline', () => {
    counter = 0;
    const out = agentMessagesToChatMessages(
      [userMsg('[opens here\nbut keeps going] User: bogus', 700)],
      { idSeed: seedId }
    );
    expect(out[0].content).toBe('[opens here\nbut keeps going] User: bogus');
  });

  it('parses a sender containing ": " by anchoring on the known channel prefix', () => {
    counter = 0;
    // Webhook with a user-defined name that contains ": " — this was
    // the Codex P1 / Copilot finding on PR #625: a naive
    // `indexOf(": ")` would split at the first colon-space inside the
    // eventName and corrupt the body.
    const raw =
      '[May 11, 10:00 AM] webhook:deploy: prod: [Webhook Event: deploy: prod]\n```json\n{"ok":true}\n```';
    const out = agentMessagesToChatMessages([userMsg(raw, 1000)], { idSeed: seedId });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('lick');
    expect(out[0].channel).toBe('webhook');
    expect(out[0].content.startsWith('[Webhook Event: deploy: prod]')).toBe(true);
  });

  it('splits a batched user message with multiple envelopes into separate ChatMessages', () => {
    counter = 0;
    // `processScoopQueue` joins queued ChannelMessages with `\n` before
    // calling sendPrompt, so two licks arriving between agent turns
    // end up in one AgentMessage. The chat panel must replay each
    // lick as its own widget.
    const raw =
      '[May 11, 8:15 AM] sprinkle:welcome: [Sprinkle Event: welcome]\n' +
      '```json\n{"x":1}\n```\n' +
      '[May 11, 8:16 AM] User: typed input\n' +
      '[May 11, 8:17 AM] cron:daily: [Cron Event: daily]\n' +
      '```json\n{"y":2}\n```';
    const out = agentMessagesToChatMessages([userMsg(raw, 8000)], { idSeed: seedId });
    expect(out).toHaveLength(3);
    expect(out[0].source).toBe('lick');
    expect(out[0].channel).toBe('sprinkle');
    expect(out[0].content.startsWith('[Sprinkle Event: welcome]')).toBe(true);
    expect(out[1].source).toBeUndefined();
    expect(out[1].content).toBe('typed input');
    expect(out[2].source).toBe('lick');
    expect(out[2].channel).toBe('cron');
    expect(out[2].content.startsWith('[Cron Event: daily]')).toBe(true);
    // All split parts inherit the AgentMessage's timestamp.
    expect(out.every((m) => m.timestamp === 8000)).toBe(true);
  });

  it('does not start a new envelope on an inner [Sprinkle Event: x] body line', () => {
    counter = 0;
    // The line `[Sprinkle Event: welcome]` looks bracket-shaped but is
    // not an envelope opener (it doesn't match `[…] <sender>: …`). It
    // must stay part of the previous segment's body.
    const raw = '[May 11, 8:15 AM] sprinkle:welcome: header\n[Sprinkle Event: welcome]\nmore body';
    const out = agentMessagesToChatMessages([userMsg(raw, 1)], { idSeed: seedId });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('lick');
    expect(out[0].channel).toBe('sprinkle');
    expect(out[0].content).toBe('header\n[Sprinkle Event: welcome]\nmore body');
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
