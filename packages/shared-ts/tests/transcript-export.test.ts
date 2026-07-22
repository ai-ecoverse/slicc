import { describe, expect, it } from 'vitest';
import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  validateTranscriptDocumentV1,
  type TranscriptDocumentV1,
} from '../src/transcript-export.js';

const completeDocument = (): TranscriptDocumentV1 => ({
  schemaVersion: 1,
  export: {
    id: 'export-1',
    generatedAt: '2026-07-22T12:00:00.000Z',
    producer: { application: 'slicc', version: '5.65.2' },
    format: 'slicc-transcript',
  },
  session: {
    id: 'session-1',
    title: 'Redacted example',
    state: 'active',
    completeness: { status: 'complete', missing: [] },
  },
  privacy: {
    reasoningExcluded: true,
    excludedReasoningBlocks: 1,
    binaryAttachments: 'included-unchanged',
    redactionCounts: { token: 1 },
    redactions: [
      {
        id: 'r1',
        category: 'token',
        detector: 'credential-pattern',
        target: { kind: 'json', pointer: '/conversations/0/messages/0/content/0/text' },
      },
    ],
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
          timestamp: '2026-07-22T12:00:00.000Z',
          content: [{ type: 'text', text: 'Use ⟦REDACTED:token:r1⟧' }],
        },
      ],
    },
  ],
  delegations: [],
  attachments: [],
});

describe('TranscriptDocumentV1', () => {
  it('accepts the public complete document shape', () => {
    expect(TRANSCRIPT_SCHEMA_VERSION).toBe(1);
    expect(SLICC_TRANSCRIPT_FORMAT).toBe('slicc-transcript');
    expect(validateTranscriptDocumentV1(completeDocument())).toEqual({ ok: true });
  });

  it('rejects unsupported schema versions', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['schemaVersion'] = 2;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'schemaVersion must equal 1',
    });
  });

  it('rejects non-object input', () => {
    expect(validateTranscriptDocumentV1(null)).toEqual({
      ok: false,
      error: 'document must be a non-null object',
    });
    expect(validateTranscriptDocumentV1('string')).toEqual({
      ok: false,
      error: 'document must be a non-null object',
    });
  });

  it('rejects missing required top-level fields', () => {
    const noExport = { ...completeDocument(), export: undefined };
    expect(validateTranscriptDocumentV1(noExport)).toEqual({
      ok: false,
      error: 'export must be a non-null object',
    });
  });

  it('rejects invalid export.format', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['export'] as Record<string, unknown>)['format'] = 'wrong-format';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export.format must equal "slicc-transcript"',
    });
  });

  it('rejects invalid privacy.reasoningExcluded', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['reasoningExcluded'] = false;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.reasoningExcluded must be true',
    });
  });

  it('rejects invalid conversation kind', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    convs[0]['kind'] = 'invalid-kind';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].kind must be "cone" or "scoop"',
    });
  });

  it('rejects invalid message role', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    msgs[0]['role'] = 'invalid-role';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].role must be "user", "assistant", or "tool-result"',
    });
  });

  it('rejects invalid content block type', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    const content = msgs[0]['content'] as Array<Record<string, unknown>>;
    content[0]['type'] = 'reasoning';
    const expected =
    'conversations[0].messages[0].content[0].type must be "text", "tool-call", or "attachment-ref"';
    expect(validateTranscriptDocumentV1(bad)).toEqual({ ok: false, error: expected });
  });
});
