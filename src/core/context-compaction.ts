/**
 * Context compaction — LLM-summarized context replacement.
 *
 * Aligned with pi-mono's compaction strategy: when context approaches the limit,
 * an LLM call generates a structured summary of older messages, which replaces them
 * as a single user message. This preserves the conversation prefix (cache-friendly)
 * and keeps recent messages intact.
 *
 * Uses generateSummary(), estimateTokens(), shouldCompact(), and DEFAULT_COMPACTION_SETTINGS
 * from @mariozechner/pi-coding-agent.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
// Deep import to the compaction submodule — the main entry re-exports 113 Node-only
// modules that would break Vite's browser bundle. The compaction submodule itself
// only depends on @mariozechner/pi-ai (already a browser-safe dependency).
// Types are declared in src/types/pi-coding-agent-compaction.d.ts.
import {
  generateSummary,
  estimateTokens,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
} from '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js';
import { createLogger } from './logger.js';

const log = createLogger('context-compaction');

/** Safety cap for a single tool result — prevents blowing the window in one turn. */
export const MAX_SINGLE_RESULT_CHARS = 50000;

/** Default context window for Claude models. */
const DEFAULT_CONTEXT_WINDOW = 200000;

export interface CompactionConfig {
  model: Model<any>;
  getApiKey: () => string | undefined;
  contextWindow?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

/**
 * Create a transformContext function that uses LLM summarization for compaction.
 *
 * The returned function:
 * 1. Checks if total tokens exceed (contextWindow - reserveTokens)
 * 2. If so, finds a cut point that keeps ~keepRecentTokens of recent messages
 * 3. Calls generateSummary() to produce a structured summary of older messages
 * 4. Replaces the older messages with a single summary user message
 * 5. Falls back to naive drop if the LLM call fails
 */
export function createCompactContext(config: CompactionConfig): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
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

    log.info('Context compaction triggered', { totalTokens, contextWindow, threshold: contextWindow - reserveTokens, messageCount: messages.length });

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
    while (cutIndex > 0 && (messages[cutIndex] as any).role === 'toolResult') {
      cutIndex--;
    }

    // Need at least 1 message to summarize and 1 to keep
    if (cutIndex <= 0 || cutIndex >= messages.length) {
      log.warn('Cannot find valid cut point for compaction');
      return messages;
    }

    const messagesToSummarize = messages.slice(0, cutIndex);
    const messagesToKeep = messages.slice(cutIndex);

    log.info('Compaction cut point', { summarizing: messagesToSummarize.length, keeping: messagesToKeep.length });

    // Attempt LLM-powered summarization
    const apiKey = config.getApiKey();
    if (apiKey) {
      try {
        const summary = await generateSummary(
          messagesToSummarize,
          config.model,
          reserveTokens,
          apiKey,
          signal,
        );

        const summaryMessage: AgentMessage = {
          role: 'user',
          content: [{ type: 'text', text: `<context-summary>\n${summary}\n</context-summary>` }],
        } as any;

        log.info('LLM summarization successful', {
          originalMessages: messages.length,
          compactedMessages: 1 + messagesToKeep.length,
          summaryLength: summary.length,
        });

        return [summaryMessage, ...messagesToKeep];
      } catch (err) {
        log.warn('LLM summarization failed, falling back to naive drop', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.warn('No API key available for LLM summarization, falling back to naive drop');
    }

    // Fallback: naive drop (same as old behavior but without eager truncation)
    const compactedMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: '[Earlier conversation messages were compacted to save context space]' }],
    } as any;

    log.info('Naive compaction applied', {
      originalMessages: messages.length,
      compactedMessages: 1 + messagesToKeep.length,
    });

    return [compactedMsg, ...messagesToKeep];
  };
}

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
  while (cutIndex > 0 && (messages[cutIndex] as any).role === 'toolResult') {
    cutIndex--;
  }

  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return messages;
  }

  const compactedMsg: AgentMessage = {
    role: 'user',
    content: [{ type: 'text', text: '[Earlier conversation messages were compacted to save context space]' }],
  } as any;

  const result = [compactedMsg, ...messages.slice(cutIndex)];

  log.info('Context compacted (legacy)', {
    originalMessages: messages.length,
    compactedMessages: result.length,
  });

  return result;
}
