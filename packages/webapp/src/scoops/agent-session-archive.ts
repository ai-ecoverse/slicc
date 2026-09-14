import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { newAtRestState, redactArchiveText } from '../transcript/archive-redaction.js';
import { agentMessagesToChatMessages } from './agent-message-to-chat.js';
import type { ChatMessage, ToolCall } from './chat-types.js';

export interface AgentSessionArchiveInput {
  name: string;

  jid: string;

  prompt: string;

  exitCode: number;

  messages: readonly AgentMessage[];

  timestamp: string;
}

export function serializeAgentSessionArchive(input: AgentSessionArchiveInput): string {
  const chat = agentMessagesToChatMessages(input.messages, { source: input.name });
  const turns = chat.filter((m) => m.role === 'assistant').length;

  const lines: string[] = [
    `# Agent session: ${input.name}`,
    '',
    `- jid: ${input.jid}`,
    `- exit code: ${input.exitCode}`,
    `- turns: ${turns}`,
    `- messages: ${input.messages.length}`,
    `- timestamp: ${input.timestamp}`,
    '',
    '## Prompt',
    '',
    input.prompt.length > 0 ? input.prompt : '_(empty prompt)_',
    '',
    '---',
    '',
  ];

  if (chat.length === 0) {
    lines.push('_(no messages captured)_', '');
  } else {
    for (const msg of chat) {
      appendMessage(lines, msg);
    }
  }

  return redactArchiveText(lines.join('\n'), newAtRestState());
}

function appendMessage(lines: string[], msg: ChatMessage): void {
  lines.push(`## ${msg.role}`, '');
  const text = msg.content.trim();
  if (text.length > 0) lines.push(text, '');
  for (const call of msg.toolCalls ?? []) {
    appendToolCall(lines, call);
  }
}

function appendToolCall(lines: string[], call: ToolCall): void {
  lines.push(
    `### tool: ${call.name}`,
    '',
    'Input:',
    '',
    '```json',
    stringifyInput(call.input),
    '```',
    ''
  );
  if (call.result !== undefined) {
    lines.push(call.isError ? 'Result (error):' : 'Result:', '', '```', call.result, '```', '');
  }
}

function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
