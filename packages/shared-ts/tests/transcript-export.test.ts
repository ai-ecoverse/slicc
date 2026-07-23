import { describe, expect, it } from 'vitest';
import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptDocumentV1,
  TranscriptExportError,
  validateTranscriptDocumentV1,
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
      path: '/tmp/image.png',
      originalName: 'image.png',
      mimeType: 'image/png',
      sha256: 'abc123',
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
