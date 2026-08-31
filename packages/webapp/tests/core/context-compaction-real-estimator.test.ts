/**
 * Regression guard for tool-result token accounting — verifies that the real (un-mocked)
 * `estimateTokens` from `@earendil-works/pi-coding-agent` counts the bytes of
 * `toolResult` messages. The bug that motivated this guard was a scoop that
 * filled its context with multi-megabyte base64 image payloads via repeated
 * `open --view` calls; if the estimator did NOT count those payloads,
 * `shouldCompact` would never trigger and the agent loop would wedge.
 *
 * Unlike `context-compaction.test.ts` (which mocks the compaction submodule
 * to keep the LLM-coupled tests deterministic), this file deliberately does
 * NOT mock the compaction module — it imports the real implementation so a
 * regression in pi-coding-agent's `estimateTokens` shape is caught here.
 *
 * `completeSimple` IS still mocked: we only need to verify compaction
 * *triggers*, not that the summary call hits a real API.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompleteSimple = vi.fn();

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
  };
});

// Real, un-mocked estimator — same module that production code imports.
import { estimateTokens } from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { createCompactContext } from '../../src/core/context-compaction.js';

function createToolResult(text: string, toolCallId = 'tool-1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'open',
    content: [{ type: 'text' as const, text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

function createUser(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text' as const, text }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function createAssistantWithToolCall(text: string, toolCallId: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text' as const, text },
      { type: 'toolCall' as const, id: toolCallId, name: 'open', arguments: {} },
    ],
    timestamp: 0,
  } as unknown as AgentMessage;
}

/**
 * Assistant turn whose bulk lives in `thinkingSignature` — the opaque blob
 * Anthropic returns with every thinking block and requires echoed back on the
 * next request. It occupies real context but pi-coding-agent's `estimateTokens`
 * walks only `block.thinking`.
 */
function createThinkingTurn(signatureChars: number, thinking = 'brief'): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking' as const, thinking, thinkingSignature: 's'.repeat(signatureChars) },
      { type: 'text' as const, text: 'ok' },
    ],
    timestamp: 0,
  } as unknown as AgentMessage;
}

/** Assistant turn carrying counted text, optionally with a provider usage record. */
function createTextTurn(
  text: string,
  usage?: Record<string, unknown>,
  stopReason?: string
): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text' as const, text }],
    timestamp: 0,
    ...(usage ? { usage } : {}),
    ...(stopReason ? { stopReason } : {}),
  } as unknown as AgentMessage;
}

function usageRecord(totalTokens: number) {
  return {
    input: 0,
    output: 0,
    cacheRead: totalTokens,
    cacheWrite: 0,
    totalTokens,
    cost: {},
  };
}

/** What the upstream heuristic alone would report for a message list. */
function upstreamTotal(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function llmResponse(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    timestamp: 0,
  };
}

describe('estimateTokens (real implementation)', () => {
  it('counts text bytes inside a toolResult content block', () => {
    const oneMb = 'x'.repeat(1_000_000);
    const tokens = estimateTokens(createToolResult(oneMb));
    // chars/4 heuristic — 1 MB of text should land near 250k tokens.
    expect(tokens).toBeGreaterThan(200_000);
  });

  it('counts text bytes inside a toolResult when content is a plain string', () => {
    const oneMb = 'x'.repeat(1_000_000);
    const msg = {
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'open',
      content: oneMb,
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;
    expect(estimateTokens(msg)).toBeGreaterThan(200_000);
  });
});

describe('createCompactContext with the real estimator', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    // Small window so a single ~1 MB tool result blows the threshold.
    contextWindow: 100_000,
  };

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('summary'));
  });

  it('triggers compaction when one ~1 MB toolResult dominates the window', async () => {
    const oneMb = 'x'.repeat(1_000_000);
    const messages: AgentMessage[] = [
      createUser('please read the image'),
      createAssistantWithToolCall('opening it now', 'tool-1'),
      createToolResult(oneMb, 'tool-1'),
      createUser('what did you find?'),
    ];

    const result = await createCompactContext(mockConfig)(messages);

    // The oversized toolResult being elided proves shouldCompact returned true,
    // which proves the real estimateTokens counted the toolResult bytes — the
    // whole point of this regression guard. If a future pi-coding-agent release
    // changes `estimateTokens` to drop toolResult accounting, total would be
    // tiny, shouldCompact false, and the messages returned unchanged (blob
    // intact), failing these assertions.
    const resultText = JSON.stringify(result);
    expect(resultText).not.toContain('x'.repeat(1000));
    expect(resultText).toContain('Tool result elided');
    // #2011: a single oversized message is stubbed in place — no doomed LLM
    // summary round-trip (sending it would re-blow the window).
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('does NOT trigger compaction when toolResult payloads are small', async () => {
    const small = 'x'.repeat(100);
    const messages: AgentMessage[] = [
      createUser('hi'),
      createAssistantWithToolCall('calling', 'tool-1'),
      createToolResult(small, 'tool-1'),
      createUser('thanks'),
    ];

    await createCompactContext(mockConfig)(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });
});

/**
 * Regression guard for the `interview-me` scoop (2026-08-31), read live off the
 * production instance over CDP: 1,696 messages, provider reporting 985,427 of a
 * 1,000,000-token window (98.5% full), while `estimateTotalTokens` reported
 * 496,129 — barely half the 983,616 trigger. The scoop was ~16 turns from a hard
 * context-overflow that proactive compaction should have prevented.
 *
 * Two independent causes, one per describe block below:
 *
 *  1. 1,099,252 chars of `thinkingSignature` across 471 thinking blocks that
 *     upstream's `estimateTokens` does not walk at all.
 *  2. Even with those counted the heuristic lands near 771k, because chars/4 runs
 *     generous for code and JSON. The provider already told us the real number in
 *     the last turn's `usage`; the trigger now believes it.
 */
describe('thinkingSignature accounting', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 100_000,
  };
  // contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens
  const threshold = 100_000 - 16_384;

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('summary'));
  });

  it('upstream estimateTokens does not count thinkingSignature', () => {
    // Tripwire, not an endorsement: if a future pi-coding-agent starts counting
    // the signature this fails, and `estimateMessageTokens` can drop its wrapper.
    const turn = createThinkingTurn(400_000, 'brief');
    expect(estimateTokens(turn)).toBeLessThan(100);
  });

  it('triggers compaction when thinkingSignature blobs fill the window', async () => {
    // 6 turns x 80,000 signature chars = 120,000 tokens once counted.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), createThinkingTurn(80_000));
    }

    // The premise: upstream's heuristic alone would never arm compaction here.
    expect(upstreamTotal(messages)).toBeLessThan(threshold);

    const result = await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result[0])).toContain('<context-summary>');
    expect(result.length).toBeLessThan(messages.length);
  });

  it('does NOT trigger when the same turns carry no signature', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'brief' }],
        timestamp: 0,
      } as unknown as AgentMessage);
    }

    const result = await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });

  it('prices the kept tail by signature weight too', async () => {
    // keepRecentTokens is 20,000; one 80,000-char signature turn is 20,000 tokens
    // on its own, so the cut must keep exactly that turn — not a tail that is
    // nominally 20,000 tokens but really four times that.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), createThinkingTurn(80_000));
    }

    const result = await createCompactContext(mockConfig)(messages);

    // [summary, last assistant turn]
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(messages[messages.length - 1]);
  });
});

describe('provider-reported usage in the compaction trigger', () => {
  const mockModel = { id: 'test-model' } as unknown as Model<Api>;
  const mockConfig = {
    model: mockModel,
    getApiKey: () => 'test-key' as string | undefined,
    contextWindow: 100_000,
  };
  const threshold = 100_000 - 16_384;

  /**
   * Heuristic total ~40,000 (under the threshold) and long enough that a cut
   * point exists. `usage` on the final assistant turn is what decides.
   */
  function conversation(usage?: Record<string, unknown>, stopReason?: string): AgentMessage[] {
    const body = 'a'.repeat(40_000); // 10,000 tokens each
    return [
      createUser('one'),
      createTextTurn(body),
      createUser('two'),
      createTextTurn(body),
      createUser('three'),
      createTextTurn(body),
      createUser('four'),
      createTextTurn(body, usage, stopReason),
    ];
  }

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue(llmResponse('summary'));
  });

  it('trusts the reported usage over the optimistic heuristic', async () => {
    const messages = conversation(usageRecord(95_000));
    expect(upstreamTotal(messages)).toBeLessThan(threshold);

    const result = await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result[0])).toContain('<context-summary>');
  });

  it('ignores usage from an errored or aborted turn', async () => {
    for (const stopReason of ['error', 'aborted']) {
      mockCompleteSimple.mockClear();
      const messages = conversation(usageRecord(95_000), stopReason);
      // The record is present but meaningless — fall back to the heuristic.
      const result = await createCompactContext(mockConfig)(messages);
      expect(mockCompleteSimple, stopReason).not.toHaveBeenCalled();
      expect(result).toBe(messages);
    }
  });

  it('ignores an all-zero usage record', async () => {
    const messages = conversation(usageRecord(0));
    const result = await createCompactContext(mockConfig)(messages);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });

  it('still triggers when the heuristic exceeds a stale small usage', async () => {
    // A usage record that predates the tail must never suppress the trigger:
    // the estimate is the max of the two, not a replacement.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(createUser(`step ${i}`), createThinkingTurn(80_000));
    }
    (messages[messages.length - 1] as unknown as { usage: unknown }).usage = usageRecord(500);

    await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });

  it('counts messages appended after the last reported usage', async () => {
    // Usage 80,000 is just under the 83,616 threshold; the turn appended after
    // it carries the total over.
    const messages = [...conversation(usageRecord(80_000))];
    expect(upstreamTotal(messages)).toBeLessThan(threshold);
    messages.push(createUser('x'.repeat(40_000)));

    await createCompactContext(mockConfig)(messages);

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });
});
