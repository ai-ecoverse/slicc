import { describe, expect, it } from 'vitest';
import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptDocumentV1,
  TranscriptExportError,
  VALID_COMPLETENESS_REASONS,
  validateTranscriptDocumentV1,
} from '../src/transcript-export.js';

/** Opaque 64-char hex string safe to use as a placeholder SHA-256. */
const VALID_SHA256 = 'a'.repeat(64);

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

describe('TranscriptExportError', () => {
  it('sets code, name, and message correctly', () => {
    const err = new TranscriptExportError('permission-denied');
    expect(err.code).toBe('permission-denied');
    expect(err.name).toBe('TranscriptExportError');
    expect(err.message).toBe('permission-denied');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves each error code', () => {
    const codes = [
      'permission-denied',
      'redaction-unavailable',
      'session-not-found',
      'transfer-aborted',
      'transfer-corrupt',
      'schema-invalid',
      'attachment-unreadable',
    ] as const;
    for (const code of codes) {
      expect(new TranscriptExportError(code).code).toBe(code);
    }
  });
});

describe('validateTranscriptDocumentV1 — export section', () => {
  it('rejects non-object export', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['export'] = 'not-an-object';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export must be a non-null object',
    });
  });

  it('rejects missing export.id', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    delete (bad['export'] as Record<string, unknown>)['id'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export.id must be a string',
    });
  });

  it('rejects missing export.generatedAt', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    delete (bad['export'] as Record<string, unknown>)['generatedAt'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export.generatedAt must be a string',
    });
  });

  it('rejects non-object export.producer', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['export'] as Record<string, unknown>)['producer'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export.producer must be a non-null object',
    });
  });

  it('rejects wrong export.producer.application', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['export'] as Record<string, unknown>)['producer'] = {
      application: 'other',
      version: '1.0',
    };
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export.producer.application must equal "slicc"',
    });
  });

  it('rejects missing export.producer.version', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['export'] as Record<string, unknown>)['producer'] = { application: 'slicc' };
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'export.producer.version must be a string',
    });
  });
});

describe('validateTranscriptDocumentV1 — session section', () => {
  it('rejects non-object session', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['session'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session must be a non-null object',
    });
  });

  it('rejects missing session.id', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    delete (bad['session'] as Record<string, unknown>)['id'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.id must be a string',
    });
  });

  it('rejects missing session.title', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    delete (bad['session'] as Record<string, unknown>)['title'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.title must be a string',
    });
  });

  it('rejects invalid session.state', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['session'] as Record<string, unknown>)['state'] = 'archived';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.state must be "active" or "frozen"',
    });
  });

  it('rejects non-object session.completeness', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['session'] as Record<string, unknown>)['completeness'] = 'complete';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.completeness must be a non-null object',
    });
  });

  it('rejects invalid session.completeness.status', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['session'] as Record<string, unknown>)['completeness'] = {
      status: 'done',
      missing: [],
    };
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.completeness.status must be "complete" or "partial"',
    });
  });

  it('rejects non-array session.completeness.missing', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['session'] as Record<string, unknown>)['completeness'] = {
      status: 'complete',
      missing: 'none',
    };
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.completeness.missing must be an array',
    });
  });
});

describe('validateTranscriptDocumentV1 — privacy section', () => {
  it('rejects non-object privacy', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['privacy'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy must be a non-null object',
    });
  });

  it('rejects missing privacy.excludedReasoningBlocks', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    delete (bad['privacy'] as Record<string, unknown>)['excludedReasoningBlocks'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.excludedReasoningBlocks must be a number',
    });
  });

  it('rejects invalid privacy.binaryAttachments', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['binaryAttachments'] = 'excluded';
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.binaryAttachments must equal "included-unchanged"',
    });
  });

  it('rejects non-object privacy.redactionCounts', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactionCounts'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactionCounts must be a non-null object',
    });
  });

  it('rejects non-array privacy.redactions', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactions must be an array',
    });
  });

  it('rejects non-object redaction entry', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = ['not-an-object'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactions[0] must be a non-null object',
    });
  });

  it('rejects redaction with missing id', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = [
      { category: 'token', detector: 'credential-pattern', target: { kind: 'json' } },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactions[0].id must be a string',
    });
  });

  it('rejects redaction with missing category', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = [
      { id: 'r1', detector: 'credential-pattern', target: { kind: 'json' } },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactions[0].category must be a string',
    });
  });

  it('rejects redaction with invalid detector', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = [
      { id: 'r1', category: 'token', detector: 'manual', target: { kind: 'json' } },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error:
        'privacy.redactions[0].detector must be "known-secret", "credential-pattern", or "pre-obfuscated"',
    });
  });

  it('rejects redaction with non-object target', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = [
      { id: 'r1', category: 'token', detector: 'credential-pattern', target: null },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target must be a non-null object',
    });
  });

  it('rejects redaction with invalid target.kind', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['privacy'] as Record<string, unknown>)['redactions'] = [
      {
        id: 'r1',
        category: 'token',
        detector: 'credential-pattern',
        target: { kind: 'html' },
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target.kind must be "json" or "attachment"',
    });
  });
});

describe('validateTranscriptDocumentV1 — conversations and messages', () => {
  it('rejects non-array conversations', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['conversations'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations must be an array',
    });
  });

  it('rejects non-object conversation entry', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['conversations'] = ['not-an-object'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0] must be a non-null object',
    });
  });

  it('rejects conversation with missing id', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    delete convs[0]['id'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].id must be a string',
    });
  });

  it('rejects conversation with missing name', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    delete convs[0]['name'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].name must be a string',
    });
  });

  it('rejects non-array messages', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    convs[0]['messages'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages must be an array',
    });
  });

  it('rejects non-object message entry', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    convs[0]['messages'] = ['not-an-object'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0] must be a non-null object',
    });
  });

  it('rejects message with missing id', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    delete msgs[0]['id'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].id must be a string',
    });
  });

  it('rejects message with missing sequence', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    delete msgs[0]['sequence'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].sequence must be a number',
    });
  });

  it('rejects message with missing timestamp', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    delete msgs[0]['timestamp'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].timestamp must be a string',
    });
  });

  it('rejects message with non-array content', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    msgs[0]['content'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content must be an array',
    });
  });

  it('rejects non-object content block', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = bad['conversations'] as Array<Record<string, unknown>>;
    const msgs = convs[0]['messages'] as Array<Record<string, unknown>>;
    msgs[0]['content'] = ['not-an-object'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0] must be a non-null object',
    });
  });
});

describe('validateTranscriptDocumentV1 — delegations and attachments', () => {
  it('rejects non-array delegations', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['delegations'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'delegations must be an array',
    });
  });

  it('rejects non-array attachments', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = null;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments must be an array',
    });
  });

  it('accepts a valid attachment entry', () => {
    const doc = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (doc['attachments'] as unknown[]).push({
      id: 'att-1',
      path: 'attachments/att-0001.png',
      originalName: 'image.png',
      mimeType: 'image/png',
      sha256: VALID_SHA256,
      byteLength: 1024,
      present: true,
      handling: 'binary-unchanged',
      sourceConversationId: 'cone',
      sourceMessageId: 'cone-msg-000001',
    });
    expect(validateTranscriptDocumentV1(doc)).toEqual({ ok: true });
  });

  it('rejects non-object attachment entry', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = ['not-an-object'];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0] must be a non-null object',
    });
  });

  it('rejects attachment with missing id', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = [
      {
        path: '/tmp/image.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        byteLength: 1024,
        present: true,
        handling: 'binary-unchanged',
        sourceConversationId: 'cone',
        sourceMessageId: 'msg-1',
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0].id must be a string',
    });
  });

  it('rejects attachment with missing byteLength', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = [
      {
        id: 'att-1',
        path: '/tmp/image.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        present: true,
        handling: 'binary-unchanged',
        sourceConversationId: 'cone',
        sourceMessageId: 'msg-1',
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0].byteLength must be a number',
    });
  });

  it('rejects attachment with missing present flag', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = [
      {
        id: 'att-1',
        path: '/tmp/image.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        byteLength: 1024,
        handling: 'binary-unchanged',
        sourceConversationId: 'cone',
        sourceMessageId: 'msg-1',
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0].present must be a boolean',
    });
  });

  it('rejects attachment with missing sourceConversationId', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = [
      {
        id: 'att-1',
        path: '/tmp/image.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        byteLength: 1024,
        present: true,
        handling: 'binary-unchanged',
        sourceMessageId: 'msg-1',
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0].sourceConversationId must be a string',
    });
  });

  it('rejects attachment with missing sourceMessageId', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = [
      {
        id: 'att-1',
        path: '/tmp/image.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        byteLength: 1024,
        present: true,
        handling: 'binary-unchanged',
        sourceConversationId: 'cone',
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0].sourceMessageId must be a string',
    });
  });

  it('rejects attachment with invalid handling', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['attachments'] = [
      {
        id: 'att-1',
        path: '/tmp/image.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        byteLength: 1024,
        present: true,
        handling: 'redacted',
        sourceConversationId: 'cone',
        sourceMessageId: 'msg-1',
      },
    ];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'attachments[0].handling must be "text-redacted" or "binary-unchanged"',
    });
  });
});

// ---------------------------------------------------------------------------
// NEW: VALID_COMPLETENESS_REASONS export sanity
// ---------------------------------------------------------------------------

describe('VALID_COMPLETENESS_REASONS', () => {
  it('exports all seven completeness reasons', () => {
    expect(VALID_COMPLETENESS_REASONS).toHaveLength(7);
    expect(VALID_COMPLETENESS_REASONS).toContain('canonical-agent-history-unavailable');
    expect(VALID_COMPLETENESS_REASONS).toContain('complete-snapshot-unavailable');
  });
});

// ---------------------------------------------------------------------------
// NEW: Content block type-specific validation (PR review: text without text)
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — content block type-specific', () => {
  function docWithBlock(block: Record<string, unknown>): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const msgs = (d['conversations'] as Array<Record<string, unknown>>)[0]!['messages'] as Array<
      Record<string, unknown>
    >;
    msgs[0]!['content'] = [block];
    return d;
  }

  it('rejects text block without text field (PR review adversarial)', () => {
    expect(validateTranscriptDocumentV1(docWithBlock({ type: 'text' }))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].text must be a string',
    });
  });

  it('rejects text block with non-string text', () => {
    expect(validateTranscriptDocumentV1(docWithBlock({ type: 'text', text: 42 }))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].text must be a string',
    });
  });

  it('rejects tool-call block without id', () => {
    expect(
      validateTranscriptDocumentV1(docWithBlock({ type: 'tool-call', name: 'bash', input: {} }))
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].id must be a non-empty string',
    });
  });

  it('rejects tool-call block with empty id', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithBlock({ type: 'tool-call', id: '', name: 'bash', input: {} })
      )
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].id must be a non-empty string',
    });
  });

  it('rejects tool-call block without name', () => {
    expect(
      validateTranscriptDocumentV1(docWithBlock({ type: 'tool-call', id: 'tc-1', input: {} }))
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].name must be a non-empty string',
    });
  });

  it('rejects tool-call block with empty name', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithBlock({ type: 'tool-call', id: 'tc-1', name: '', input: {} })
      )
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].name must be a non-empty string',
    });
  });

  it('rejects tool-call block without input field', () => {
    expect(
      validateTranscriptDocumentV1(docWithBlock({ type: 'tool-call', id: 'tc-1', name: 'bash' }))
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].input must be present',
    });
  });

  it('accepts tool-call block with null input (input presence only required)', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithBlock({ type: 'tool-call', id: 'tc-1', name: 'bash', input: null })
      )
    ).toEqual({ ok: true });
  });

  it('rejects attachment-ref block without attachmentId', () => {
    expect(validateTranscriptDocumentV1(docWithBlock({ type: 'attachment-ref' }))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].attachmentId must be a non-empty string',
    });
  });

  it('rejects attachment-ref block with empty attachmentId', () => {
    expect(
      validateTranscriptDocumentV1(docWithBlock({ type: 'attachment-ref', attachmentId: '' }))
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].content[0].attachmentId must be a non-empty string',
    });
  });
});

// ---------------------------------------------------------------------------
// NEW: Delegation structural validation (PR review: delegations:[null])
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — delegation structural validation', () => {
  it('rejects null delegation entry (PR review: delegations:[null])', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['delegations'] = [null];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'delegations[0] must be a non-null object',
    });
  });

  it('rejects delegation without sourceConversationId', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['delegations'] = [{ targetConversationId: 'conv-b' }];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'delegations[0].sourceConversationId must be a string',
    });
  });

  it('rejects delegation without targetConversationId', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['delegations'] = [{ sourceConversationId: 'cone' }];
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'delegations[0].targetConversationId must be a string',
    });
  });

  it('accepts minimal valid delegation', () => {
    const doc = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const convs = doc['conversations'] as Array<Record<string, unknown>>;
    convs.push({ id: 'scoop-1', kind: 'scoop', name: 'Sub', messages: [] });
    doc['delegations'] = [{ sourceConversationId: 'cone', targetConversationId: 'scoop-1' }];
    expect(validateTranscriptDocumentV1(doc)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// NEW: Completeness reasons enum (PR review: unknown reason)
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — completeness reasons', () => {
  it('rejects unknown completeness reason (PR review adversarial)', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['session'] as Record<string, unknown>)['completeness'] = {
      status: 'partial',
      missing: ['not-a-real-reason'],
    };
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.completeness.missing[0] is not a valid completeness reason',
    });
  });

  it('rejects null in completeness missing array', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (bad['session'] as Record<string, unknown>)['completeness'] = {
      status: 'partial',
      missing: [null],
    };
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'session.completeness.missing[0] is not a valid completeness reason',
    });
  });

  it('accepts all seven valid completeness reasons', () => {
    const doc = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (doc['session'] as Record<string, unknown>)['completeness'] = {
      status: 'partial',
      missing: [...VALID_COMPLETENESS_REASONS],
    };
    expect(validateTranscriptDocumentV1(doc)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// NEW: ISO 8601 timestamp validation
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — ISO 8601 timestamp validation', () => {
  function docWithMsgTimestamp(ts: unknown): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const msgs = (d['conversations'] as Array<Record<string, unknown>>)[0]!['messages'] as Array<
      Record<string, unknown>
    >;
    msgs[0]!['timestamp'] = ts;
    return d;
  }

  it('rejects a non-date-time timestamp string', () => {
    expect(validateTranscriptDocumentV1(docWithMsgTimestamp('not-a-date'))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].timestamp must be a valid ISO 8601 date-time string',
    });
  });

  it('rejects a date-only string (missing time component)', () => {
    expect(validateTranscriptDocumentV1(docWithMsgTimestamp('2024-01-15'))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].timestamp must be a valid ISO 8601 date-time string',
    });
  });

  it('accepts ISO 8601 with Z timezone', () => {
    expect(validateTranscriptDocumentV1(docWithMsgTimestamp('2024-01-15T10:30:00.000Z'))).toEqual({
      ok: true,
    });
  });

  it('accepts ISO 8601 with UTC offset timezone', () => {
    expect(validateTranscriptDocumentV1(docWithMsgTimestamp('2024-01-15T10:30:00+05:30'))).toEqual({
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// NEW: message.sequence positive-integer constraint
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — sequence positive integer', () => {
  function docWithSeq(seq: unknown): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const msgs = (d['conversations'] as Array<Record<string, unknown>>)[0]!['messages'] as Array<
      Record<string, unknown>
    >;
    msgs[0]!['sequence'] = seq;
    return d;
  }

  it('rejects sequence zero', () => {
    expect(validateTranscriptDocumentV1(docWithSeq(0))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].sequence must be a positive integer',
    });
  });

  it('rejects negative sequence', () => {
    expect(validateTranscriptDocumentV1(docWithSeq(-1))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].sequence must be a positive integer',
    });
  });

  it('rejects fractional sequence', () => {
    expect(validateTranscriptDocumentV1(docWithSeq(1.5))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].sequence must be a positive integer',
    });
  });

  it('accepts sequence 1', () => {
    expect(validateTranscriptDocumentV1(docWithSeq(1))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// NEW: Attachment SHA-256 and state invariants
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — attachment SHA-256 and state invariants', () => {
  function makeAttachment(overrides: Record<string, unknown>) {
    return {
      id: 'att-1',
      path: 'attachments/att-0001.png',
      originalName: 'image.png',
      mimeType: 'image/png',
      sha256: VALID_SHA256,
      byteLength: 1024,
      present: true,
      handling: 'binary-unchanged',
      sourceConversationId: 'cone',
      sourceMessageId: 'cone-msg-000001',
      ...overrides,
    };
  }

  function docWithAtt(attOverrides: Record<string, unknown>): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    d['attachments'] = [makeAttachment(attOverrides)];
    return d;
  }

  it('rejects present:true attachment with non-64-hex sha256', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ sha256: 'abc123' }))).toEqual({
      ok: false,
      error: 'attachments[0].sha256 must be a 64-char hex string when present',
    });
  });

  it('rejects present:true attachment with empty sha256', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ sha256: '' }))).toEqual({
      ok: false,
      error: 'attachments[0].sha256 must be a 64-char hex string when present',
    });
  });

  it('accepts present:true attachment with valid 64-char hex sha256', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({}))).toEqual({ ok: true });
  });

  it('accepts present:true with lowercase hex sha256', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ sha256: '0'.repeat(64) }))).toEqual({
      ok: true,
    });
  });

  it('rejects present:true attachment with empty path', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ path: '' }))).toEqual({
      ok: false,
      error: 'attachments[0].path must be non-empty when present',
    });
  });

  it('rejects present:true attachment with negative byteLength', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ byteLength: -1 }))).toEqual({
      ok: false,
      error: 'attachments[0].byteLength must be a non-negative integer when present',
    });
  });

  it('rejects present:true attachment with fractional byteLength', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ byteLength: 1.5 }))).toEqual({
      ok: false,
      error: 'attachments[0].byteLength must be a non-negative integer when present',
    });
  });

  it('accepts present:true attachment with byteLength zero', () => {
    expect(validateTranscriptDocumentV1(docWithAtt({ byteLength: 0 }))).toEqual({ ok: true });
  });

  it('rejects present:true attachment with missingReason set', () => {
    expect(
      validateTranscriptDocumentV1(docWithAtt({ missingReason: 'attachment-file-missing' }))
    ).toEqual({
      ok: false,
      error: 'attachments[0].missingReason must be absent when present is true',
    });
  });

  it('accepts valid present:false attachment', () => {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    d['attachments'] = [
      {
        id: 'att-miss',
        path: '',
        originalName: 'gone.txt',
        mimeType: 'text/plain',
        sha256: '',
        byteLength: 0,
        present: false,
        handling: 'text-redacted',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        missingReason: 'attachment-file-missing',
      },
    ];
    expect(validateTranscriptDocumentV1(d)).toEqual({ ok: true });
  });

  it('rejects present:false attachment with non-empty path', () => {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    d['attachments'] = [
      {
        id: 'att-2',
        path: 'attachments/att-0002.txt',
        originalName: 'x.txt',
        mimeType: 'text/plain',
        sha256: '',
        byteLength: 0,
        present: false,
        handling: 'text-redacted',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        missingReason: 'attachment-file-missing',
      },
    ];
    expect(validateTranscriptDocumentV1(d)).toEqual({
      ok: false,
      error: 'attachments[0].path must be empty when not present',
    });
  });

  it('rejects present:false attachment with non-empty sha256', () => {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    d['attachments'] = [
      {
        id: 'att-3',
        path: '',
        originalName: 'x.txt',
        mimeType: 'text/plain',
        sha256: VALID_SHA256,
        byteLength: 0,
        present: false,
        handling: 'text-redacted',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        missingReason: 'attachment-file-missing',
      },
    ];
    expect(validateTranscriptDocumentV1(d)).toEqual({
      ok: false,
      error: 'attachments[0].sha256 must be empty when not present',
    });
  });

  it('rejects present:false attachment with non-zero byteLength', () => {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    d['attachments'] = [
      {
        id: 'att-4',
        path: '',
        originalName: 'x.txt',
        mimeType: 'text/plain',
        sha256: '',
        byteLength: 5,
        present: false,
        handling: 'text-redacted',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        missingReason: 'attachment-file-missing',
      },
    ];
    expect(validateTranscriptDocumentV1(d)).toEqual({
      ok: false,
      error: 'attachments[0].byteLength must be zero when not present',
    });
  });

  it('rejects present:false attachment without missingReason', () => {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    d['attachments'] = [
      {
        id: 'att-5',
        path: '',
        originalName: 'x.txt',
        mimeType: 'text/plain',
        sha256: '',
        byteLength: 0,
        present: false,
        handling: 'text-redacted',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
      },
    ];
    expect(validateTranscriptDocumentV1(d)).toEqual({
      ok: false,
      error: 'attachments[0].missingReason must equal "attachment-file-missing" when not present',
    });
  });
});

// ---------------------------------------------------------------------------
// NEW: Redaction target type-specific validation (PR review: malformed target)
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — redaction target type-specific', () => {
  function docWithTarget(target: Record<string, unknown>): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (d['privacy'] as Record<string, unknown>)['redactions'] = [
      { id: 'r1', category: 'token', detector: 'credential-pattern', target },
    ];
    return d;
  }

  it('rejects json target without pointer field (PR review: malformed target)', () => {
    expect(validateTranscriptDocumentV1(docWithTarget({ kind: 'json' }))).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target.pointer must be a string',
    });
  });

  it('rejects json target with non-string pointer', () => {
    expect(validateTranscriptDocumentV1(docWithTarget({ kind: 'json', pointer: 42 }))).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target.pointer must be a string',
    });
  });

  it('rejects json target with invalid RFC 6901 pointer (not starting with /)', () => {
    expect(
      validateTranscriptDocumentV1(docWithTarget({ kind: 'json', pointer: 'no-slash' }))
    ).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target.pointer must be a valid RFC 6901 JSON pointer',
    });
  });

  it('accepts json target with empty pointer (root document reference)', () => {
    expect(validateTranscriptDocumentV1(docWithTarget({ kind: 'json', pointer: '' }))).toEqual({
      ok: true,
    });
  });

  it('accepts json target with slash-prefixed pointer', () => {
    expect(
      validateTranscriptDocumentV1(docWithTarget({ kind: 'json', pointer: '/foo/0/bar' }))
    ).toEqual({ ok: true });
  });

  it('rejects attachment target without attachmentId (PR review: malformed target)', () => {
    expect(validateTranscriptDocumentV1(docWithTarget({ kind: 'attachment' }))).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target.attachmentId must be a non-empty string',
    });
  });

  it('rejects attachment target with empty attachmentId', () => {
    expect(
      validateTranscriptDocumentV1(docWithTarget({ kind: 'attachment', attachmentId: '' }))
    ).toEqual({
      ok: false,
      error: 'privacy.redactions[0].target.attachmentId must be a non-empty string',
    });
  });

  it('accepts attachment target with non-empty attachmentId', () => {
    // Must also exist in attachments for relational check — add a matching attachment.
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (d['privacy'] as Record<string, unknown>)['redactions'] = [
      {
        id: 'r1',
        category: 'file',
        detector: 'known-secret',
        target: { kind: 'attachment', attachmentId: 'att-rel' },
      },
    ];
    d['attachments'] = [
      {
        id: 'att-rel',
        path: 'attachments/att-0001.bin',
        originalName: 'file.bin',
        mimeType: 'application/octet-stream',
        sha256: VALID_SHA256,
        byteLength: 8,
        present: true,
        handling: 'binary-unchanged',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
      },
    ];
    expect(validateTranscriptDocumentV1(d)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// NEW: Relational validation
// ---------------------------------------------------------------------------

/**
 * A fully-wired document with all cross-reference relationships correctly set.
 * Used as the base for relational failure tests.
 */
function relationalDoc(): unknown {
  return {
    schemaVersion: 1,
    export: {
      id: 'export-rel-1',
      generatedAt: '2026-07-22T12:00:00.000Z',
      producer: { application: 'slicc', version: '5.65.2' },
      format: 'slicc-transcript',
    },
    session: {
      id: 'session-rel-1',
      title: 'Relational test',
      state: 'active',
      completeness: { status: 'complete', missing: [] },
    },
    privacy: {
      reasoningExcluded: true,
      excludedReasoningBlocks: 0,
      binaryAttachments: 'included-unchanged',
      redactionCounts: {},
      redactions: [
        {
          id: 'r-json-1',
          category: 'token',
          detector: 'credential-pattern',
          target: { kind: 'json', pointer: '/conversations/0/messages/0/content/0/text' },
        },
        {
          id: 'r-att-1',
          category: 'file',
          detector: 'known-secret',
          target: { kind: 'attachment', attachmentId: 'att-1' },
        },
      ],
    },
    conversations: [
      {
        id: 'conv-1',
        kind: 'cone',
        name: 'Main',
        messages: [
          {
            id: 'msg-1',
            sequence: 1,
            role: 'user',
            timestamp: '2026-07-22T12:00:00.000Z',
            content: [{ type: 'text', text: 'Hello' }],
          },
          {
            id: 'msg-2',
            sequence: 2,
            role: 'assistant',
            timestamp: '2026-07-22T12:01:00.000Z',
            content: [{ type: 'tool-call', id: 'tc-1', name: 'bash', input: { command: 'ls' } }],
          },
          {
            id: 'msg-3',
            sequence: 3,
            role: 'tool-result',
            timestamp: '2026-07-22T12:02:00.000Z',
            content: [{ type: 'text', text: 'output' }],
            toolCallId: 'tc-1',
          },
          {
            id: 'msg-4',
            sequence: 4,
            role: 'user',
            timestamp: '2026-07-22T12:03:00.000Z',
            content: [{ type: 'attachment-ref', attachmentId: 'att-1' }],
          },
        ],
      },
      {
        id: 'conv-2',
        kind: 'scoop',
        name: 'Scoop',
        messages: [
          {
            id: 'scoop-msg-1',
            sequence: 1,
            role: 'user',
            timestamp: '2026-07-22T12:04:00.000Z',
            content: [{ type: 'text', text: 'Task' }],
          },
        ],
      },
    ],
    delegations: [
      {
        sourceConversationId: 'conv-1',
        targetConversationId: 'conv-2',
        toolCallId: 'tc-1',
      },
    ],
    attachments: [
      {
        id: 'att-1',
        path: 'attachments/att-0001.png',
        originalName: 'image.png',
        mimeType: 'image/png',
        byteLength: 1024,
        sha256: VALID_SHA256,
        sourceConversationId: 'conv-1',
        sourceMessageId: 'msg-4',
        handling: 'binary-unchanged',
        present: true,
      },
    ],
  };
}

describe('validateTranscriptDocumentV1 — relational validation', () => {
  it('accepts the fully-wired relational document', () => {
    expect(validateTranscriptDocumentV1(relationalDoc())).toEqual({ ok: true });
  });

  it('rejects duplicate conversation IDs', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    (bad['conversations'] as unknown[]).push({
      id: 'conv-1', // duplicate
      kind: 'scoop',
      name: 'Dupe',
      messages: [],
    });
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('duplicate conversation id');
  });

  it('rejects duplicate message IDs', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const conv = (bad['conversations'] as Array<Record<string, unknown>>)[0]!;
    const msgs = conv['messages'] as Array<Record<string, unknown>>;
    msgs.push({ ...msgs[0]!, sequence: 99 }); // same id as msg-1
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('duplicate message id');
  });

  it('rejects non-strictly-increasing sequences', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const conv = (bad['conversations'] as Array<Record<string, unknown>>)[0]!;
    const msgs = conv['messages'] as Array<Record<string, unknown>>;
    msgs[1]!['sequence'] = 1; // same as first → not strictly increasing
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('strictly increasing');
  });

  it('rejects tool-result with non-existent toolCallId', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const conv = (bad['conversations'] as Array<Record<string, unknown>>)[0]!;
    const msgs = conv['messages'] as Array<Record<string, unknown>>;
    msgs[2]!['toolCallId'] = 'nonexistent-tc';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('nonexistent-tc');
  });

  it('rejects attachment-ref with non-existent attachmentId', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const conv = (bad['conversations'] as Array<Record<string, unknown>>)[0]!;
    const msgs = conv['messages'] as Array<Record<string, unknown>>;
    const content = msgs[3]!['content'] as Array<Record<string, unknown>>;
    content[0]!['attachmentId'] = 'nonexistent-att';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('nonexistent-att');
  });

  it('rejects attachment with non-existent sourceConversationId', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const atts = bad['attachments'] as Array<Record<string, unknown>>;
    atts[0]!['sourceConversationId'] = 'no-such-conv';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('no-such-conv');
  });

  it('rejects attachment with non-existent sourceMessageId', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const atts = bad['attachments'] as Array<Record<string, unknown>>;
    atts[0]!['sourceMessageId'] = 'no-such-msg';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('no-such-msg');
  });

  it('rejects delegation with non-existent sourceConversationId', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const dels = bad['delegations'] as Array<Record<string, unknown>>;
    dels[0]!['sourceConversationId'] = 'ghost-conv';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('ghost-conv');
  });

  it('rejects delegation with non-existent targetConversationId', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const dels = bad['delegations'] as Array<Record<string, unknown>>;
    dels[0]!['targetConversationId'] = 'ghost-target';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('ghost-target');
  });

  it('rejects delegation toolCallId not found in source conversation', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const dels = bad['delegations'] as Array<Record<string, unknown>>;
    dels[0]!['toolCallId'] = 'no-such-tc';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('no-such-tc');
  });

  it('rejects attachment-type redaction pointing at non-existent attachment', () => {
    const bad = structuredClone(relationalDoc()) as Record<string, unknown>;
    const reds = (bad['privacy'] as Record<string, unknown>)['redactions'] as Array<
      Record<string, unknown>
    >;
    const attRed = reds.find(
      (r) => (r['target'] as Record<string, unknown>)['kind'] === 'attachment'
    )!;
    (attRed['target'] as Record<string, unknown>)['attachmentId'] = 'phantom-att';
    const r = validateTranscriptDocumentV1(bad);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('phantom-att');
  });
});

// ---------------------------------------------------------------------------
// NEW: excludedReasoningBlocks integer enforcement (F2)
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — excludedReasoningBlocks integer enforcement', () => {
  function docWithExcluded(v: unknown): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    (d['privacy'] as Record<string, unknown>)['excludedReasoningBlocks'] = v;
    return d;
  }

  it('rejects negative excludedReasoningBlocks', () => {
    expect(validateTranscriptDocumentV1(docWithExcluded(-1))).toEqual({
      ok: false,
      error: 'privacy.excludedReasoningBlocks must be a non-negative integer',
    });
  });

  it('rejects fractional excludedReasoningBlocks', () => {
    expect(validateTranscriptDocumentV1(docWithExcluded(0.5))).toEqual({
      ok: false,
      error: 'privacy.excludedReasoningBlocks must be a non-negative integer',
    });
  });

  it('rejects negative-fractional excludedReasoningBlocks', () => {
    expect(validateTranscriptDocumentV1(docWithExcluded(-0.5))).toEqual({
      ok: false,
      error: 'privacy.excludedReasoningBlocks must be a non-negative integer',
    });
  });

  it('accepts zero excludedReasoningBlocks', () => {
    expect(validateTranscriptDocumentV1(docWithExcluded(0))).toEqual({ ok: true });
  });

  it('accepts positive integer excludedReasoningBlocks', () => {
    expect(validateTranscriptDocumentV1(docWithExcluded(5))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// NEW: usage token/cost validation (F3)
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — usage validation', () => {
  function makeUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      ...overrides,
    };
  }

  function docWithUsage(usage: unknown): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const msgs = (d['conversations'] as Array<Record<string, unknown>>)[0]!['messages'] as Array<
      Record<string, unknown>
    >;
    msgs[0]!['usage'] = usage;
    return d;
  }

  it('accepts valid usage object', () => {
    expect(validateTranscriptDocumentV1(docWithUsage(makeUsage()))).toEqual({ ok: true });
  });

  it('preserves numeric costs (decimal values pass)', () => {
    const usage = makeUsage({
      cost: { input: 0.0012345, output: 0.00678, cacheRead: 0.0001, cacheWrite: 0, total: 0.009 },
    });
    expect(validateTranscriptDocumentV1(docWithUsage(usage))).toEqual({ ok: true });
  });

  it('rejects non-object usage', () => {
    expect(validateTranscriptDocumentV1(docWithUsage('bad'))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage must be a non-null object',
    });
  });

  it('rejects fractional input token count', () => {
    expect(validateTranscriptDocumentV1(docWithUsage(makeUsage({ input: 1.5 })))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.input must be a non-negative integer',
    });
  });

  it('rejects negative input token count', () => {
    expect(validateTranscriptDocumentV1(docWithUsage(makeUsage({ input: -1 })))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.input must be a non-negative integer',
    });
  });

  it('rejects fractional output token count', () => {
    expect(validateTranscriptDocumentV1(docWithUsage(makeUsage({ output: 0.5 })))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.output must be a non-negative integer',
    });
  });

  it('rejects missing cost object', () => {
    const u = makeUsage();
    delete u['cost'];
    expect(validateTranscriptDocumentV1(docWithUsage(u))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.cost must be a non-null object',
    });
  });

  it('rejects negative cost.total', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithUsage(
          makeUsage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -0.001 } })
        )
      )
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.cost.total must be a finite non-negative number',
    });
  });

  it('rejects NaN cost.total', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithUsage(
          makeUsage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: NaN } })
        )
      )
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.cost.total must be a finite non-negative number',
    });
  });

  it('rejects Infinity cost.total', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithUsage(
          makeUsage({
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Infinity },
          })
        )
      )
    ).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.cost.total must be a finite non-negative number',
    });
  });

  it('rejects missing cost.input field', () => {
    const cost: Record<string, unknown> = { output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    expect(validateTranscriptDocumentV1(docWithUsage(makeUsage({ cost })))).toEqual({
      ok: false,
      error: 'conversations[0].messages[0].usage.cost.input must be a number',
    });
  });
});

// ---------------------------------------------------------------------------
// NEW: tool-result toolCallId enforcement (F5)
// ---------------------------------------------------------------------------

describe('validateTranscriptDocumentV1 — tool-result toolCallId enforcement', () => {
  function docWithToolResult(msg: Record<string, unknown>): unknown {
    const d = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    const msgs = (d['conversations'] as Array<Record<string, unknown>>)[0]!['messages'] as Array<
      Record<string, unknown>
    >;
    // Add a tool-call first so relational check has something to resolve against.
    msgs.push({
      id: 'msg-tc',
      sequence: 2,
      role: 'assistant',
      timestamp: '2026-07-22T12:01:00.000Z',
      content: [{ type: 'tool-call', id: 'tc-ok', name: 'bash', input: {} }],
    });
    msgs.push({ sequence: 3, timestamp: '2026-07-22T12:02:00.000Z', ...msg });
    return d;
  }

  it('rejects tool-result with empty toolCallId (structural, before relational)', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithToolResult({
          id: 'msg-tr',
          role: 'tool-result',
          content: [{ type: 'text', text: 'out' }],
          toolCallId: '',
        })
      )
    ).toEqual({
      ok: false,
      error:
        'conversations[0].messages[2].toolCallId must be a non-empty string for tool-result messages',
    });
  });

  it('rejects tool-result without toolCallId', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithToolResult({
          id: 'msg-tr',
          role: 'tool-result',
          content: [{ type: 'text', text: 'out' }],
          // no toolCallId
        })
      )
    ).toEqual({
      ok: false,
      error:
        'conversations[0].messages[2].toolCallId must be a non-empty string for tool-result messages',
    });
  });

  it('accepts tool-result with a valid non-empty toolCallId', () => {
    expect(
      validateTranscriptDocumentV1(
        docWithToolResult({
          id: 'msg-tr',
          role: 'tool-result',
          content: [{ type: 'text', text: 'out' }],
          toolCallId: 'tc-ok',
        })
      )
    ).toEqual({ ok: true });
  });
});
