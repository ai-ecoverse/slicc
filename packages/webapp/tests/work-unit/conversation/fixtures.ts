import type { AgentMessage } from '../../../src/core/index.js';
import type { ChatMessage } from '../../../src/scoops/chat-types.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';

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

export const POISONED_READ_ERROR = 'EISDIR: illegal operation on a directory';

export function poisonedAgentSession(): { messages: AgentMessage[]; createdAt?: number } {
  return { messages: 'not-an-array' as unknown as AgentMessage[], createdAt: 1 };
}
