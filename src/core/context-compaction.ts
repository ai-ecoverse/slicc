/**
 * Context compaction — truncates oversized tool results and drops old messages
 * to keep the conversation context within token limits.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { createLogger } from './logger.js';

const log = createLogger('context-compaction');

/** Max chars per tool result before truncation (~2000 tokens). */
export const MAX_RESULT_CHARS = 8000;

/** Max total context chars (~150K tokens — leave headroom below the 200K limit). */
export const MAX_CONTEXT_CHARS = 600000;

/**
 * Compact agent message context by:
 * 1. Truncating oversized tool result content
 * 2. Dropping older messages when total size exceeds the limit
 *
 * Preserves the first 2 messages (system context) and last 10 messages (recent context).
 */
export async function compactContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  // Step 1: truncate oversized content in tool result messages
  const truncated = messages.map((msg) => {
    if (msg.role === 'toolResult' && Array.isArray((msg as any).content)) {
      const content = (msg as any).content as Array<{ type: 'text'; text?: string }>;
      const needsTruncation = content.some((c) => c.type === 'text' && c.text && c.text.length > MAX_RESULT_CHARS);
      if (needsTruncation) {
        return {
          ...msg,
          content: content.map((c) =>
            c.type === 'text' && c.text && c.text.length > MAX_RESULT_CHARS
              ? { ...c, text: c.text.slice(0, MAX_RESULT_CHARS) + '\n... (truncated)' }
              : c,
          ),
        } as typeof msg;
      }
    }
    return msg;
  });

  // Step 2: estimate total size and drop older messages if too large
  const estimateSize = (msgs: typeof truncated): number => {
    return msgs.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  };

  let result = truncated;
  let totalChars = estimateSize(result);

  // Keep dropping oldest non-system messages until under limit (preserve first 2 and last 10)
  // Safety limit to prevent infinite loop if compaction can't reduce size enough
  let compactionRounds = 0;
  while (totalChars > MAX_CONTEXT_CHARS && result.length > 12 && compactionRounds < 50) {
    compactionRounds++;
    const compactedMsg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: '[Earlier conversation messages were compacted to save context space]' }],
    };
    result = [result[0], result[1], compactedMsg as any, ...result.slice(result.length - 10)];
    totalChars = estimateSize(result);
  }
  if (compactionRounds >= 50) {
    log.warn('Context compaction hit iteration limit', { finalChars: totalChars, finalMessages: result.length });
  }

  if (totalChars !== estimateSize(messages)) {
    log.info('Context compacted', {
      originalMessages: messages.length,
      compactedMessages: result.length,
      originalChars: estimateSize(messages),
      compactedChars: totalChars,
    });
  }

  return result;
}
