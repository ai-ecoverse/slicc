/**
 * Small, human-readable markdown serializer for a spawned agent's session
 * transcript. Written to disk on spawn completion (see
 * `agent-bridge.ts`'s `writeAgentSessionArchive`) for later human analysis —
 * NOT a machine-reload format, and it deliberately does not touch
 * `/sessions/index.json`.
 *
 * It reuses {@link agentMessagesToChatMessages} (same `scoops/` layer) to
 * collapse the `AgentMessage[]` tool-call/result pairing into the flat
 * `ChatMessage` shape, then renders each message as `## <role>` + its text
 * with tool calls and results summarized. It imports nothing from `ui/` or
 * `transcript/` — those are layer back-edges from `scoops/` (the
 * session-freezer's `formatArchiveAsMarkdown` lives in `ui/`, so it is
 * intentionally NOT used here).
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { agentMessagesToChatMessages } from './agent-message-to-chat.js';
import type { ChatMessage, ToolCall } from './chat-types.js';

/** Inputs to {@link serializeAgentSessionArchive}. */
export interface AgentSessionArchiveInput {
  /** Agent name token, e.g. `memory-curator` or `zesty-custard`. */
  name: string;
  /** Full jid, e.g. `agent_memory_curator`. */
  jid: string;
  /** Prompt the agent was spawned with. */
  prompt: string;
  /** Final exit code (0 = success, non-zero = failure). */
  exitCode: number;
  /**
   * Canonical agent history (`ScoopContext.getAgentMessages()`). May be
   * empty when the context was already gone by the time the archive is
   * written — the header still renders.
   */
  messages: readonly AgentMessage[];
  /** Archive timestamp, already filename-safe (ISO with `:`/`.` → `-`). */
  timestamp: string;
}

/**
 * Render an {@link AgentSessionArchiveInput} to a markdown document: a short
 * header (name, jid, prompt, exit code, turn/message counts, timestamp)
 * followed by each message as `## <role>` + text with tool calls summarized.
 */
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

  return lines.join('\n');
}

/** Render one flattened chat message (`## <role>` + text + tool calls). */
function appendMessage(lines: string[], msg: ChatMessage): void {
  lines.push(`## ${msg.role}`, '');
  const text = msg.content.trim();
  if (text.length > 0) lines.push(text, '');
  for (const call of msg.toolCalls ?? []) {
    appendToolCall(lines, call);
  }
}

/** Summarize a single tool call and its result, readably. */
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

/** Best-effort JSON pretty-print; falls back to `String()` on a cycle. */
function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
