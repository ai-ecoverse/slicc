import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  ToolCall as AgentToolCall,
  AssistantMessage,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import { isLickChannel, LICK_CHANNELS, type LickChannel } from '../base/lick-channels.js';
import type { ChatMessage, ToolCall as UiToolCall } from './chat-types.js';
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

export function unwrapMessageEnvelope(text: string): { sender: string; body: string } | null {
  if (!text.startsWith('[')) return null;
  const closeBracket = text.indexOf('] ');
  if (closeBracket <= 0) return null;

  if (text.lastIndexOf('\n', closeBracket) !== -1) return null;
  const afterBracket = text.slice(closeBracket + 2);

  const userPrefix = 'User: ';
  if (afterBracket.startsWith(userPrefix)) {
    return { sender: 'User', body: afterBracket.slice(userPrefix.length) };
  }
  for (const channel of LICK_CHANNELS) {
    const channelPrefix = `${channel}:`;
    if (!afterBracket.startsWith(channelPrefix)) continue;

    const nl = afterBracket.indexOf('\n');
    const firstLineEnd = nl === -1 ? afterBracket.length : nl;
    const firstLine = afterBracket.slice(0, firstLineEnd);

    let sepIdx = -1;

    const bracketIdx = firstLine.indexOf('[', channelPrefix.length);
    if (bracketIdx > channelPrefix.length) {
      sepIdx = firstLine.lastIndexOf(': ', bracketIdx);
    }
    if (sepIdx < channelPrefix.length) {
      sepIdx = afterBracket.indexOf(': ', channelPrefix.length);
    }
    if (sepIdx < 0 || sepIdx >= firstLineEnd) continue;
    const sender = afterBracket.slice(0, sepIdx);
    const body = afterBracket.slice(sepIdx + 2);
    return { sender, body };
  }

  const nl = afterBracket.indexOf('\n');
  const firstLineEnd = nl === -1 ? afterBracket.length : nl;
  const senderEnd = afterBracket.indexOf(': ');
  if (senderEnd <= 0 || senderEnd >= firstLineEnd) return null;
  const sender = afterBracket.slice(0, senderEnd);
  if (sender.includes('\n')) return null;
  return { sender, body: afterBracket.slice(senderEnd + 2) };
}

export function splitEnvelopes(text: string): Array<{ sender: string | null; body: string }> {
  if (text.length === 0) return [];
  const lines = text.split('\n');

  if (!lines[0].startsWith('[')) return [{ sender: null, body: text }];

  type Pending = { firstLine: string; rest: string[] } | null;
  const segments: Array<{ sender: string | null; body: string }> = [];
  let cur: Pending = null;

  const flush = () => {
    if (!cur) return;
    const joined = cur.rest.length > 0 ? `${cur.firstLine}\n${cur.rest.join('\n')}` : cur.firstLine;
    const env = unwrapMessageEnvelope(joined);
    if (env) {
      segments.push({ sender: env.sender, body: env.body });
    } else {
      segments.push({ sender: null, body: joined });
    }
    cur = null;
  };

  for (const ln of lines) {
    if (ln.startsWith('[') && /^\[[^\]\n]+\] /.test(ln) && ln.includes(': ')) {
      const provisional = unwrapMessageEnvelope(ln);
      if (provisional) {
        flush();
        cur = { firstLine: ln, rest: [] };
        continue;
      }
    }
    if (cur) cur.rest.push(ln);
    else cur = { firstLine: ln, rest: [] };
  }
  flush();

  if (segments.length === 0) return [{ sender: null, body: text }];
  return segments;
}

export function lickChannelFromSenderName(sender: string): LickChannel | null {
  const colon = sender.indexOf(':');
  if (colon <= 0) return null;
  const channel = sender.slice(0, colon);
  return isLickChannel(channel) ? channel : null;
}

export function lickChannelFromBody(body: string): LickChannel | null {
  const scoopMarker = /^\[@[^\]\s]+ (completed|idle)\]/.exec(body);
  if (scoopMarker) return scoopMarker[1] === 'idle' ? 'scoop-idle' : 'scoop-notify';
  if (/^\[@[^\]\s]+ sudo-request\]/.test(body)) return 'sudo-request';
  if (/^\[scoop_wait [^\]]+\]/.test(body)) return 'scoop-wait';
  if (body.startsWith('[Session Reload]')) return 'session-reload';
  return null;
}

export function lickIdFromBody(body: string): string | undefined {
  return /^(?:Lick ID|Request ID): (\S+)/m.exec(body)?.[1];
}
