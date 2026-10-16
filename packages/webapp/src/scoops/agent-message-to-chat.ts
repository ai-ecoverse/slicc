import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  ToolCall as AgentToolCall,
  AssistantMessage,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import {
  lickChannelFromBody,
  lickChannelFromSenderName,
  lickIdFromBody,
  splitEnvelopes,
} from '../base/message-envelope.js';
import type { ChatMessage, ToolCall as UiToolCall } from './chat-types.js';

export {
  lickChannelFromBody,
  lickChannelFromSenderName,
  lickIdFromBody,
  splitEnvelopes,
  unwrapMessageEnvelope,
} from '../base/message-envelope.js';

import { HIDDEN_TOOL_NAMES } from './hidden-tools.js';
import { capTranscriptText, capTranscriptToolInput } from './transcript-limits.js';

export function agentMessagesToChatMessages(
  agentMessages: readonly AgentMessage[],
  options: {
    source?: string;
    idSeed?: () => string;
    hiddenToolNames?: ReadonlySet<string>;

    uncapped?: boolean;
  } = {}
): ChatMessage[] {
  const {
    source = 'cone',
    idSeed = defaultUid,
    hiddenToolNames = HIDDEN_TOOL_NAMES,
    uncapped = false,
  } = options;
  const out: ChatMessage[] = [];
  let lastAssistant: ChatMessage | null = null;

  const droppedToolCallIds = new Set<string>();

  for (const m of agentMessages) {
    if (isUserMessage(m)) {
      out.push(...translateUserMessage(m, idSeed));
      lastAssistant = null;
    } else if (isAssistantMessage(m)) {
      lastAssistant = translateAssistantMessage(
        m,
        source,
        idSeed,
        hiddenToolNames,
        droppedToolCallIds,
        uncapped
      );
      out.push(lastAssistant);
    } else if (isToolResultMessage(m)) {
      patchToolResult(m, lastAssistant, droppedToolCallIds, uncapped);
    }
  }

  return out;
}

function translateUserMessage(m: UserMessage, idSeed: () => string): ChatMessage[] {
  const rawText = textOf(m.content);
  if (rawText.length === 0) return [];
  const out: ChatMessage[] = [];
  for (const env of splitEnvelopes(rawText)) {
    if (env.body.length === 0 && env.sender == null) continue;
    const lickChannel =
      (env.sender ? lickChannelFromSenderName(env.sender) : null) ?? lickChannelFromBody(env.body);
    const lickId = lickChannel ? lickIdFromBody(env.body) : undefined;
    const msg: ChatMessage = {
      id: lickChannel === 'sudo-request' && lickId ? `sudo-request-${lickId}` : idSeed(),
      role: 'user',
      content: env.body,
      timestamp: m.timestamp,
    };
    if (lickChannel) {
      msg.source = 'lick';
      msg.channel = lickChannel;
      if (lickId) msg.lickId = lickId;
    }
    out.push(msg);
  }
  return out;
}

function translateAssistantMessage(
  m: AssistantMessage,
  source: string,
  idSeed: () => string,
  hiddenToolNames: ReadonlySet<string>,
  droppedToolCallIds: Set<string>,
  uncapped = false
): ChatMessage {
  const visibleToolCalls: UiToolCall[] = [];
  for (const tc of collectToolCalls(m, uncapped)) {
    if (hiddenToolNames.has(tc.name)) {
      droppedToolCallIds.add(tc.id);
    } else {
      visibleToolCalls.push(tc);
    }
  }
  const msg: ChatMessage = {
    id: idSeed(),
    role: 'assistant',
    content: textOf(m.content),
    timestamp: m.timestamp,
    source,
    model: m.model,
  };
  const { usage } = m;
  if (usage) {
    msg.usage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: {
        input: usage.cost.input,
        output: usage.cost.output,
        cacheRead: usage.cost.cacheRead,
        cacheWrite: usage.cost.cacheWrite,
        total: usage.cost.total,
      },
    };
  }
  if (visibleToolCalls.length > 0) msg.toolCalls = visibleToolCalls;
  return msg;
}

function patchToolResult(
  m: ToolResultMessage,
  lastAssistant: ChatMessage | null,
  droppedToolCallIds: ReadonlySet<string>,
  uncapped = false
): void {
  if (droppedToolCallIds.has(m.toolCallId)) return;
  const target = lastAssistant?.toolCalls?.find((tc) => tc.id === m.toolCallId);
  if (!target) return;

  const text = textOf(m.content);
  target.result = uncapped ? text : capTranscriptText(text);
  target.isError = m.isError;
}

function isUserMessage(m: Message | AgentMessage): m is UserMessage {
  return (m as { role?: string }).role === 'user';
}

function isAssistantMessage(m: Message | AgentMessage): m is AssistantMessage {
  return (m as { role?: string }).role === 'assistant';
}

function isToolResultMessage(m: Message | AgentMessage): m is ToolResultMessage {
  return (m as { role?: string }).role === 'toolResult';
}

function textOf(
  content: UserMessage['content'] | AssistantMessage['content'] | ToolResultMessage['content']
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(block.text);
  }
  return parts.join('');
}

function isTextBlock(block: unknown): block is TextContent {
  return (block as { type?: string }).type === 'text';
}

function isToolCallBlock(block: unknown): block is AgentToolCall {
  return (block as { type?: string }).type === 'toolCall';
}

function collectToolCalls(m: AssistantMessage, uncapped = false): UiToolCall[] {
  if (!Array.isArray(m.content)) return [];
  const out: UiToolCall[] = [];
  for (const block of m.content) {
    if (!isToolCallBlock(block)) continue;
    out.push({
      id: block.id,
      name: block.name,

      input: uncapped ? block.arguments : capTranscriptToolInput(block.arguments),
    });
  }
  return out;
}

function defaultUid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
