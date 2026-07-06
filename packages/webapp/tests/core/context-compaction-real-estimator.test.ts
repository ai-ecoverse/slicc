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

    await createCompactContext(mockConfig)(messages);

    // completeSimple firing proves shouldCompact returned true, which proves
    // the real estimateTokens counted the toolResult bytes — the whole point
    // of this regression guard. If a future pi-coding-agent release changes
    // `estimateTokens` to drop toolResult accounting, this assertion fails.
    expect(mockCompleteSimple).toHaveBeenCalled();
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
