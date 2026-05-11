/**
 * Translate `AgentMessage[]` (the canonical agent conversation kept by
 * each `ScoopContext`) into the `ChatMessage[]` shape the UI chat
 * panel renders. Used by the kernel-host's request-scoop-messages
 * handler so the panel can rebuild from the live agent state instead
 * of the UI's own (potentially stale) `browser-coding-agent` IDB.
 *
 * The two shapes diverge in how they encode tool use:
 *
 *  - `AgentMessage` keeps `toolCall` blocks inside an `assistant`
 *    message's `content` array, and pairs them with sibling
 *    `role: 'toolResult'` messages.
 *
 *  - `ChatMessage` flattens this: a single `assistant` message owns a
 *    `toolCalls: ToolCall[]` array where each entry already carries
 *    its `result` and `isError`.
 *
 * The translator collapses the agent shape into the UI shape by
 * walking the array left→right. Subsequent `toolResult` messages
 * patch their result back onto the matching tool call inside the
 * preceding assistant message.
 *
 * Image content is dropped from the textual content (the chat panel
 * displays images via `attachments`, which the agent doesn't
 * persist) — the goal is to recover the *conversation*, not pixel-
 * perfect attachments. Thinking blocks are also omitted; reasoning
 * is not rendered in the chat history view.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolCall as AgentToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { ChatMessage, ToolCall as UiToolCall } from '../ui/types.js';
import { HIDDEN_TOOL_NAMES } from './hidden-tools.js';
import { isLickChannel, type LickChannel } from '../ui/lick-channels.js';

/**
 * Pure translator. `idSeed` lets callers inject a deterministic id
 * source for tests; production calls fall through to a timestamp+random
 * default that matches the chat panel's `uid()`.
 *
 * Internal orchestration tools (`HIDDEN_TOOL_NAMES`) are filtered out
 * to match the live-streaming behavior in
 * `OffscreenBridge.createCallbacks` — without this, a history rebuild
 * would surface `send_message` / `list_scoops` / `list_tasks` rows
 * that live agent activity intentionally hides.
 */
export function agentMessagesToChatMessages(
  agentMessages: readonly AgentMessage[],
  options: {
    source?: string;
    idSeed?: () => string;
    hiddenToolNames?: ReadonlySet<string>;
  } = {}
): ChatMessage[] {
  const { source = 'cone', idSeed = defaultUid, hiddenToolNames = HIDDEN_TOOL_NAMES } = options;
  const out: ChatMessage[] = [];
  let lastAssistant: ChatMessage | null = null;
  // Tool-call ids that we dropped from an assistant message because
  // their tool name was on the hidden list. Their matching
  // `toolResult` messages must also be skipped — otherwise the
  // result-patcher below would either find no target (orphan, harmless)
  // or worse, attach to a same-id call elsewhere if ids ever wrap.
  const droppedToolCallIds = new Set<string>();

  for (const m of agentMessages) {
    if (isUserMessage(m)) {
      const rawText = textOf(m.content);
      if (rawText.length === 0) continue;
      // The orchestrator wraps every queued channel message in a
      // `[<time>] <senderName>: <body>` envelope before handing it to
      // the agent (see `orchestrator.processScoopQueue`). When we
      // rebuild the chat from the agent's persisted history we have to
      // unwrap that envelope — otherwise plain user input renders with
      // a leading `[May 11, 6:50 AM] User:` and lick events render as
      // doubly-prefixed user messages instead of as lick widgets.
      const envelope = unwrapMessageEnvelope(rawText);
      const text = envelope ? envelope.body : rawText;
      const lickChannel = envelope ? lickChannelFromSenderName(envelope.sender) : null;

      const msg: ChatMessage = {
        id: idSeed(),
        role: 'user',
        content: text,
        timestamp: m.timestamp,
      };
      if (lickChannel) {
        msg.source = 'lick';
        msg.channel = lickChannel;
      }
      out.push(msg);
      lastAssistant = null;
      continue;
    }

    if (isAssistantMessage(m)) {
      const text = textOf(m.content);
      const allToolCalls = collectToolCalls(m);
      const visibleToolCalls: UiToolCall[] = [];
      for (const tc of allToolCalls) {
        if (hiddenToolNames.has(tc.name)) {
          droppedToolCallIds.add(tc.id);
        } else {
          visibleToolCalls.push(tc);
        }
      }
      const msg: ChatMessage = {
        id: idSeed(),
        role: 'assistant',
        content: text,
        timestamp: m.timestamp,
        source,
      };
      if (visibleToolCalls.length > 0) msg.toolCalls = visibleToolCalls;
      out.push(msg);
      lastAssistant = msg;
      continue;
    }

    if (isToolResultMessage(m)) {
      // Skip results for tool calls we filtered out above. Their
      // assistant counterpart was hidden, so we'd otherwise have no
      // target to attach to (and a future same-id collision could
      // cross-attach to an unrelated call).
      if (droppedToolCallIds.has(m.toolCallId)) continue;
      // Tool results land on the most recent assistant message's
      // matching tool call. If we've drifted past that boundary
      // (e.g. malformed history) we silently skip the result rather
      // than fabricate an orphan.
      const target = lastAssistant?.toolCalls?.find((tc) => tc.id === m.toolCallId);
      if (!target) continue;
      target.result = textOf(m.content);
      target.isError = m.isError;
      continue;
    }
  }

  return out;
}

// ── Discriminators (AgentMessage is a custom-extensible union) ───────

function isUserMessage(m: Message | AgentMessage): m is UserMessage {
  return (m as { role?: string }).role === 'user';
}

function isAssistantMessage(m: Message | AgentMessage): m is AssistantMessage {
  return (m as { role?: string }).role === 'assistant';
}

function isToolResultMessage(m: Message | AgentMessage): m is ToolResultMessage {
  return (m as { role?: string }).role === 'toolResult';
}

// ── Helpers ──────────────────────────────────────────────────────────

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

function collectToolCalls(m: AssistantMessage): UiToolCall[] {
  if (!Array.isArray(m.content)) return [];
  const out: UiToolCall[] = [];
  for (const block of m.content) {
    if (!isToolCallBlock(block)) continue;
    out.push({
      id: block.id,
      name: block.name,
      input: block.arguments,
    });
  }
  return out;
}

function defaultUid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Parse the `[<time>] <senderName>: <body>` envelope that
 * `orchestrator.processScoopQueue` prepends to every queued
 * `ChannelMessage` before sending it to the agent. The envelope is
 * applied uniformly to user-typed input (senderName `User`), lick
 * events (senderName `<channel>:<event-name>`), and scoop-lifecycle
 * notifications (senderName `<channel>:<event-name>` or assistant
 * label). Returns null if the text doesn't match the envelope shape so
 * pre-envelope history and forward-quoted content fall through
 * unchanged.
 *
 * The shape is intentionally not pinned to a specific date format: we
 * accept any `[...]` opener as long as it's followed by ` <sender>: `
 * where `<sender>` lives on a single line and contains no `]`. This
 * keeps the parser stable if the orchestrator ever switches locale or
 * adds seconds.
 */
export function unwrapMessageEnvelope(text: string): { sender: string; body: string } | null {
  if (!text.startsWith('[')) return null;
  const closeBracket = text.indexOf('] ');
  if (closeBracket <= 0) return null;
  // The bracketed prefix must not span newlines — otherwise we'd
  // happily strip a leading `[foo`-style label off a multi-line body.
  if (text.lastIndexOf('\n', closeBracket) !== -1) return null;
  const afterBracket = text.slice(closeBracket + 2);
  const senderEnd = afterBracket.indexOf(': ');
  if (senderEnd <= 0) return null;
  const sender = afterBracket.slice(0, senderEnd);
  if (sender.includes('\n')) return null;
  const body = afterBracket.slice(senderEnd + 2);
  return { sender, body };
}

/**
 * Map an envelope sender name back to its `LickChannel`. Lick senders
 * are formatted by `host.ts` as `<channel>:<eventName>`; the channel
 * portion is the segment before the first colon and must be one of
 * the registered `LICK_CHANNELS`. Plain user input (`User`) and other
 * non-lick senders return null.
 */
export function lickChannelFromSenderName(sender: string): LickChannel | null {
  const colon = sender.indexOf(':');
  if (colon <= 0) return null;
  const channel = sender.slice(0, colon);
  return isLickChannel(channel) ? channel : null;
}
