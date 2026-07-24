/**
 * Test fixtures for transcript normalizer tests.
 *
 * These construct minimal-valid Pi AgentMessage arrays and TranscriptDocumentV1
 * values for unit-testing normalize.ts. They must not call any production
 * normalizer or redactor.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptDocumentV1,
} from '@slicc/shared-ts';

// ---------------------------------------------------------------------------
// Usage fixture helper
// ---------------------------------------------------------------------------

/** Returns a minimal usage object. Defaults: input=1, output=1, totalTokens=2, all costs=0. */
export function makeUsage(
  overrides: { input?: number; output?: number; totalTokens?: number } = {}
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
  const { input = 1, output = 1, totalTokens = 2 } = overrides;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ---------------------------------------------------------------------------
// AgentMessage fixtures
// ---------------------------------------------------------------------------

/** Minimal set of Pi AgentMessages for a complete cone conversation. */
export function makeAgentMessages(): AgentMessage[] {
  return [
    {
      role: 'user',
      content: 'inspect it',
      timestamp: 1_000,
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private chain' },
        { type: 'text', text: 'I will inspect it.' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'bash',
          arguments: { command: 'cat big.txt' },
        },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: {
        input: 20,
        output: 5,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 35,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
      },
      stopReason: 'toolUse',
      timestamp: 2_000,
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'x'.repeat(70_000) }],
      isError: false,
      timestamp: 3_000,
    },
  ];
}

// ---------------------------------------------------------------------------
// TranscriptDocumentV1 fixture
// ---------------------------------------------------------------------------

interface MakeTranscriptDocumentOptions {
  toolInput?: unknown;
  text?: string;
}

/** Returns a complete, valid TranscriptDocumentV1 for schema-level tests. */
export function makeTranscriptDocument(
  overrides: MakeTranscriptDocumentOptions = {}
): TranscriptDocumentV1 {
  const { toolInput = { command: 'ls' }, text = 'Done.' } = overrides;
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    export: {
      id: 'exp-fixture-001',
      generatedAt: '2024-01-01T00:00:00.000Z',
      producer: { application: 'slicc', version: '0.0.0-test' },
      format: SLICC_TRANSCRIPT_FORMAT,
    },
    session: {
      id: 'sess-fixture-001',
      title: 'Fixture session',
      state: 'active',
      completeness: { status: 'complete', missing: [] },
    },
    privacy: {
      reasoningExcluded: true,
      excludedReasoningBlocks: 0,
      binaryAttachments: 'included-unchanged',
      redactionCounts: {},
      redactions: [],
    },
    conversations: [
      {
        id: 'cone',
        kind: 'cone',
        name: 'Sliccy',
        messages: [
          {
            id: 'cone-msg-000001',
            sequence: 1,
            role: 'user',
            timestamp: new Date(1_000).toISOString(),
            content: [{ type: 'text', text: 'inspect it' }],
          },
          {
            id: 'cone-msg-000002',
            sequence: 2,
            role: 'assistant',
            timestamp: new Date(2_000).toISOString(),
            content: [
              { type: 'text', text },
              { type: 'tool-call', id: 'call-1', name: 'bash', input: toolInput },
            ],
            model: { provider: 'anthropic', id: 'claude-sonnet-4-6', api: 'anthropic-messages' },
          },
        ],
      },
    ],
    delegations: [],
    attachments: [],
  };
}
