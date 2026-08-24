/**
 * Historical-schema fixtures for the canonical conversation migration
 * (#2275).
 *
 * These are shapes that EXIST in real profiles, not tidy synthetic ones:
 * string timestamps from the earliest `agent-sessions` writes, tool calls
 * spread over an assistant message and a sibling `toolResult`, batched lick
 * envelopes, a `browser-coding-agent` chat session for a unit whose Pi
 * history never existed, a record from a unit saved before `parentJid`, and
 * the two failure modes the #2006 sidecar incident taught us to survive: a
 * read that throws, and a payload whose shape is a lie.
 */

import type { AgentMessage } from '../../../src/core/index.js';
import type { ChatMessage } from '../../../src/scoops/chat-types.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';

/**
 * A unit record as saved BEFORE `parentJid` existed: the deleted `isCone` /
 * `type` fields are the only role signal, and `parentJid` is absent from the
 * object entirely. Cast because the current type requires the edge — that is
 * the point of the fixture.
 */
export function preParentJidRecord(): RegisteredScoop {
  return {
    jid: 'cone_legacy',
    name: 'Cone',
    folder: 'cone',
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-01-04T10:00:00.000Z',
    isCone: true,
    type: 'cone',
  } as unknown as RegisteredScoop;
}

/** A plain user turn with an ISO-string timestamp (the earliest writes). */
export function legacyAgentMessages(): AgentMessage[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'ship the release' }],
      timestamp: '2026-01-04T10:00:01.000Z',
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading the changelog' },
        { type: 'toolCall', id: 'call_1', name: 'read_file', arguments: { path: '/CHANGELOG.md' } },
      ],
      model: 'claude-opus-4-6',
      timestamp: '2026-01-04T10:00:02.000Z',
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: '# 1.0.0' }],
      isError: false,
      timestamp: '2026-01-04T10:00:03.000Z',
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'released' }],
      model: 'claude-opus-4-6',
      timestamp: '2026-01-04T10:00:04.000Z',
    },
  ] as unknown as AgentMessage[];
}

/**
 * A user message carrying TWO lick envelopes batched into one prompt (the
 * orchestrator joins queued channel messages before sending), plus a child's
 * completion notice with no channel prefix at all — the body marker is the
 * only signal there is.
 */
export function lickAgentMessages(): AgentMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            '[10:00] webhook:deploy: [Webhook Event: deploy] payload one\n' +
            '[10:01] cron:nightly: [Cron Event: nightly] payload two',
        },
      ],
      timestamp: 1_767_520_800_000,
    },
    {
      role: 'user',
      content: [{ type: 'text', text: '[10:02] reviewer: [@reviewer completed] found two bugs' }],
      timestamp: 1_767_520_920_000,
    },
  ] as unknown as AgentMessage[];
}

/**
 * A `browser-coding-agent` chat session for a unit with no Pi history —
 * an old profile whose `agent-sessions` entry was lost. The rendered
 * transcript is all that is left of the conversation.
 */
export function legacyChatMessages(): ChatMessage[] {
  return [
    { id: 'm1', role: 'user', content: 'what changed?', timestamp: 1_767_520_800_000 },
    {
      id: 'm2',
      role: 'assistant',
      content: 'two files',
      source: 'cone',
      model: 'claude-opus-4-6',
      timestamp: 1_767_520_801_000,
      toolCalls: [
        {
          id: 'call_9',
          name: 'bash',
          input: { command: 'git diff' },
          result: 'ok',
          isError: false,
        },
      ],
    },
    {
      id: 'm3',
      role: 'user',
      content: '[Webhook Event: deploy] shipped',
      source: 'lick',
      channel: 'webhook',
      timestamp: 1_767_520_802_000,
    },
  ] as unknown as ChatMessage[];
}

/**
 * The #2006 lesson in two shapes. A store read that REJECTS (the poisoned
 * sidecar's `EISDIR`-class failure) and a payload whose `messages` is not an
 * array (a truncated / half-written record). Neither may take the boot down,
 * and neither may be deleted — a later build has to be able to repair it.
 */
export const POISONED_READ_ERROR = 'EISDIR: illegal operation on a directory';

export function poisonedAgentSession(): { messages: AgentMessage[]; createdAt?: number } {
  return { messages: 'not-an-array' as unknown as AgentMessage[], createdAt: 1 };
}
