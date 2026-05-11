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
import { isLickChannel, LICK_CHANNELS, type LickChannel } from '../ui/lick-channels.js';

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
      // the agent (see `orchestrator.processScoopQueue`). Two extra
      // wrinkles:
      //
      //   1) `processScoopQueue` batches multiple `ChannelMessage`s
      //      into a single prompt by joining the formatted lines with
      //      `\n`, so one persisted user `AgentMessage` can carry
      //      several envelopes — each one its own ChatMessage in the
      //      live UI. We split them back apart on rebuild so a quick
      //      burst of licks renders as N widgets, not one big bubble.
      //
      //   2) The senderName for licks is `<channel>:<eventName>` and
      //      both halves are free-form (webhook/cron/sprinkle/upgrade
      //      names), so the naive "first `: `" split corrupts senders
      //      that contain `: ` themselves. The parser anchors on the
      //      closed set of known senders (`User` or a `LICK_CHANNELS`
      //      prefix) and only falls through to a generic split for
      //      unknown senders we don't ship today.
      const envelopes = splitEnvelopes(rawText);
      for (const env of envelopes) {
        if (env.body.length === 0 && env.sender == null) continue;
        const lickChannel = env.sender ? lickChannelFromSenderName(env.sender) : null;
        const msg: ChatMessage = {
          id: idSeed(),
          role: 'user',
          content: env.body,
          timestamp: m.timestamp,
        };
        if (lickChannel) {
          msg.source = 'lick';
          msg.channel = lickChannel;
        }
        out.push(msg);
      }
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
 * Parse a *single* `[<time>] <senderName>: <body>` envelope —
 * intentionally non-greedy about the body so multi-envelope content
 * can be sliced apart by `splitEnvelopes`. Returns null when the text
 * doesn't open with `[` + a single-line bracketed prefix.
 *
 * Sender parsing anchors on the closed set of senders the orchestrator
 * actually emits today:
 *
 *   - `User`              — plain panel input
 *   - `<LICK_CHANNELS>:…` — lick events; eventName may contain spaces,
 *                           arrows, version numbers, etc.
 *   - anything else       — best-effort split at the first `: ` (used
 *                           for assistant-label scoop notifications,
 *                           tray peers, and any future sender we add)
 *
 * The first two anchors make the parser robust against senders whose
 * `eventName` contains `: ` (e.g. a webhook named `deploy: prod`)
 * because we know exactly where the channel prefix ends. Only fully
 * unknown senders fall back to the naive split.
 *
 * The shape is intentionally not pinned to a specific date format: any
 * `[...]` opener on a single line is accepted, so changes to the
 * orchestrator's `toLocaleString` arguments don't break the parser.
 */
export function unwrapMessageEnvelope(text: string): { sender: string; body: string } | null {
  if (!text.startsWith('[')) return null;
  const closeBracket = text.indexOf('] ');
  if (closeBracket <= 0) return null;
  // The bracketed prefix must not span newlines — otherwise we'd
  // happily strip a leading `[foo`-style label off a multi-line body.
  if (text.lastIndexOf('\n', closeBracket) !== -1) return null;
  const afterBracket = text.slice(closeBracket + 2);

  // Known-sender anchors. We try them in order; the first match wins.
  // `User: ` is exact; lick channels match `<channel>:` followed by
  // any eventName up to the next `: ` on the same line.
  const userPrefix = 'User: ';
  if (afterBracket.startsWith(userPrefix)) {
    return { sender: 'User', body: afterBracket.slice(userPrefix.length) };
  }
  for (const channel of LICK_CHANNELS) {
    const channelPrefix = `${channel}:`;
    if (!afterBracket.startsWith(channelPrefix)) continue;
    // Find the envelope `: ` *after* the channel prefix.
    //
    // The naive "first `: `" cuts senders like `webhook:deploy: prod`
    // in half. The structural anchor we lean on instead: lick bodies
    // formatted by `lick-formatting.ts` open with `[<Label>: <name>]`
    // — i.e. the body's first character is `[`. So when the body
    // starts on the same line, the envelope separator is the *last*
    // `: ` that appears before that `[`. When the body starts on a
    // new line (or doesn't open with `[`, e.g. session-reload's
    // mount-recovery prompt), fall back to the first `: ` after the
    // channel prefix.
    const nl = afterBracket.indexOf('\n');
    const firstLineEnd = nl === -1 ? afterBracket.length : nl;
    const firstLine = afterBracket.slice(0, firstLineEnd);

    let sepIdx = -1;
    // Look for a `[` after the channel prefix, on the first line —
    // that's the start of the lick body framing.
    const bracketIdx = firstLine.indexOf('[', channelPrefix.length);
    if (bracketIdx > channelPrefix.length) {
      // Walk back from the `[` to the most recent `: `.
      sepIdx = firstLine.lastIndexOf(': ', bracketIdx);
    }
    if (sepIdx < channelPrefix.length) {
      // No `[` body opener on the first line (e.g. session-reload
      // mount-recovery prompt). Use the first `: ` after the channel
      // prefix as the boundary — eventNames for these cases don't
      // contain `: ` in practice.
      sepIdx = afterBracket.indexOf(': ', channelPrefix.length);
    }
    if (sepIdx < 0 || sepIdx >= firstLineEnd) continue; // malformed — fall through
    const sender = afterBracket.slice(0, sepIdx);
    const body = afterBracket.slice(sepIdx + 2);
    return { sender, body };
  }

  // Unknown sender (e.g. an assistant label for a scoop notification
  // not routed through host.ts). Best-effort: first `: ` on the first
  // line wins. Any new sender shape that needs lossless replay should
  // be added to the anchor set above.
  const nl = afterBracket.indexOf('\n');
  const firstLineEnd = nl === -1 ? afterBracket.length : nl;
  const senderEnd = afterBracket.indexOf(': ');
  if (senderEnd <= 0 || senderEnd >= firstLineEnd) return null;
  const sender = afterBracket.slice(0, senderEnd);
  if (sender.includes('\n')) return null;
  return { sender, body: afterBracket.slice(senderEnd + 2) };
}

/**
 * Split a possibly-batched user-message body into its constituent
 * envelopes. The orchestrator joins multiple queued `ChannelMessage`s
 * with `\n` before sending to the agent, so one stored `AgentMessage`
 * can carry several `[<time>] <sender>: <body>` segments back-to-back.
 *
 * The splitter walks the lines and starts a new segment every time a
 * line both begins with `[` and successfully parses through
 * `unwrapMessageEnvelope`. Content that doesn't open with a bracketed
 * envelope is returned as a single segment with `sender: null` so the
 * caller renders it as a plain user bubble unchanged — this also
 * covers pre-envelope history that predates the orchestrator wrapper.
 */
export function splitEnvelopes(text: string): Array<{ sender: string | null; body: string }> {
  if (text.length === 0) return [];
  const lines = text.split('\n');

  // Trivial single-segment fast path: input doesn't look like an
  // envelope-prefixed batch.
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
      // Bracket-shaped but doesn't unwrap (unknown sender, malformed):
      // emit as a plain segment so we never lose content.
      segments.push({ sender: null, body: joined });
    }
    cur = null;
  };

  for (const ln of lines) {
    if (ln.startsWith('[') && /^\[[^\]\n]+\] /.test(ln) && ln.includes(': ')) {
      // Possible envelope opener. Only commit to splitting if the line
      // actually parses — otherwise treat it as body of the current
      // segment (e.g. an inner `[Sprinkle Event: x]` line shouldn't
      // start a new envelope).
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

  // If nothing parsed, fall back to the whole text as a single
  // unenveloped segment so callers don't drop data.
  if (segments.length === 0) return [{ sender: null, body: text }];
  return segments;
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
