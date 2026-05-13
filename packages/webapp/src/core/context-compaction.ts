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
import type { Api, Model, UserMessage } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai';
// Deep import to the compaction submodule — the main entry re-exports 113 Node-only
// modules that would break Vite's browser bundle. The compaction submodule itself
// only depends on @earendil-works/pi-ai (already a browser-safe dependency).
// Types are declared in packages/webapp/src/types/pi-coding-agent-compaction.d.ts.
import {
  estimateTokens,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { createLogger } from './logger.js';

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

/**
 * Phases of an in-flight compaction. `idle` is the resting state; the UI
 * should clear any compaction-specific affordance when it sees it.
 */
export type CompactionState = 'summarizing' | 'extracting-memory' | 'idle';

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

/**
 * Create a transformContext function that uses LLM summarization for compaction.
 *
 * The returned function:
 * 1. Checks if total tokens exceed (contextWindow - reserveTokens)
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
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reserveTokens = config.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const keepRecentTokens = config.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

  const settings = { enabled: true, reserveTokens, keepRecentTokens };

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (messages.length === 0) return messages;

    // Estimate total context tokens
    let totalTokens = 0;
    for (const msg of messages) {
      totalTokens += estimateTokens(msg);
    }

    // Check if compaction is needed
    if (!shouldCompact(totalTokens, contextWindow, settings)) {
      return messages;
    }

    log.info('Context compaction triggered', {
      totalTokens,
      contextWindow,
      threshold: contextWindow - reserveTokens,
      messageCount: messages.length,
    });

    // Find cut point: walk backward from end to keep ~keepRecentTokens
    let keptTokens = 0;
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(messages[i]);
      if (keptTokens + msgTokens > keepRecentTokens && cutIndex < messages.length) {
        break;
      }
      keptTokens += msgTokens;
      cutIndex = i;
    }

    // Don't split assistant+toolResult pairs: if cutIndex lands on a toolResult,
    // walk backward to include its assistant message
    while (cutIndex > 0 && hasRole(messages[cutIndex], 'toolResult')) {
      cutIndex--;
    }

    // Need at least 1 message to summarize and 1 to keep
    if (cutIndex <= 0 || cutIndex >= messages.length) {
      log.warn('Cannot find valid cut point for compaction');
      return messages;
    }

    const messagesToSummarize = messages.slice(0, cutIndex);
    const messagesToKeep = stripOrphanedToolResults(messages.slice(cutIndex));

    log.info('Compaction cut point', {
      summarizing: messagesToSummarize.length,
      keeping: messagesToKeep.length,
    });

    // Emit lifecycle hook safely — listener bugs must never abort compaction.
    const emit = (state: CompactionState): void => {
      try {
        config.onCompactionStateChange?.(state);
      } catch (e) {
        log.warn('onCompactionStateChange listener threw', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    // Attempt LLM-powered summarization
    const apiKey = config.getApiKey();
    if (apiKey) {
      try {
        const conversationText = serializeMessages(messagesToSummarize);
        const systemPrompt = buildSharedSystemPrompt(conversationText);
        // Summary uses ~80% of the reserve budget for output, mirroring the
        // pi-coding-agent default.
        const summaryMaxTokens = Math.floor(0.8 * reserveTokens);
        emit('summarizing');
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
          originalMessages: messages.length,
          compactedMessages: 1 + messagesToKeep.length,
          summaryLength: summary.length,
        });

        // Best-effort memory extraction. Same system prompt → cache hit on
        // the conversation block for Anthropic-style providers.
        if (config.onMemoryUpdates) {
          // Memory budget is much smaller — bullets, not a structured doc.
          const memoryMaxTokens = 2048;
          try {
            emit('extracting-memory');
            const bullets = await runCompactionCall(
              config.model,
              apiKey,
              systemPrompt,
              MEMORY_INSTRUCTION,
              memoryMaxTokens,
              config.headers,
              signal
            );
            if (bullets && bullets.trim() && bullets.trim() !== 'NONE') {
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

        emit('idle');
        return [summaryMessage, ...messagesToKeep];
      } catch (err) {
        log.warn('LLM summarization failed, falling back to naive drop', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.warn('No API key available for LLM summarization, falling back to naive drop');
    }
    // Always clear the indicator before returning — both the fallback path
    // and any successful early-return must leave the UI in the resting state.
    emit('idle');

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

    log.info('Naive compaction applied', {
      originalMessages: messages.length,
      compactedMessages: 1 + messagesToKeep.length,
    });

    return [compactedMsg, ...messagesToKeep];
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
    totalTokens += estimateTokens(msg);
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
    const msgTokens = estimateTokens(messages[i]);
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
