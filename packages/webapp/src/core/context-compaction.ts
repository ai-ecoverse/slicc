/**
 * Context compaction — LLM-summarized context replacement, plus optional
 * memory extraction over the same conversation prefix.
 *
 * When compaction triggers, two LLM calls share an identical system prompt
 * (which embeds the serialized conversation). Anthropic's prompt cache hits
 * on the system-prompt breakpoint, so the second call is near-free on input
 * tokens. Other providers see two independent calls — correctness preserved,
 * no cache savings.
 *
 * Token-accounting helpers (`estimateTokens`, `shouldCompact`,
 * `DEFAULT_COMPACTION_SETTINGS`) are still imported from pi-coding-agent —
 * they are pure heuristics with no LLM coupling. The LLM call itself now
 * goes through pi-ai's `completeSimple` directly so we control the message
 * shape and can place the conversation in the system prompt.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Usage, UserMessage } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
// Deep import to the compaction submodule — the main entry re-exports 113 Node-only
// modules that would break Vite's browser bundle. The compaction submodule itself
// only depends on @earendil-works/pi-ai (already a browser-safe dependency).
// Types are declared in packages/webapp/src/types/pi-coding-agent-compaction.d.ts.
//
// `estimateTokens` (chars/4 heuristic, conservative — overestimates) accounts for:
//   - user:              `content` string OR text blocks in array content
//   - assistant:         text blocks, thinking blocks, and toolCall blocks
//                        (name length + JSON.stringify(arguments).length)
//   - toolResult/custom: `content` string OR text blocks in array content,
//                        + 4800 chars (~1200 tokens) per image block
//   - bashExecution:     command + output length
//   - branchSummary / compactionSummary: summary length
// Verified against node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/
// compaction.js (function `estimateTokens`). Tool-result text payloads — including
// the multi-megabyte blobs that `open --view` can emit — ARE counted.
//
// What it does NOT count is `thinkingSignature` (see `estimateMessageTokens`),
// which is why every local call site goes through that wrapper rather than
// calling `estimateTokens` directly. The regression guards live in
// tests/core/context-compaction-real-estimator.test.ts which exercises the
// un-mocked estimator end-to-end.
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  shouldCompact,
} from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { createLogger } from '../base/logger.js';

const log = createLogger('context-compaction');

/** Default context window for Claude models. */
const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Discriminator narrow on `AgentMessage`. The union includes pi-agent-core's
 * `CustomAgentMessages` extension point, so a plain `m.role === 'x'` check
 * does not narrow cleanly; a typed shape view does the same job without `any`.
 */
function hasRole(message: AgentMessage, role: string): boolean {
  return (message as { role: string }).role === role;
}

/**
 * Drop any `toolResult` messages at the HEAD of `messages`.
 *
 * A leading `toolResult` is orphaned by definition: there is no preceding
 * assistant message that contains its `toolCallId`. This arises in two
 * call sites:
 *
 *  1. **Session restore** (`scoop-context.ts`): IndexedDB can persist a
 *     corrupt session whose first message is a `toolResult` (e.g. a browser
 *     crash mid-save, or sessions written before the walk-back guard was
 *     introduced). Without stripping it, Bedrock rejects the next prompt
 *     with "unexpected tool_use_id found in tool_result blocks".
 *
 *  2. **After compaction** (defense-in-depth): the walk-back guard in both
 *     `createCompactContext` and `compactContext` already ensures
 *     `slice(cutIndex)` does not start with a `toolResult`, so the strip
 *     is normally a no-op here. It is kept as a safety net against future
 *     changes to the cut algebra.
 */
export function stripOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
  let i = 0;
  while (i < messages.length && hasRole(messages[i], 'toolResult')) {
    const tr = messages[i] as { role: string; toolCallId?: string };
    log.warn('Dropping orphaned toolResult (no preceding assistant message)', {
      toolCallId: tr.toolCallId,
    });
    i++;
  }
  return i > 0 ? messages.slice(i) : messages;
}

export interface CompactionConfig {
  model: Model<Api>;
  getApiKey: () => string | undefined;
  contextWindow?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  /**
   * Multiplier of `contextWindow` above which compaction is treated as
   * hopeless: the LLM summary call is skipped entirely because passing
   * the conversation as a prompt would itself blow context. Oversized
   * tool results / assistant tool-call payloads are elided in-place
   * before any naive drop. Defaults to 4.
   */
  hopelessMultiplier?: number;
  /**
   * HTTP headers forwarded to the LLM provider for the summarization and
   * memory-extraction requests. Used by the Adobe LLM proxy path to attach
   * `X-Session-Id` so compaction calls land in the same session as the
   * agent's tool turns. Other providers ignore unknown headers.
   */
  headers?: Record<string, string>;
  /**
   * Optional callback invoked when the memory-extraction LLM call produces
   * durable bullets worth persisting. Receives the LLM's raw output (a
   * markdown bullet block). The implementation is expected to append it to
   * a memory store (e.g. `/shared/CLAUDE.md`).
   *
   * Best-effort: failures in the LLM call or the callback are logged but do
   * not block compaction. When omitted, no memory call is made.
   */
  onMemoryUpdates?: (bullets: string) => Promise<void> | void;
  /**
   * Consulted immediately before the memory-extraction phase of EACH
   * compaction. Return `false` to skip extraction for this compaction —
   * unlike omitting `onMemoryUpdates` (a construction-time decision),
   * the check is live, so a mid-session toggle (the agentic-memory flag,
   * #2003) applies to the very next compaction without a reload. Absent
   * → extract whenever `onMemoryUpdates` is wired.
   */
  shouldExtractMemories?: () => boolean;
  /**
   * Optional lifecycle hook for the UI. Fired around the compaction LLM
   * calls so the chat panel can render a ghost-bubble affordance instead
   * of leaving the user wondering why the agent is silent.
   *
   * Sequence on a typical compaction:
   *   'summarizing'        → before the summary call
   *   'extracting-memory'  → before the memory call (only when
   *                          `onMemoryUpdates` is also wired)
   *   'idle'               → in `finally`, always fires last
   *
   * No-op when omitted.
   */
  onCompactionStateChange?: (state: CompactionState) => void;
}

export interface CompactionOptions {
  /** Run the existing compaction path even when the local estimate is below its threshold. */
  force?: boolean;
}

/**
 * Phases of an in-flight compaction. `idle` is the resting state; the UI
 * should clear any compaction-specific affordance when it sees it.
 * `fallback` fires when the LLM summary failed (or was unavailable) and the
 * naive-drop result is about to be applied — the one phase worth surfacing
 * in the transcript, because it means older context was truncated without a
 * summary (#1985).
 */
export type CompactionState = 'summarizing' | 'extracting-memory' | 'fallback' | 'idle';

/**
 * Lightweight serializer that renders an AgentMessage array as a text block
 * suitable for embedding inside a system prompt. We do not need the full
 * structured fidelity pi-coding-agent provides for its own session manager —
 * the summarizing LLM only needs to read the conversation.
 */
function serializeMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as {
      role: string;
      content?: unknown;
      command?: string;
      output?: string;
      summary?: string;
      toolName?: string;
    };
    switch (m.role) {
      case 'user': {
        lines.push(`<user>\n${extractText(m.content)}\n</user>`);
        break;
      }
      case 'assistant': {
        lines.push(`<assistant>\n${extractText(m.content)}\n</assistant>`);
        break;
      }
      case 'toolResult': {
        const name = m.toolName ?? 'tool';
        lines.push(`<tool-result name="${name}">\n${extractText(m.content)}\n</tool-result>`);
        break;
      }
      case 'bashExecution': {
        lines.push(`<bash>\n$ ${m.command ?? ''}\n${m.output ?? ''}\n</bash>`);
        break;
      }
      case 'branchSummary':
      case 'compactionSummary': {
        lines.push(`<prior-summary>\n${m.summary ?? ''}\n</prior-summary>`);
        break;
      }
      default: {
        // Unknown role — fall back to JSON-ish dump of text content.
        lines.push(`<${m.role}>\n${extractText(m.content)}\n</${m.role}>`);
      }
    }
  }
  return lines.join('\n\n');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as {
      type?: string;
      text?: string;
      name?: string;
      arguments?: unknown;
      thinking?: string;
    };
    if (b.type === 'text' && b.text) out.push(b.text);
    else if (b.type === 'thinking' && b.thinking) out.push(`[thinking] ${b.thinking}`);
    else if (b.type === 'toolCall')
      out.push(`[tool-call ${b.name ?? '?'}] ${JSON.stringify(b.arguments ?? {})}`);
    else if (b.type === 'image') out.push('[image]');
  }
  return out.join('\n');
}

const SUMMARY_INSTRUCTION = `Produce a structured context checkpoint summary of the conversation above that another LLM can use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages. Output ONLY the summary, with no preamble or follow-up.`;

const MEMORY_INSTRUCTION = `From the conversation above, extract durable memories worth persisting to a global memory file shared across future sessions.

Focus on:
- User preferences, working style, opinions stated explicitly.
- Stable project facts (architecture decisions, conventions, constraints).
- Validated approaches the user accepted ("yes, exactly", "perfect"), not just corrections.
- External resources/links the user named.

DO NOT include:
- Ephemeral state (current task, in-progress work).
- Information already obvious from the codebase (file paths, function names, framework conventions).
- Generic restatements of what the conversation was about.

If nothing in the conversation is worth persisting, return exactly the single line:
NONE

Otherwise, output ONLY a markdown bullet list (one bullet per memory), no headers, no preamble, no follow-up. Each bullet is one line. Be specific. Prefer one fact per bullet over multi-clause sentences.`;

/** Build a system prompt that embeds the conversation, identical across calls. */
function buildSharedSystemPrompt(conversationText: string): string {
  return `You are a context compaction assistant. You are shown the prefix of a conversation between a user and an AI coding assistant, and asked to produce either a structured summary, durable memory bullets, or a short title — depending on the user's instruction.

Do NOT continue the conversation. Do NOT answer questions inside the conversation. Output ONLY what the user asks for in the format specified.

<conversation>
${conversationText}
</conversation>`;
}

async function runCompactionCall(
  model: Model<Api>,
  apiKey: string,
  systemPrompt: string,
  userInstruction: string,
  maxTokens: number,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: userInstruction }],
    timestamp: Date.now(),
  };
  const response = await completeSimple(
    model,
    { systemPrompt, messages: [userMessage] },
    { maxTokens, apiKey, headers, signal }
  );
  if (response.stopReason === 'error') {
    throw new Error(`Compaction call failed: ${response.errorMessage || 'Unknown error'}`);
  }
  return response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n')
    .trim();
}

/** Default `hopelessMultiplier`. */
const DEFAULT_HOPELESS_MULTIPLIER = 4;

/**
 * Approximate the byte size of a message's content for the hopeless-branch
 * stub. Mirrors `extractText` but counts characters across text, thinking,
 * tool-call argument JSON, and inline image base64 so the reported KB is a
 * realistic estimate of what the elision dropped.
 */
function approxContentBytes(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    const b = block as {
      type?: string;
      text?: string;
      thinking?: string;
      arguments?: unknown;
      source?: { data?: string };
    };
    if (b.type === 'text' && b.text) total += b.text.length;
    else if (b.type === 'thinking' && b.thinking) total += b.thinking.length;
    else if (b.type === 'toolCall' && b.arguments !== undefined) {
      try {
        total += JSON.stringify(b.arguments).length;
      } catch {
        // unserializable arguments — best-effort, skip
      }
    } else if (b.type === 'image' && b.source?.data) total += b.source.data.length;
  }
  return total;
}

function buildElisionStub(approxBytes: number, role: 'toolResult' | 'assistant'): string {
  const kb = Math.max(1, Math.round(approxBytes / 1024));
  const prefix = role === 'assistant' ? 'Assistant message elided' : 'Tool result elided';
  return `[${prefix}: ${kb} KB, exceeds half the context window. Re-run with smaller arguments — e.g. open --view --size low.]`;
}

function elideMessageContent(message: AgentMessage): AgentMessage {
  const role = (message as { role: string }).role as 'toolResult' | 'assistant';
  const content = (message as { content?: unknown }).content;
  const bytes = approxContentBytes(content);
  if (role === 'toolResult') {
    return {
      ...(message as object),
      content: [{ type: 'text', text: buildElisionStub(bytes, role) }],
    } as AgentMessage;
  }

  const toolCalls = Array.isArray(content)
    ? (content.filter((block) => (block as { type?: string }).type === 'toolCall') as Array<{
        type: string;
        id?: string;
        name?: string;
        arguments?: unknown;
      }>)
    : [];
  const elidedToolCalls = toolCalls.map((toolCall) => {
    let argumentBytes = 0;
    if (toolCall.arguments !== undefined) {
      try {
        argumentBytes = JSON.stringify(toolCall.arguments).length;
      } catch {
        // unserializable arguments — best-effort, treat as 0 bytes
      }
    }
    return {
      type: toolCall.type,
      id: toolCall.id,
      name: toolCall.name,
      arguments: { elided: true, originalBytes: argumentBytes },
    };
  });
  return {
    ...(message as object),
    content: [{ type: 'text', text: buildElisionStub(bytes, role) }, ...elidedToolCalls],
  } as AgentMessage;
}

/**
 * Replace the content of any single `toolResult` (or assistant message carrying
 * tool calls) whose estimated tokens exceed `(contextWindow - reserveTokens) / 2`
 * with a short stub. A message that large cannot be summarized — serializing it
 * into the summary prompt would itself blow context — so it must be stubbed in
 * place before either summarization or naive drop (#2011).
 *
 * - Message ordering, role, `toolCallId`, and `toolName` are preserved.
 * - For assistant messages, `toolCall` content blocks are kept (with `id`,
 *   `name`, and `type` intact) so the agent loop's tool-call/tool-result
 *   pairing stays valid. Each block's `arguments` payload is rewritten to
 *   a small `{ elided: true, originalBytes: <n> }` stub so multi-megabyte
 *   `write_file`-style argument blobs don't survive elision.
 * - Assistant messages without any `toolCall` block are passed through
 *   unchanged — only assistant turns that actually carry tool calls participate.
 *
 * Unlike {@link elideHopelessMessages}, this does NOT strip images: it runs on
 * every compaction (not only when the context is multiples of the window), so it
 * must touch only messages that are individually oversized.
 */
function elideOversizedMessages(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): { messages: AgentMessage[]; elidedCount: number; elidedBytes: number } {
  const perMessageThreshold = (contextWindow - reserveTokens) / 2;
  let elidedCount = 0;
  let elidedBytes = 0;

  const out = messages.map((msg) => {
    const tokens = estimateMessageTokens(msg);
    if (tokens <= perMessageThreshold) return msg;
    const role = (msg as { role: string }).role;
    if (role !== 'toolResult' && role !== 'assistant') return msg;

    const m = msg as { content?: unknown };
    const bytes = approxContentBytes(m.content);

    if (role === 'toolResult') {
      elidedCount++;
      elidedBytes += bytes;
      return elideMessageContent(msg);
    }

    // Assistant branch: only elide turns that actually carry tool calls.
    const content = Array.isArray(m.content) ? m.content : [];
    const toolCalls = content.filter((b) => (b as { type?: string }).type === 'toolCall');
    if (toolCalls.length === 0) return msg;

    elidedCount++;
    elidedBytes += bytes;
    return elideMessageContent(msg);
  });

  return { messages: out, elidedCount, elidedBytes };
}

/**
 * Hopeless-branch elision: strip images from every message (#1986 — the context
 * is multiples of the window, so no image payload can survive to the model
 * anyway, and user-role messages where photo attachments live never reach the
 * role-gated size elision), then stub every oversized message via
 * {@link elideOversizedMessages}.
 */
function elideHopelessMessages(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): { messages: AgentMessage[]; elidedCount: number; elidedBytes: number } {
  let elidedCount = 0;
  let elidedBytes = 0;

  const imageStripped = messages.map((rawMsg) => {
    const msg = elideImagesInMessage(rawMsg);
    if (msg !== rawMsg) {
      elidedCount++;
      elidedBytes +=
        approxContentBytes((rawMsg as { content?: unknown }).content) -
        approxContentBytes((msg as { content?: unknown }).content);
    }
    return msg;
  });

  const sized = elideOversizedMessages(imageStripped, contextWindow, reserveTokens);
  return {
    messages: sized.messages,
    elidedCount: elidedCount + sized.elidedCount,
    elidedBytes: elidedBytes + sized.elidedBytes,
  };
}

/**
 * Characters of `thinkingSignature` carried by a message's thinking blocks.
 *
 * Anthropic returns every thinking block with an opaque signature that MUST be
 * echoed back on the next request for multi-turn continuity, so it occupies
 * real context on every subsequent turn. pi-coding-agent's `estimateTokens`
 * walks only `block.thinking`, so the signature is invisible to it — and on a
 * long thinking-heavy conversation the signatures dominate. A production
 * `interview-me` scoop carried 1,099,252 signature chars against 1,933,000
 * counted chars, so the local estimate came in at 496k while the provider
 * reported 985k of a 1M window: the compaction trigger never armed and the
 * scoop was heading for a hard context-overflow instead.
 *
 * Redacted thinking blocks have no `thinking` text at all — the whole payload
 * lives in the signature — so for those this is the only thing to count.
 */
function thinkingSignatureChars(message: AgentMessage): number {
  if (!hasRole(message, 'assistant')) return 0;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; thinkingSignature?: string };
    if (b.type === 'thinking' && typeof b.thinkingSignature === 'string') {
      chars += b.thinkingSignature.length;
    }
  }
  return chars;
}

/**
 * Estimated tokens for one message: the upstream heuristic plus the content it
 * structurally cannot see. Every local call site uses this instead of
 * `estimateTokens` so the trigger, the oversized-message threshold, and the
 * cut-point walk all price a message the same way.
 */
function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(message) + Math.ceil(thinkingSignatureChars(message) / 4);
}

/** Sum the estimated token cost of a message list. */
function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * Index of the last assistant message carrying usage the provider actually
 * reported. Mirrors pi-coding-agent's own skip rules: an aborted or errored
 * turn, or an all-zero usage record, tells us nothing about context size.
 */
function lastReportedUsageIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!hasRole(messages[i], 'assistant')) continue;
    const m = messages[i] as { stopReason?: string; usage?: Usage };
    if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
    const u = m.usage;
    if (!u) continue;
    if (contextTokensFromUsage(u) > 0) return i;
  }
  return -1;
}

/** Prompt size the provider reported for a turn. */
function contextTokensFromUsage(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Context size for the compaction trigger: the provider's own accounting when
 * we have it, the chars/4 heuristic otherwise.
 *
 * The heuristic is structurally optimistic — it can only count fields it knows
 * about, and it divides by a constant 4 that runs generous for the code and
 * JSON that fills an agent transcript. The last assistant turn's `usage` is the
 * provider stating exactly how large the prompt it just read was, so prefer it
 * for the prefix it covers and estimate only the messages appended since.
 *
 * Taking `max` with the pure heuristic keeps the answer monotone in what we can
 * see: a stale, missing, or under-reported usage can never make the total look
 * smaller than the messages themselves.
 *
 * Only the trigger uses this. Everything downstream re-measures with the
 * heuristic on purpose — once elision has rewritten messages, a usage record
 * describing the pre-elision prefix is stale and would overstate the result.
 */
function estimateContextTokens(messages: AgentMessage[]): number {
  const heuristic = estimateTotalTokens(messages);
  const index = lastReportedUsageIndex(messages);
  if (index === -1) return heuristic;
  let reported = contextTokensFromUsage((messages[index] as { usage: Usage }).usage);
  for (let i = index + 1; i < messages.length; i++) {
    reported += estimateMessageTokens(messages[i]);
  }
  return Math.max(heuristic, reported);
}

/** Whether compaction changed the message sequence rather than returning a true no-op. */
export function hasCompactionProgress(
  messages: AgentMessage[],
  compacted: AgentMessage[]
): boolean {
  if (messages.length !== compacted.length) return true;
  return messages.some((message, index) => message !== compacted[index]);
}

/** Emit a compaction lifecycle hook safely — listener bugs must never abort compaction. */
function emitCompactionState(config: CompactionConfig, state: CompactionState): void {
  try {
    config.onCompactionStateChange?.(state);
  } catch (e) {
    log.warn('onCompactionStateChange listener threw', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Hopeless branch — total context so far beyond the window that serializing the
 * conversation into a summary prompt would itself blow context. Elide oversized
 * tool results / assistant tool-call payloads in-place. When the elided list is
 * back under the soft threshold, `earlyReturn` carries it so the caller can
 * return immediately (no LLM call, no naive drop); otherwise the caller falls
 * through to the naive-drop path with `isHopeless` set (LLM block skipped).
 */
function applyHopelessElision(
  messages: AgentMessage[],
  totalTokens: number,
  contextWindow: number,
  reserveTokens: number,
  hopelessMultiplier: number,
  settings: Parameters<typeof shouldCompact>[2]
): { messages: AgentMessage[]; isHopeless: boolean; earlyReturn: AgentMessage[] | null } {
  // #2011: stub any individually-oversized message on EVERY compaction, decoupled
  // from the 4x-window "hopeless" gate below. A single tool result larger than
  // half the window (e.g. a multi-hundred-KB command dump) cannot be summarized —
  // sending it to the summary LLM re-blows context — so it must be elided in
  // place whether or not the conversation total is multiples of the window.
  const sizeElision = elideOversizedMessages(messages, contextWindow, reserveTokens);
  let workingMessages = sizeElision.messages;
  let elidedCount = sizeElision.elidedCount;
  let elidedBytes = sizeElision.elidedBytes;

  const postSizeTokens = elidedCount > 0 ? estimateTotalTokens(workingMessages) : totalTokens;

  // Hopeless branch (#1986): even after size-elision the context is still
  // multiples of the window, so strip images too and skip the LLM summary —
  // serializing this much conversation would itself blow context.
  const isHopeless = postSizeTokens > contextWindow * hopelessMultiplier;
  if (isHopeless) {
    const hopeless = elideHopelessMessages(workingMessages, contextWindow, reserveTokens);
    workingMessages = hopeless.messages;
    elidedCount += hopeless.elidedCount;
    elidedBytes += hopeless.elidedBytes;
  }

  // True no-op: nothing oversized and not hopeless — let the caller run the
  // normal summarize path on the untouched messages.
  if (!isHopeless && elidedCount === 0) {
    return { messages, isHopeless: false, earlyReturn: null };
  }

  log.warn('Compaction oversized-message elision', {
    totalTokens,
    postSizeTokens,
    contextWindow,
    isHopeless,
    elidedCount,
    elidedBytes,
  });
  const postTokens = estimateTotalTokens(workingMessages);
  // If elision alone brought us back under the compaction threshold, return
  // immediately — no LLM summary, no naive drop needed. But first strip images
  // the same way the summarize path does: `estimateTokens` assigns each image a
  // fixed ~1,200 tokens regardless of its real base64 size, so this early return
  // could otherwise hand back large image payloads that keep the real backend
  // over its limit (post-#2011 the size-elision path bypassed both
  // `elideTailImages` and the hopeless image strip — Codex P1 on #2013).
  // `elideTailImages` stubs every image except the latest user message's, which
  // the model has not acted on yet — parity with the normal summarize path.
  const earlyReturn = shouldCompact(postTokens, contextWindow, settings)
    ? null
    : elideTailImages([], workingMessages, contextWindow, settings);
  return { messages: workingMessages, isHopeless, earlyReturn };
}

/**
 * Replace every image block in `message` with a small text stub naming the
 * approximate payload it displaced. Returns the original message when it
 * carries no image blocks — callers rely on identity to detect no-ops.
 */
function elideImagesInMessage(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  let elided = false;
  const next = content.map((block) => {
    // Both image shapes in the wild: pi-ai's `{ type, data }` and
    // Anthropic-style `{ type, source: { data } }`.
    const b = block as { type?: string; data?: string; source?: { data?: string } };
    if (b.type !== 'image') return block;
    elided = true;
    const kb = Math.max(1, Math.round((b.source?.data ?? b.data ?? '').length / 1024));
    return {
      type: 'text',
      text: `[image elided during compaction: ~${kb} KB. Re-attach or re-read the image if it is still needed.]`,
    };
  });
  if (!elided) return message;
  return { ...(message as object), content: next } as AgentMessage;
}

/** Index of the last user message, or -1. */
function lastUserIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasRole(messages[i], 'user')) return i;
  }
  return -1;
}

/**
 * Compaction keeps the recent tail verbatim — including the image blocks
 * that are usually WHY the window blew. A "successful" compaction that
 * retains them leaves the context still over the limit, so the very next
 * call fails again and the recovery loop burns retries invisibly (#1986,
 * observed in production). Two passes:
 *
 *  1. Elide images in every kept message BEFORE the latest user message —
 *     the model has already acted on those; a stub loses nothing.
 *  2. Re-estimate the assembled result; when still over the compaction
 *     threshold, elide images oldest-first from the remaining messages
 *     (including the latest user message) until under or none are left.
 */
function elideTailImages(
  head: AgentMessage[],
  tail: AgentMessage[],
  contextWindow: number,
  settings: Parameters<typeof shouldCompact>[2]
): AgentMessage[] {
  const keepFrom = lastUserIndex(tail);
  let result = tail.map((m, i) => (keepFrom !== -1 && i >= keepFrom ? m : elideImagesInMessage(m)));

  if (shouldCompact(estimateTotalTokens([...head, ...result]), contextWindow, settings)) {
    for (let i = 0; i < result.length; i++) {
      const next = elideImagesInMessage(result[i]);
      if (next === result[i]) continue;
      result = [...result.slice(0, i), next, ...result.slice(i + 1)];
      if (!shouldCompact(estimateTotalTokens([...head, ...result]), contextWindow, settings)) {
        break;
      }
    }
  }
  return result;
}

/**
 * Find the cut point: walk backward from the end to keep ~keepRecentTokens, then
 * avoid splitting assistant+toolResult pairs. Returns null when no valid cut
 * point exists (need at least one message to summarize and one to keep).
 */
function selectCompactionSlices(
  workingMessages: AgentMessage[],
  keepRecentTokens: number
): { messagesToSummarize: AgentMessage[]; messagesToKeep: AgentMessage[] } | null {
  let keptTokens = 0;
  let cutIndex = workingMessages.length;
  for (let i = workingMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(workingMessages[i]);
    if (keptTokens + msgTokens > keepRecentTokens && cutIndex < workingMessages.length) {
      break;
    }
    keptTokens += msgTokens;
    cutIndex = i;
  }

  // Don't split assistant+toolResult pairs: if cutIndex lands on a toolResult,
  // walk backward to include its assistant message.
  while (cutIndex > 0 && hasRole(workingMessages[cutIndex], 'toolResult')) {
    cutIndex--;
  }

  if (cutIndex <= 0 || cutIndex >= workingMessages.length) {
    log.warn('Cannot find valid cut point for compaction');
    return null;
  }

  return {
    messagesToSummarize: workingMessages.slice(0, cutIndex),
    messagesToKeep: stripOrphanedToolResults(workingMessages.slice(cutIndex)),
  };
}

/**
 * Best-effort memory extraction. Same system prompt → cache hit on the
 * conversation block for Anthropic-style providers. Never throws.
 */
async function extractMemoriesIfConfigured(
  config: CompactionConfig,
  apiKey: string,
  systemPrompt: string,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!config.onMemoryUpdates) return;
  // Live per-compaction gate — see `shouldExtractMemories` (#2003).
  if (config.shouldExtractMemories?.() === false) return;
  // Memory budget is much smaller — bullets, not a structured doc.
  const memoryMaxTokens = 2048;
  try {
    emitCompactionState(config, 'extracting-memory');
    const bullets = await runCompactionCall(
      config.model,
      apiKey,
      systemPrompt,
      MEMORY_INSTRUCTION,
      memoryMaxTokens,
      config.headers,
      signal
    );
    if (bullets?.trim() && bullets.trim() !== 'NONE') {
      try {
        await config.onMemoryUpdates(bullets.trim());
        log.info('Memory extraction applied', { bulletsLength: bullets.length });
      } catch (cbErr) {
        log.warn('onMemoryUpdates callback threw', {
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    } else {
      log.info('Memory extraction returned no durable memories');
    }
  } catch (memErr) {
    log.warn('Memory extraction call failed (compaction still applied)', {
      error: memErr instanceof Error ? memErr.message : String(memErr),
    });
  }
}

/**
 * Attempt LLM-powered summarization. Returns the compacted message list on
 * success, or null when the summary call fails (caller falls back to naive drop).
 */
async function summarizeWithLlm(
  config: CompactionConfig,
  apiKey: string,
  messagesToSummarize: AgentMessage[],
  messagesToKeep: AgentMessage[],
  reserveTokens: number,
  contextWindow: number,
  originalMessageCount: number,
  signal: AbortSignal | undefined
): Promise<AgentMessage[] | null> {
  try {
    // #2012 defense-in-depth: never serialize an individually-oversized message
    // into the summary prompt. In the normal flow applyHopelessElision already
    // stubbed these upstream; this guard guarantees the summary LLM call can't
    // be handed an un-summarizable message by any future or forced path.
    const safeToSummarize = elideOversizedMessages(
      messagesToSummarize,
      contextWindow,
      reserveTokens
    ).messages;
    const conversationText = serializeMessages(safeToSummarize);
    const systemPrompt = buildSharedSystemPrompt(conversationText);
    // Summary uses ~80% of the reserve budget for output, mirroring the
    // pi-coding-agent default.
    const summaryMaxTokens = Math.floor(0.8 * reserveTokens);
    emitCompactionState(config, 'summarizing');
    const summary = await runCompactionCall(
      config.model,
      apiKey,
      systemPrompt,
      SUMMARY_INSTRUCTION,
      summaryMaxTokens,
      config.headers,
      signal
    );

    const summaryMessage: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: `<context-summary>\n${summary}\n</context-summary>` }],
      timestamp: Date.now(),
    };

    log.info('LLM summarization successful', {
      originalMessages: originalMessageCount,
      compactedMessages: 1 + messagesToKeep.length,
      summaryLength: summary.length,
    });

    await extractMemoriesIfConfigured(config, apiKey, systemPrompt, signal);

    emitCompactionState(config, 'idle');
    return [summaryMessage, ...messagesToKeep];
  } catch (err) {
    log.warn('LLM summarization failed, falling back to naive drop', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Create a transformContext function that uses LLM summarization for compaction.
 *
 * The returned function:
 * 1. Checks if total tokens exceed (contextWindow - reserveTokens), unless forced by the caller
 * 2. If so, finds a cut point that keeps ~keepRecentTokens of recent messages
 * 3. Calls the LLM to summarize the older messages — conversation embedded in
 *    the system prompt so a follow-up call can cache-hit the prefix.
 * 4. Replaces the older messages with a single summary user message.
 * 5. If `onMemoryUpdates` is configured, makes a second LLM call (same system
 *    prompt, different instruction) to extract durable memories; this is
 *    best-effort and never blocks compaction.
 * 6. Falls back to naive drop if the summary call fails.
 */
export function createCompactContext(
  config: CompactionConfig
): (
  messages: AgentMessage[],
  signal?: AbortSignal,
  options?: CompactionOptions
) => Promise<AgentMessage[]> {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reserveTokens = config.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const keepRecentTokens = config.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
  const hopelessMultiplier = config.hopelessMultiplier ?? DEFAULT_HOPELESS_MULTIPLIER;

  const settings = { enabled: true, reserveTokens, keepRecentTokens };

  return async (
    messages: AgentMessage[],
    signal?: AbortSignal,
    options?: CompactionOptions
  ): Promise<AgentMessage[]> => {
    if (messages.length === 0) return messages;

    const totalTokens = estimateContextTokens(messages);
    if (!options?.force && !shouldCompact(totalTokens, contextWindow, settings)) {
      return messages;
    }

    const hopeless = applyHopelessElision(
      messages,
      totalTokens,
      contextWindow,
      reserveTokens,
      hopelessMultiplier,
      settings
    );
    if (hopeless.earlyReturn) return hopeless.earlyReturn;
    const workingMessages = hopeless.messages;
    const isHopeless = hopeless.isHopeless;

    log.info('Context compaction triggered', {
      totalTokens,
      contextWindow,
      threshold: contextWindow - reserveTokens,
      messageCount: workingMessages.length,
    });

    const slices = selectCompactionSlices(workingMessages, keepRecentTokens);
    if (!slices) return workingMessages;
    const { messagesToSummarize, messagesToKeep } = slices;

    log.info('Compaction cut point', {
      summarizing: messagesToSummarize.length,
      keeping: messagesToKeep.length,
    });

    // Attempt LLM-powered summarization. Skip in the hopeless branch —
    // serializing the conversation into the summary prompt would itself
    // blow context, so we fall straight through to naive drop on the
    // already-elided message list.
    const apiKey = isHopeless ? undefined : config.getApiKey();
    if (apiKey) {
      const summarized = await summarizeWithLlm(
        config,
        apiKey,
        messagesToSummarize,
        messagesToKeep,
        reserveTokens,
        contextWindow,
        messages.length,
        signal
      );
      if (summarized) {
        // The summary head is small; the tail's images are what re-blow the
        // window (#1986). `summarized` = [summaryMessage, ...messagesToKeep].
        const [summaryHead, ...tail] = summarized;
        return [summaryHead, ...elideTailImages([summaryHead], tail, contextWindow, settings)];
      }
    } else if (!isHopeless) {
      log.warn('No API key available for LLM summarization, falling back to naive drop');
    }
    // Surface the degradation (#1985): the LLM summary failed or was
    // unavailable, so older context is about to be truncated WITHOUT a
    // summary. The `fallback` phase is the observable difference between
    // "compacted cleanly" and "dropped history"; `idle` still fires last so
    // every consumer's resting-state contract holds.
    emitCompactionState(config, 'fallback');
    emitCompactionState(config, 'idle');

    // Fallback: naive drop (same as old behavior but without eager truncation)
    const compactedMsg: UserMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[Earlier conversation messages were compacted to save context space]',
        },
      ],
      timestamp: Date.now(),
    };

    const keptTail = elideTailImages([compactedMsg], messagesToKeep, contextWindow, settings);

    log.info('Naive compaction applied', {
      originalMessages: messages.length,
      compactedMessages: 1 + keptTail.length,
    });

    return [compactedMsg, ...keptTail];
  };
}

/**
 * Build a shared system prompt and run a single user-instruction call against
 * a serialized conversation. Used by the "New session" freezer to extract
 * memories and produce a title over the live cone session — two calls that
 * share this same system prompt for prefix-cache reuse.
 *
 * Returns the raw text response, or throws.
 */
export async function runOneOffCompactionCall(args: {
  messages: AgentMessage[];
  instruction: string;
  model: Model<Api>;
  apiKey: string;
  maxTokens: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<string> {
  const conversationText = serializeMessages(args.messages);
  const systemPrompt = buildSharedSystemPrompt(conversationText);
  return runCompactionCall(
    args.model,
    args.apiKey,
    systemPrompt,
    args.instruction,
    args.maxTokens,
    args.headers,
    args.signal
  );
}

/** Instruction strings exported for reuse by the freezer flow. */
export const COMPACTION_MEMORY_INSTRUCTION = MEMORY_INSTRUCTION;
export const COMPACTION_TITLE_INSTRUCTION = `Generate a short title (3 to 6 words) summarizing what this conversation was about. Output ONLY the title text — no quotes, no punctuation other than what belongs in the title, no preamble.`;

/**
 * Legacy compactContext — naive drop strategy without LLM summarization.
 * Kept for backwards compatibility and as the fallback when no model/apiKey is available.
 */
export async function compactContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  if (messages.length === 0) return messages;

  // Estimate total tokens
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateMessageTokens(msg);
  }

  // Use default settings for threshold check
  if (!shouldCompact(totalTokens, DEFAULT_CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS)) {
    return messages;
  }

  const keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

  // Find cut point
  let keptTokens = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i]);
    if (keptTokens + msgTokens > keepRecentTokens && cutIndex < messages.length) {
      break;
    }
    keptTokens += msgTokens;
    cutIndex = i;
  }

  // Don't split assistant+toolResult pairs
  while (cutIndex > 0 && hasRole(messages[cutIndex], 'toolResult')) {
    cutIndex--;
  }

  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return messages;
  }

  const compactedMsg: UserMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '[Earlier conversation messages were compacted to save context space]',
      },
    ],
    timestamp: Date.now(),
  };

  const kept = stripOrphanedToolResults(messages.slice(cutIndex));
  const result = [compactedMsg, ...kept];

  log.info('Context compacted (legacy)', {
    originalMessages: messages.length,
    compactedMessages: result.length,
  });

  return result;
}
