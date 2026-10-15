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

// Re-export the envelope/lick parsing grammar from its canonical `base/`
// home so existing callers of this module (e.g. `ui/wc/wc-message-view.ts`)
// keep importing it from here. The parsers themselves moved DOWN to
// `base/message-envelope.ts` to break the `work-unit/ ↔ scoops/` runtime
// cycle — `work-unit/conversation/entries.ts` now imports them from `base/`
// directly instead of reaching UP into this orchestration module.
export {
  lickChannelFromBody,
  lickChannelFromSenderName,
  lickIdFromBody,
  splitEnvelopes,
  unwrapMessageEnvelope,
} from '../base/message-envelope.js';

import { HIDDEN_TOOL_NAMES } from './hidden-tools.js';
import { capTranscriptText, capTranscriptToolInput } from './transcript-limits.js';

/**
 * Pure translator. `idSeed` lets callers inject a deterministic id
 * source for tests; production calls fall through to a timestamp+random
 * default that matches the chat panel's `uid()`.
 *
 * Internal orchestration tools (`HIDDEN_TOOL_NAMES`) are filtered out
 * to match the live-streaming behavior in
 * `Bridge.createCallbacks` — without this, a history rebuild
 * would surface `send_message` / `list_scoops` / `list_tasks` rows
 * that live agent activity intentionally hides.
 */
export function agentMessagesToChatMessages(
  agentMessages: readonly AgentMessage[],
  options: {
    source?: string;
    idSeed?: () => string;
    hiddenToolNames?: ReadonlySet<string>;
    /**
     * Keep tool inputs and results whole instead of capping them at the
     * transcript limit. For ARCHIVAL projections only (the compaction
     * snapshot in `/sessions`): the oversized payloads are exactly the ones
     * compaction elides, so a capped copy would be the only copy left.
     */
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
  // Tool-call ids that we dropped from an assistant message because
  // their tool name was on the hidden list. Their matching
  // `toolResult` messages must also be skipped — otherwise the
  // result-patcher below would either find no target (orphan, harmless)
  // or worse, attach to a same-id call elsewhere if ids ever wrap.
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

/**
 * Translate a user `AgentMessage` into zero or more chat messages. The
 * orchestrator wraps every queued channel message in a
 * `[<time>] <senderName>: <body>` envelope before handing it to the
 * agent (see `orchestrator.processScoopQueue`). Two extra wrinkles:
 *
 *   1) `processScoopQueue` batches multiple `ChannelMessage`s into a
 *      single prompt by joining the formatted lines with `\n`, so one
 *      persisted user `AgentMessage` can carry several envelopes —
 *      each one its own ChatMessage in the live UI. We split them back
 *      apart on rebuild so a quick burst of licks renders as N
 *      widgets, not one big bubble.
 *
 *   2) The senderName for licks is `<channel>:<eventName>` and both
 *      halves are free-form (webhook/cron/sprinkle/upgrade names), so
 *      the naive "first `: `" split corrupts senders that contain `: `
 *      themselves. The parser anchors on the closed set of known
 *      senders (`User` or a `LICK_CHANNELS` prefix) and only falls
 *      through to a generic split for unknown senders we don't ship
 *      today.
 */
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

/**
 * Translate an assistant `AgentMessage`, filtering hidden tool calls
 * and recording their ids in `droppedToolCallIds` so the matching
 * `toolResult` messages are skipped by {@link patchToolResult}.
 */
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

/**
 * Attach a `toolResult` message onto the most recent assistant
 * message's matching tool call. Results for hidden (dropped) tool
 * calls are skipped; if we've drifted past the assistant boundary
 * (e.g. malformed history) the result is silently skipped rather than
 * fabricating an orphan.
 */
function patchToolResult(
  m: ToolResultMessage,
  lastAssistant: ChatMessage | null,
  droppedToolCallIds: ReadonlySet<string>,
  uncapped = false
): void {
  if (droppedToolCallIds.has(m.toolCallId)) return;
  const target = lastAssistant?.toolCalls?.find((tc) => tc.id === m.toolCallId);
  if (!target) return;
  // Transcript boundary: cap rebuilt tool results so seeding a large
  // restored history doesn't materialize unbounded text in memory
  // (the canonical history this reads from stays untouched). The archival
  // projection opts out — see `uncapped`.
  const text = textOf(m.content);
  target.result = uncapped ? text : capTranscriptText(text);
  target.isError = m.isError;
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

function collectToolCalls(m: AssistantMessage, uncapped = false): UiToolCall[] {
  if (!Array.isArray(m.content)) return [];
  const out: UiToolCall[] = [];
  for (const block of m.content) {
    if (!isToolCallBlock(block)) continue;
    out.push({
      id: block.id,
      name: block.name,
      // Transcript boundary: shallow-cap oversized string fields (e.g.
      // write_file's `content`) — shape preserved for the panel's
      // per-tool input renderers. The archival projection keeps them whole.
      input: uncapped ? block.arguments : capTranscriptToolInput(block.arguments),
    });
  }
  return out;
}

function defaultUid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
