/**
 * Tests for attachments.ts — attachment classifier, extraction, and bundle building.
 *
 * Covers:
 *  - attachmentHandling() pure classifier
 *  - Inline image data (base64 decode → binary-unchanged)
 *  - Text attachment content (text-redacted)
 *  - Binary attachment bytes (binary-unchanged)
 *  - Duplicate source data → same opaque bundle path reused
 *  - Missing/absent attachments → attachment-file-missing
 *  - Association mismatch → attachment-association-unavailable (partial)
 *  - Opaque name format: att-0001.ext
 *  - Exact binary bytes preserved
 *  - Sanitized text bytes (after redaction)
 *  - SHA-256 matches exported bytes
 */

import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptDocumentV1,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  attachmentHandling,
  processTranscriptAttachments,
} from '../../src/transcript/attachments.js';
import type { KnownSecretBatchRedactor } from '../../src/transcript/redact.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noOpRedactor(): KnownSecretBatchRedactor {
  return {
    async redact(texts) {
      return texts;
    },
  };
}

function secretRedactor(secret: string, replacement: string): KnownSecretBatchRedactor {
  return {
    async redact(texts) {
      return texts.map((t) => t.replaceAll(secret, replacement));
    },
  };
}

function failingRedactor(): KnownSecretBatchRedactor {
  return {
    async redact() {
      throw new Error('redaction service unavailable');
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Build a minimal document with one conversation and one user message containing N image refs */
function makeDocWithImageRefs(convId: string, imageCount: number): TranscriptDocumentV1 {
  const msgId = `${convId}-msg-000001`;
  const content = Array.from({ length: imageCount }, (_, k) => ({
    type: 'attachment-ref' as const,
    attachmentId: `${msgId}-img-${k}`,
  }));
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    export: {
      id: 'exp-001',
      generatedAt: '2024-01-01T00:00:00.000Z',
      producer: { application: 'slicc', version: '0.0.0-test' },
      format: SLICC_TRANSCRIPT_FORMAT,
    },
    session: {
      id: 'sess-001',
      title: 'Test session',
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
        id: convId,
        kind: 'cone',
        name: 'Sliccy',
        messages: [
          {
            id: msgId,
            sequence: 1,
            role: 'user',
            timestamp: new Date(1000).toISOString(),
            content,
          },
        ],
      },
    ],
    delegations: [],
    attachments: [],
  };
}

function makeUiUserMessage(attachments: NonNullable<ChatMessage['attachments']>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: 'user message',
    timestamp: 1000,
    attachments,
  };
}

// ---------------------------------------------------------------------------
// attachmentHandling — pure classifier
// ---------------------------------------------------------------------------

describe('attachmentHandling', () => {
  it.each([
    ['text/plain', 'readme.txt', 'text-redacted'],
    ['text/markdown', 'notes.md', 'text-redacted'],
    ['text/html', 'page.html', 'text-redacted'],
    ['application/json', 'data.json', 'text-redacted'],
    ['image/png', 'photo.png', 'binary-unchanged'],
    ['image/jpeg', 'img.jpg', 'binary-unchanged'],
    ['video/webm', 'video.webm', 'binary-unchanged'],
    ['application/pdf', 'doc.pdf', 'binary-unchanged'],
    ['application/octet-stream', 'data.ts', 'text-redacted'], // text ext
    ['application/octet-stream', 'script.js', 'text-redacted'], // text ext
    ['application/octet-stream', 'data.bin', 'binary-unchanged'], // binary ext
  ] as const)('classifies (%s, %s) → %s', (mimeType, name, expected) => {
    expect(attachmentHandling(mimeType, name)).toBe(expected);
  });

  it('classifies yaml extensions as text-redacted', () => {
    expect(attachmentHandling('application/octet-stream', 'config.yaml')).toBe('text-redacted');
    expect(attachmentHandling('application/octet-stream', 'config.yml')).toBe('text-redacted');
  });

  it('classifies tsx/jsx as text-redacted', () => {
    expect(attachmentHandling('application/octet-stream', 'Component.tsx')).toBe('text-redacted');
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — inline image data
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — inline image data', () => {
  const convId = 'conv-images';
  const imageBytes = new Uint8Array([255, 0, 128, 64, 32]);
  const b64 = base64Encode(imageBytes);

  it('extracts base64 image data and stores as binary-unchanged bytes', async () => {
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-1',
        name: 'photo.png',
        mimeType: 'image/png',
        size: imageBytes.length,
        kind: 'image',
        data: b64,
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    // Bundle file should have the image bytes
    const bundleEntry = [...result.bundleFiles.entries()].find(([k]) => k.includes('att-0001'));
    expect(bundleEntry).toBeDefined();
    expect(Array.from(bundleEntry![1])).toEqual(Array.from(imageBytes));
  });

  it('generates opaque name att-0001.png for first image', async () => {
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-1',
        name: 'my-photo-original.png',
        mimeType: 'image/png',
        size: 4,
        kind: 'image',
        data: base64Encode(new Uint8Array([1, 2, 3, 4])),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    expect(result.bundleFiles.has('attachments/att-0001.png')).toBe(true);
  });

  it('computes correct SHA-256 for binary image bytes', async () => {
    const doc = makeDocWithImageRefs(convId, 1);
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-1',
        name: 'image.jpg',
        mimeType: 'image/jpeg',
        size: bytes.length,
        kind: 'image',
        data: base64Encode(bytes),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    const transcriptAtt = result.document.attachments[0];
    expect(transcriptAtt).toBeDefined();
    const expectedHash = await sha256Hex(bytes);
    expect(transcriptAtt!.sha256).toBe(expectedHash);
  });

  it('marks image attachment as handling=binary-unchanged', async () => {
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-1',
        name: 'shot.png',
        mimeType: 'image/png',
        size: 2,
        kind: 'image',
        data: base64Encode(new Uint8Array([0, 1])),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    expect(result.document.attachments[0]?.handling).toBe('binary-unchanged');
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — text file attachments
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — text file attachments', () => {
  it('redacts text attachment content', async () => {
    const convId = 'conv-text';
    // Use a document with a text attachment-ref (not from image — we add it via UI messages)
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'attached file content' }],
            },
          ],
        },
      ],
    };

    const secret = 'SECRET_TOKEN_ABC';
    const textContent = `file content with ${secret} embedded`;
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-text-1',
        name: 'config.json',
        mimeType: 'application/json',
        size: textContent.length,
        kind: 'text',
        text: textContent,
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: secretRedactor(secret, '⟦REDACTED:secret:r1⟧'),
    });

    // Bundle should have the redacted text encoded as UTF-8 bytes
    const bundleEntry = [...result.bundleFiles.entries()].find(([k]) => k.includes('att-0001'));
    expect(bundleEntry).toBeDefined();
    const text = new TextDecoder().decode(bundleEntry![1]);
    expect(text).toContain('⟦REDACTED:secret:r1⟧');
    expect(text).not.toContain(secret);
  });

  it('marks text attachment as handling=text-redacted', async () => {
    const convId = 'conv-text2';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'with file' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-t',
        name: 'notes.md',
        mimeType: 'text/markdown',
        size: 10,
        kind: 'text',
        text: 'my notes',
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    expect(result.document.attachments[0]?.handling).toBe('text-redacted');
  });

  it('computes correct SHA-256 for redacted text bytes', async () => {
    const convId = 'conv-sha';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'hello' }],
            },
          ],
        },
      ],
    };

    const textContent = 'clean text no secrets';
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-sha',
        name: 'data.txt',
        mimeType: 'text/plain',
        size: textContent.length,
        kind: 'text',
        text: textContent,
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    const att = result.document.attachments[0];
    const bundleBytes = result.bundleFiles.get(att!.path)!;
    const expectedHash = await sha256Hex(bundleBytes);
    expect(att!.sha256).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — binary files
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — binary files', () => {
  it('preserves exact binary bytes for binary-unchanged attachments', async () => {
    const convId = 'conv-binary';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'with binary' }],
            },
          ],
        },
      ],
    };

    const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-bin',
        name: 'data.bin',
        mimeType: 'application/octet-stream',
        size: binaryBytes.length,
        kind: 'file',
        data: base64Encode(binaryBytes),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    const bundleEntry = [...result.bundleFiles.entries()].find(([k]) => k.includes('att-0001'));
    expect(bundleEntry).toBeDefined();
    expect(Array.from(bundleEntry![1])).toEqual(Array.from(binaryBytes));
  });

  it('does not call redactor for binary-unchanged attachments', async () => {
    const convId = 'conv-binary-no-redact';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'hi' }],
            },
          ],
        },
      ],
    };

    const redact = vi.fn(async (texts: readonly string[]) => texts);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-bin2',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        kind: 'file',
        data: base64Encode(new Uint8Array([1, 2, 3, 4])),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: { redact },
    });
    // redact may be called for the document, but NOT for binary attachment content specifically
    const allTexts = redact.mock.calls.flatMap((c) => [...c[0]]);
    expect(allTexts).not.toContain(base64Encode(new Uint8Array([1, 2, 3, 4])));
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — duplicate sources
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — duplicate source data (no dedup)', () => {
  it('stores identical content twice — each attachment-ref gets its own bundle entry', async () => {
    const convId = 'conv-dup';
    // Two user messages, each with the same image bytes.
    // Dedup is intentionally absent: byte identity is guaranteed per-ref.
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const b64 = base64Encode(bytes);
    const msg1Id = `${convId}-msg-000001`;
    const msg2Id = `${convId}-msg-000003`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msg1Id,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg1Id}-img-0` }],
            },
            {
              id: `${convId}-msg-000002`,
              sequence: 2,
              role: 'assistant',
              timestamp: new Date(2000).toISOString(),
              content: [{ type: 'text', text: 'ok' }],
            },
            {
              id: msg2Id,
              sequence: 3,
              role: 'user',
              timestamp: new Date(3000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg2Id}-img-0` }],
            },
          ],
        },
      ],
    };

    const uiMsg1 = makeUiUserMessage([
      {
        id: 'att-a',
        name: 'photo.png',
        mimeType: 'image/png',
        size: bytes.length,
        kind: 'image',
        data: b64,
      },
    ]);
    const uiMsg2 = makeUiUserMessage([
      {
        id: 'att-b',
        name: 'photo.png',
        mimeType: 'image/png',
        size: bytes.length,
        kind: 'image',
        data: b64,
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg1, uiMsg2] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });

    // No dedup: two separate bundle entries, each with correct bytes.
    const att1 = result.document.attachments.find((a) => a.sourceMessageId === msg1Id);
    const att2 = result.document.attachments.find((a) => a.sourceMessageId === msg2Id);
    expect(att1).toBeDefined();
    expect(att2).toBeDefined();
    // Each attachment gets its own distinct path.
    expect(att1!.path).not.toBe(att2!.path);
    expect(att1!.present).toBe(true);
    expect(att2!.present).toBe(true);
    // Both bundle entries contain the correct bytes.
    expect(Array.from(result.bundleFiles.get(att1!.path)!)).toEqual(Array.from(bytes));
    expect(Array.from(result.bundleFiles.get(att2!.path)!)).toEqual(Array.from(bytes));
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — missing attachments
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — missing attachments', () => {
  it('marks attachment as present=false and missingReason when UI data unavailable', async () => {
    const convId = 'conv-missing';
    // Image ref exists in doc, but UI message has no attachments
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: 'user msg',
      timestamp: 1000,
      // No attachments
    };
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    const att = result.document.attachments[0];
    expect(att?.present).toBe(false);
    expect(att?.missingReason).toBe('attachment-file-missing');
  });

  it('does not add missing attachment bytes to bundleFiles', async () => {
    const convId = 'conv-missing2';
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg: ChatMessage = { id: 'm1', role: 'user', content: 'hi', timestamp: 1 };
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    expect(result.bundleFiles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — association mismatch
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — association mismatch', () => {
  it('marks document partial with attachment-association-unavailable when user message counts diverge', async () => {
    const convId = 'conv-mismatch';
    // Doc has 2 user messages with image refs
    const msg1Id = `${convId}-msg-000001`;
    const msg2Id = `${convId}-msg-000003`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msg1Id,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg1Id}-img-0` }],
            },
            {
              id: `${convId}-msg-000002`,
              sequence: 2,
              role: 'assistant',
              timestamp: new Date(2000).toISOString(),
              content: [{ type: 'text', text: 'ok' }],
            },
            {
              id: msg2Id,
              sequence: 3,
              role: 'user',
              timestamp: new Date(3000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg2Id}-img-0` }],
            },
          ],
        },
      ],
    };

    // UI only has 1 user message (mismatch with 2 normalized user messages)
    const bytes = new Uint8Array([1, 2, 3]);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-1',
        name: 'img.png',
        mimeType: 'image/png',
        size: 3,
        kind: 'image',
        data: base64Encode(bytes),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    expect(result.document.session.completeness.status).toBe('partial');
    expect(result.document.session.completeness.missing).toContain(
      'attachment-association-unavailable'
    );
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — redaction failure
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — redaction failure', () => {
  it('throws redaction-unavailable when redactor throws (rethrows TranscriptExportError)', async () => {
    const convId = 'conv-fail';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'with file' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-fail',
        name: 'config.json',
        mimeType: 'application/json',
        size: 5,
        kind: 'text',
        text: 'data',
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    await expect(
      processTranscriptAttachments({
        document: doc,
        chatMessagesByConversation: chatMessages,
        knownSecrets: failingRedactor(),
      })
    ).rejects.toMatchObject({ code: 'redaction-unavailable' });
  });
});

// ---------------------------------------------------------------------------
// processTranscriptAttachments — opaque name format
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — opaque names', () => {
  it('uses att-NNNN.ext format with zero-padded index', async () => {
    const convId = 'conv-opaque';
    // Two user messages, each with one image ref
    const msg1Id = `${convId}-msg-000001`;
    const msg2Id = `${convId}-msg-000003`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msg1Id,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg1Id}-img-0` }],
            },
            {
              id: `${convId}-msg-000002`,
              sequence: 2,
              role: 'assistant',
              timestamp: new Date(2000).toISOString(),
              content: [{ type: 'text', text: 'ok' }],
            },
            {
              id: msg2Id,
              sequence: 3,
              role: 'user',
              timestamp: new Date(3000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg2Id}-img-0` }],
            },
          ],
        },
      ],
    };

    let imgSeed = 10;
    const makeImgMsg = (name: string): ChatMessage =>
      makeUiUserMessage([
        {
          id: crypto.randomUUID(),
          name,
          mimeType: 'image/png',
          size: 3,
          kind: 'image',
          // Distinct bytes per call so dedup doesn't collapse them.
          data: base64Encode(new Uint8Array([imgSeed++, imgSeed++, imgSeed++])),
        },
      ]);

    const chatMessages = new Map([
      [convId, [makeImgMsg('first.png'), makeImgMsg('second.jpeg')] as readonly ChatMessage[]],
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    const paths = [...result.bundleFiles.keys()].sort();
    expect(paths[0]).toMatch(/^attachments\/att-0001\.\w+$/);
    expect(paths[1]).toMatch(/^attachments\/att-0002\.\w+$/);
  });
});

// ---------------------------------------------------------------------------
// Fix: missing attachment files must escalate document completeness (task-5-review Fix 4)
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — missing file escalates document to partial', () => {
  it('marks document partial with attachment-file-missing when image data is absent', async () => {
    const convId = 'conv-missing-partial';
    const doc = makeDocWithImageRefs(convId, 1);
    // UI message has a slot for the user but no attachment data
    const uiMsg: ChatMessage = {
      id: 'm-partial-1',
      role: 'user',
      content: 'hi',
      timestamp: 1000,
      // No attachments — triggers attachment-file-missing
    };
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });

    // Attachment is still recorded with present=false
    const att = result.document.attachments[0];
    expect(att?.present).toBe(false);
    expect(att?.missingReason).toBe('attachment-file-missing');

    // Document completeness must be partial with attachment-file-missing reason
    expect(result.document.session.completeness.status).toBe('partial');
    expect(result.document.session.completeness.missing).toContain('attachment-file-missing');
  });

  it('retains present:false metadata alongside the partial status', async () => {
    const convId = 'conv-missing-meta';
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg: ChatMessage = { id: 'm2', role: 'user', content: 'hi', timestamp: 1 };
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    // Both conditions must hold simultaneously
    expect(result.document.attachments[0]?.present).toBe(false);
    expect(result.document.session.completeness.status).toBe('partial');
  });

  it('does not add missing attachment to bundleFiles even when partial', async () => {
    const convId = 'conv-missing-bundle';
    const doc = makeDocWithImageRefs(convId, 1);
    const uiMsg: ChatMessage = { id: 'm3', role: 'user', content: 'hi', timestamp: 1 };
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });
    expect(result.bundleFiles.size).toBe(0);
    expect(result.document.session.completeness.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// Fix: Phase 1 / Phase 2 provably disjoint — no duplicate attachment/ref
// (task-5-review Fix 2: kind='file'+data overlap)
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — Phase 1/Phase 2 disjoint (kind=file+data)', () => {
  it('kind=file+data attachment handled by Phase 1 is not re-added by Phase 2', async () => {
    const convId = 'conv-file-data-disjoint';
    const msgId = `${convId}-msg-000001`;
    // Document has an attachment-ref for the file (normalizer produced it).
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msgId}-img-0` }],
            },
          ],
        },
      ],
    };

    const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF header
    const uiMsg = makeUiUserMessage([
      {
        id: 'fa-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: fileBytes.length,
        kind: 'file',
        data: base64Encode(fileBytes),
      },
    ]);
    const chatMessages = new Map([[convId, [uiMsg] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });

    // Only one attachment should appear — the Phase 1 ref; Phase 2 must skip it.
    expect(result.document.attachments).toHaveLength(1);
    expect(result.document.attachments[0]?.id).toBe(`${msgId}-img-0`);

    // Only one bundle file.
    expect(result.bundleFiles.size).toBe(1);

    // No duplicate attachment-ref blocks in the message.
    const conv = result.document.conversations[0]!;
    const msg = conv.messages[0]!;
    const refs = msg.content.filter((b) => b.type === 'attachment-ref');
    expect(refs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Binary dedup collision — same length + same first 64 bytes, diff tail
// Two different binaries must not be collapsed to the same bundle entry.
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — binary dedup collision (unsafe first-64-bytes key)', () => {
  function makeCollisionDoc(convId: string): TranscriptDocumentV1 {
    const msg1Id = `${convId}-msg-000001`;
    const msg3Id = `${convId}-msg-000003`;
    return {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msg1Id,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg1Id}-img-0` }],
            },
            {
              id: `${convId}-msg-000002`,
              sequence: 2,
              role: 'assistant',
              timestamp: new Date(2000).toISOString(),
              content: [{ type: 'text', text: 'ok' }],
            },
            {
              id: msg3Id,
              sequence: 3,
              role: 'user',
              timestamp: new Date(3000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg3Id}-img-0` }],
            },
          ],
        },
      ],
    };
  }

  it('stores two binaries with identical first 64 bytes but different tails as separate entries', async () => {
    const convId = 'conv-collision';
    const doc = makeCollisionDoc(convId);
    const msg1Id = `${convId}-msg-000001`;
    const msg3Id = `${convId}-msg-000003`;

    // Both binaries: same 65-byte length, identical first 64 bytes, different tail byte.
    const bytes1 = new Uint8Array(65);
    bytes1.fill(0xaa, 0, 64);
    bytes1[64] = 0x01;

    const bytes2 = new Uint8Array(65);
    bytes2.fill(0xaa, 0, 64);
    bytes2[64] = 0x02;

    const uiMsg1 = makeUiUserMessage([
      {
        id: 'att-col-1',
        name: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 65,
        kind: 'image',
        data: base64Encode(bytes1),
      },
    ]);
    const uiMsg2 = makeUiUserMessage([
      {
        id: 'att-col-2',
        name: 'b.bin',
        mimeType: 'application/octet-stream',
        size: 65,
        kind: 'image',
        data: base64Encode(bytes2),
      },
    ]);

    const chatMessages = new Map([[convId, [uiMsg1, uiMsg2] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });

    // Both must be stored as separate bundle files.
    expect(result.bundleFiles.size).toBe(2);

    // Each attachment must reference its own distinct bundle file with correct bytes.
    const att1 = result.document.attachments.find((a) => a.sourceMessageId === msg1Id);
    const att2 = result.document.attachments.find((a) => a.sourceMessageId === msg3Id);
    expect(att1).toBeDefined();
    expect(att2).toBeDefined();
    expect(att1!.path).not.toBe(att2!.path);

    const stored1 = result.bundleFiles.get(att1!.path);
    const stored2 = result.bundleFiles.get(att2!.path);
    expect(stored1).toBeDefined();
    expect(stored2).toBeDefined();
    expect(Array.from(stored1!)).toEqual(Array.from(bytes1));
    expect(Array.from(stored2!)).toEqual(Array.from(bytes2));
  });

  it('sha256 in attachment metadata matches the actual stored bytes for both colliding binaries', async () => {
    const convId = 'conv-collision-sha';
    const doc = makeCollisionDoc(convId);
    const msg1Id = `${convId}-msg-000001`;
    const msg3Id = `${convId}-msg-000003`;

    const bytes1 = new Uint8Array(65);
    bytes1.fill(0xbb, 0, 64);
    bytes1[64] = 0x10;

    const bytes2 = new Uint8Array(65);
    bytes2.fill(0xbb, 0, 64);
    bytes2[64] = 0x20;

    const chatMessages = new Map([
      [
        convId,
        [
          makeUiUserMessage([
            {
              id: 'c1',
              name: 'x.bin',
              mimeType: 'application/octet-stream',
              size: 65,
              kind: 'image',
              data: base64Encode(bytes1),
            },
          ]),
          makeUiUserMessage([
            {
              id: 'c2',
              name: 'y.bin',
              mimeType: 'application/octet-stream',
              size: 65,
              kind: 'image',
              data: base64Encode(bytes2),
            },
          ]),
        ] as readonly ChatMessage[],
      ],
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
    });

    const att1 = result.document.attachments.find((a) => a.sourceMessageId === msg1Id);
    const att2 = result.document.attachments.find((a) => a.sourceMessageId === msg3Id);

    const expectedHash1 = await sha256Hex(bytes1);
    const expectedHash2 = await sha256Hex(bytes2);

    expect(att1!.sha256).toBe(expectedHash1);
    expect(att2!.sha256).toBe(expectedHash2);
    expect(att1!.sha256).not.toBe(att2!.sha256);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Adversarial filename — originalName must be redacted before export
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — adversarial originalName redaction', () => {
  function makeDocWithFileRef(convId: string): TranscriptDocumentV1 {
    const msgId = `${convId}-msg-000001`;
    return {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'attached file' }],
            },
          ],
        },
      ],
    };
  }

  it('redacts credential-pattern in originalName (ghp_ prefix)', async () => {
    const convId = 'conv-adv-cred';
    const doc = makeDocWithFileRef(convId);
    // GitHub PAT pattern: ghp_ + exactly 36 alphanumeric chars
    const secretFilename = 'ghp_AAAA0123456789abcdefABCDEF0123456789.txt';

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-cred',
        name: secretFilename,
        mimeType: 'text/plain',
        size: 10,
        kind: 'text',
        text: 'file contents',
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments[0];
    expect(att).toBeDefined();
    expect(att!.originalName).not.toContain('ghp_AAAA');
    expect(att!.originalName).toContain('⟦REDACTED:');
  });

  it('redacts known-secret in originalName via knownSecrets redactor', async () => {
    const convId = 'conv-adv-known';
    const doc = makeDocWithFileRef(convId);
    const secretValue = 'MY_INTERNAL_TOKEN_VALUE_XYZ';
    const filename = `${secretValue}.md`;

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-known',
        name: filename,
        mimeType: 'text/markdown',
        size: 5,
        kind: 'text',
        text: 'content',
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: secretRedactor(secretValue, '⟦REDACTED:secret:r1⟧'),
    });

    const att = result.document.attachments[0];
    expect(att).toBeDefined();
    expect(att!.originalName).not.toContain(secretValue);
    expect(att!.originalName).toContain('⟦REDACTED:');
  });

  it('redacted originalName is stored in document.attachments (not opaque path)', async () => {
    const convId = 'conv-adv-field';
    // GitHub PAT pattern: ghp_ + exactly 36 alphanumeric chars
    const secretFilename = 'ghp_BBBB0123456789abcdefABCDEF0123456789.txt';
    const msgId = `${convId}-msg-000001`;
    // Use a text attachment so Phase 2 picks it up (no attachment-ref in doc).
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'see file' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-field',
        name: secretFilename,
        mimeType: 'text/plain',
        size: 4,
        kind: 'text',
        text: 'data',
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments[0];
    expect(att).toBeDefined();
    // The opaque path must not contain the secret (already enforced by design)
    expect(att!.path).not.toContain('ghp_');
    // The originalName (which DID contain the secret) must now be redacted
    expect(att!.originalName).not.toContain('ghp_BBBB');
    expect(att!.originalName).toContain('⟦REDACTED:');
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Canonical assistant/tool-result image refs resolved from canonicalImages
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — canonical assistant image refs', () => {
  it('resolves attachment-ref in assistant message from canonicalImages map', async () => {
    const convId = 'conv-asst-img';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;
    const imageBytes = new Uint8Array([10, 20, 30, 40]);
    const imageB64 = base64Encode(imageBytes);

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'assistant',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId }],
            },
          ],
        },
      ],
    };

    const canonicalImages = new Map([[attachmentId, { data: imageB64, mimeType: 'image/png' }]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map(),
      knownSecrets: noOpRedactor(),
      canonicalImages,
    });

    expect(result.document.attachments).toHaveLength(1);
    const att = result.document.attachments[0]!;
    expect(att.present).toBe(true);
    expect(att.handling).toBe('binary-unchanged');

    const stored = result.bundleFiles.get(att.path)!;
    expect(stored).toBeDefined();
    expect(Array.from(stored)).toEqual(Array.from(imageBytes));
  });

  it('marks assistant image ref present:false when not in canonicalImages', async () => {
    const convId = 'conv-asst-missing';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'assistant',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId }],
            },
          ],
        },
      ],
    };

    // canonicalImages is empty — ref has no data
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map(),
      knownSecrets: noOpRedactor(),
      canonicalImages: new Map(),
    });

    const att = result.document.attachments[0];
    expect(att?.present).toBe(false);
    expect(result.document.session.completeness.status).toBe('partial');
  });
});

describe('processTranscriptAttachments — canonical tool-result image refs', () => {
  it('resolves attachment-ref in tool-result message from canonicalImages map', async () => {
    const convId = 'conv-tr-img';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;
    const imgBytes = new Uint8Array([255, 200, 100, 50]);
    const imgB64 = base64Encode(imgBytes);

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'tool-result',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId }],
              toolCallId: 'call-screenshot',
              isError: false,
            },
          ],
        },
      ],
    };

    const canonicalImages = new Map([[attachmentId, { data: imgB64, mimeType: 'image/jpeg' }]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map(),
      knownSecrets: noOpRedactor(),
      canonicalImages,
    });

    expect(result.document.attachments).toHaveLength(1);
    const att = result.document.attachments[0]!;
    expect(att.present).toBe(true);
    const stored = result.bundleFiles.get(att.path)!;
    expect(Array.from(stored)).toEqual(Array.from(imgBytes));
  });
});

// ---------------------------------------------------------------------------
// Fix 4: VFS path-only UI attachments resolved via injected vfsReader
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — VFS path-only UI attachments', () => {
  function makeDocWithTextRef(convId: string): TranscriptDocumentV1 {
    const msgId = `${convId}-msg-000001`;
    return {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'attached file' }],
            },
          ],
        },
      ],
    };
  }

  it('reads binary attachment bytes via vfsReader when path is provided', async () => {
    const convId = 'conv-vfs-binary';
    const doc = makeDocWithTextRef(convId);
    const vfsBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP magic

    const vfsReader = async (path: string): Promise<Uint8Array> => {
      if (path === '/tmp/attachment-abc.zip') return vfsBytes;
      throw new Error(`ENOENT: ${path}`);
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-vfs-bin',
        name: 'archive.zip',
        mimeType: 'application/zip',
        size: 4,
        kind: 'file',
        path: '/tmp/attachment-abc.zip',
        // no data, no text
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
      vfsReader,
    });

    const att = result.document.attachments[0];
    expect(att?.present).toBe(true);
    expect(att?.handling).toBe('binary-unchanged');
    const stored = result.bundleFiles.get(att!.path)!;
    expect(Array.from(stored)).toEqual(Array.from(vfsBytes));
  });

  it('reads text attachment content via vfsReader when path is provided', async () => {
    const convId = 'conv-vfs-text';
    const doc = makeDocWithTextRef(convId);
    const textContent = 'hello from vfs';

    const vfsReader = async (_path: string): Promise<Uint8Array> =>
      new TextEncoder().encode(textContent);

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-vfs-txt',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: textContent.length,
        kind: 'file',
        path: '/tmp/attachment-notes.txt',
        // no data, no text
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
      vfsReader,
    });

    const att = result.document.attachments[0];
    expect(att?.present).toBe(true);
    expect(att?.handling).toBe('text-redacted');
    const stored = result.bundleFiles.get(att!.path)!;
    expect(new TextDecoder().decode(stored)).toBe(textContent);
  });

  it('marks attachment present:false and document partial when vfsReader throws', async () => {
    const convId = 'conv-vfs-missing';
    const doc = makeDocWithTextRef(convId);

    const vfsReader = async (path: string): Promise<Uint8Array> => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-vfs-gone',
        name: 'gone.bin',
        mimeType: 'application/octet-stream',
        size: 0,
        kind: 'file',
        path: '/tmp/nonexistent.bin',
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
      vfsReader,
    });

    const att = result.document.attachments[0];
    expect(att?.present).toBe(false);
    expect(att?.missingReason).toBe('attachment-file-missing');
    expect(result.document.session.completeness.status).toBe('partial');
    expect(result.document.session.completeness.missing).toContain('attachment-file-missing');
  });

  it('works correctly without vfsReader when attachments have inline data', async () => {
    // Ensure that not providing vfsReader does not break existing inline-data paths.
    const convId = 'conv-no-vfsreader';
    const doc = makeDocWithTextRef(convId);
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-inline',
        name: 'data.txt',
        mimeType: 'text/plain',
        size: 5,
        kind: 'text',
        text: 'hello',
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
      // no vfsReader
    });
    expect(result.document.attachments[0]?.present).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Path-only kind='image' attachment resolved via vfsReader (Phase 1)
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — path-only kind=image via vfsReader (Phase 1)', () => {
  it('resolves path-only kind=image attachment bytes via vfsReader', async () => {
    const convId = 'conv-img-path';
    const msgId = `${convId}-msg-000001`;
    const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msgId}-img-0` }],
            },
          ],
        },
      ],
    };

    // Phase 1 filter includes kind='image'; path-only image goes to vfsReader.
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-img-path',
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: imgBytes.length,
        kind: 'image',
        path: '/tmp/screenshot.png',
        // no data field
      },
    ]);
    const vfsReader = async (path: string): Promise<Uint8Array> => {
      if (path === '/tmp/screenshot.png') return imgBytes;
      throw new Error(`ENOENT: ${path}`);
    };

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
      vfsReader,
    });

    const att = result.document.attachments[0];
    expect(att?.present).toBe(true);
    expect(att?.handling).toBe('binary-unchanged');
    const stored = result.bundleFiles.get(att!.path)!;
    expect(Array.from(stored)).toEqual(Array.from(imgBytes));
  });

  it('marks path-only kind=image attachment present:false when vfsReader throws', async () => {
    const convId = 'conv-img-path-gone';
    const msgId = `${convId}-msg-000001`;

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msgId}-img-0` }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-img-gone',
        name: 'missing.png',
        mimeType: 'image/png',
        size: 0,
        kind: 'image',
        path: '/tmp/gone.png',
      },
    ]);
    const vfsReader = async (_path: string): Promise<Uint8Array> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
      vfsReader,
    });

    const att = result.document.attachments[0];
    expect(att?.present).toBe(false);
    expect(att?.missingReason).toBe('attachment-file-missing');
    expect(result.document.session.completeness.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// Fix 5: Opaque path extension derived from MIME, not from original filename
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — opaque path extension from MIME (Fix 5)', () => {
  it('uses MIME-derived extension even when filename has a credential-in-extension pattern', async () => {
    const convId = 'conv-mime-ext';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'attached' }],
            },
          ],
        },
      ],
    };

    // Filename where credential pattern is in the extension — old code would leak it
    // via the opaque path extension; new code derives extension from MIME.
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-mime-ext',
        name: 'document.ghp_AAAA0123456789abcdefABCDEF0123456789',
        mimeType: 'application/pdf',
        size: 4,
        kind: 'file',
        data: base64Encode(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      },
    ]);

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments[0];
    expect(att).toBeDefined();
    // Extension comes from MIME (application/pdf → .pdf), not from the credential-laden filename.
    expect(att!.path).toBe('attachments/att-0001.pdf');
    // Path must not contain any fragment of the original filename.
    expect(att!.path).not.toContain('ghp_');
    expect(att!.path).not.toContain('document');
  });

  it('falls back to .bin for unknown MIME with binary-unchanged handling', async () => {
    const convId = 'conv-bin-fallback';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'attached' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-unknown',
        name: 'mystery.wasm',
        mimeType: 'application/wasm',
        size: 4,
        kind: 'file',
        data: base64Encode(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
      },
    ]);

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments[0];
    expect(att?.path).toBe('attachments/att-0001.bin');
  });

  it('falls back to .txt for unknown MIME with text-redacted handling', async () => {
    const convId = 'conv-txt-fallback';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'attached' }],
            },
          ],
        },
      ],
    };

    // text/x-custom starts with 'text/' so handling=text-redacted, not in MIME_EXT_MAP.
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-unknown-text',
        name: 'config.envrc',
        mimeType: 'text/x-custom',
        size: 5,
        kind: 'text',
        text: 'hello',
      },
    ]);

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments[0];
    expect(att?.path).toBe('attachments/att-0001.txt');
  });
});

// ---------------------------------------------------------------------------
// Fix 6: No dangling refs — every attachment-ref resolves to exactly one entry
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — no dangling refs (Fix 6)', () => {
  it('every attachment-ref in every message has exactly one metadata entry', async () => {
    // Each message gets a unique attachmentId (matching production behavior where
    // IDs are derived from msgId). The old test incorrectly shared `msg2Id-img-0`
    // across both the assistant and tool-result messages, creating duplicates.
    const convId = 'conv-no-dangling';
    const msg1Id = `${convId}-msg-000001`;
    const assistantMsgId = `${convId}-msg-000002`;
    const toolResultMsgId = `${convId}-msg-000003`;
    const msg3Id = `${convId}-msg-000005`;

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msg1Id,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [
                { type: 'attachment-ref', attachmentId: `${msg1Id}-img-0` },
                { type: 'attachment-ref', attachmentId: `${msg1Id}-img-1` },
              ],
            },
            {
              id: assistantMsgId,
              sequence: 2,
              role: 'assistant',
              timestamp: new Date(2000).toISOString(),
              // Unique ID derived from the assistant message's own ID.
              content: [{ type: 'attachment-ref', attachmentId: `${assistantMsgId}-img-0` }],
            },
            {
              id: toolResultMsgId,
              sequence: 3,
              role: 'tool-result',
              timestamp: new Date(3000).toISOString(),
              // Unique ID derived from the tool-result message's own ID.
              content: [{ type: 'attachment-ref', attachmentId: `${toolResultMsgId}-img-0` }],
              toolCallId: 'call-1',
              isError: false,
            },
            {
              id: msg3Id,
              sequence: 5,
              role: 'user',
              timestamp: new Date(5000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: `${msg3Id}-img-0` }],
            },
          ],
        },
      ],
    };

    const uiMsg1 = makeUiUserMessage([
      {
        id: 'a1',
        name: 'img1.png',
        mimeType: 'image/png',
        size: 3,
        kind: 'image',
        data: base64Encode(new Uint8Array([1, 2, 3])),
      },
      {
        id: 'a2',
        name: 'img2.png',
        mimeType: 'image/png',
        size: 3,
        kind: 'image',
        data: base64Encode(new Uint8Array([4, 5, 6])),
      },
    ]);
    const uiMsg3 = makeUiUserMessage([
      {
        id: 'a3',
        name: 'img3.png',
        mimeType: 'image/png',
        size: 3,
        kind: 'image',
        data: base64Encode(new Uint8Array([7, 8, 9])),
      },
    ]);

    // Canonical images for the two non-user roles, each with a unique ID.
    const canonicalImages = new Map([
      [
        `${assistantMsgId}-img-0`,
        { data: base64Encode(new Uint8Array([10, 11, 12])), mimeType: 'image/png' },
      ],
      [
        `${toolResultMsgId}-img-0`,
        { data: base64Encode(new Uint8Array([13, 14, 15])), mimeType: 'image/png' },
      ],
    ]);

    const chatMessages = new Map([[convId, [uiMsg1, uiMsg3] as readonly ChatMessage[]]]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: chatMessages,
      knownSecrets: noOpRedactor(),
      canonicalImages,
    });

    // Collect all attachment-ref IDs from the final document.
    const referencedIds = new Set<string>();
    for (const conv of result.document.conversations) {
      for (const msg of conv.messages) {
        for (const block of msg.content) {
          if (block.type === 'attachment-ref') referencedIds.add(block.attachmentId);
        }
      }
    }

    // Collect all IDs from the attachments metadata.
    const metadataIds = new Set(result.document.attachments.map((a) => a.id));

    // Every referenced ID must have exactly one metadata entry.
    for (const id of referencedIds) {
      expect(metadataIds.has(id), `Dangling ref: ${id} not in attachments metadata`).toBe(true);
    }
    // No metadata entry without a corresponding ref.
    for (const id of metadataIds) {
      expect(referencedIds.has(id), `Orphan metadata: ${id} not referenced in document`).toBe(true);
    }
    expect(referencedIds.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Metadata redaction via redactTranscript (originalName in privacy.redactions)
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — metadata redaction via redactTranscript (Fix 3)', () => {
  it('produces privacy.redactions entries for secret-shaped originalName', async () => {
    const convId = 'conv-meta-redact';
    const msgId = `${convId}-msg-000001`;
    const secretToken = 'MY_SECRET_VALUE_12345';
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'see attachment' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-meta',
        name: `${secretToken}.txt`,
        mimeType: 'text/plain',
        size: 4,
        kind: 'text',
        text: 'content',
      },
    ]);

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: secretRedactor(secretToken, '⟦REDACTED:secret:r1⟧'),
    });

    const att = result.document.attachments[0];
    expect(att).toBeDefined();
    // originalName is redacted.
    expect(att!.originalName).not.toContain(secretToken);
    expect(att!.originalName).toContain('⟦REDACTED:');
    // privacy.redactions should record the redaction that occurred in the attachment metadata.
    expect(result.document.privacy.redactions.length).toBeGreaterThan(0);
  });

  it('redactAttachmentNames is removed — no separate second knownSecrets call', async () => {
    // The old redactAttachmentNames() made a second separate knownSecrets.redact() call.
    // In the new design, there is only ONE call path through redactTranscript.
    // A redactor that fails on the second call should still succeed here.
    const convId = 'conv-single-pass';
    const msgId = `${convId}-msg-000001`;
    let callCount = 0;

    const singlePassRedactor: KnownSecretBatchRedactor = {
      async redact(texts) {
        callCount++;
        if (callCount > 1) throw new Error('should not be called twice');
        return texts;
      },
    };

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'hi' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-single',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        kind: 'text',
        text: 'hello',
      },
    ]);

    // Should not throw — redactor is only called once.
    await expect(
      processTranscriptAttachments({
        document: doc,
        chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
        knownSecrets: singlePassRedactor,
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 3 + Fix 5: Phase 1 image adversarial-name — originalName redacted (P3b)
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — Phase 1 image adversarial originalName (P3b)', () => {
  it('redacts credential-pattern in originalName for kind=image Phase 1 attachment', async () => {
    const convId = 'conv-p1-adv';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;
    const imageBytes = new Uint8Array([10, 20, 30, 40]);

    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId }],
            },
          ],
        },
      ],
    };

    // GitHub PAT pattern in image filename — must be redacted from originalName.
    const credentialFilename = 'ghp_AAAA0123456789abcdefABCDEF0123456789.png';
    const uiMsg = makeUiUserMessage([
      {
        id: 'att-p1-cred',
        name: credentialFilename,
        mimeType: 'image/png',
        size: imageBytes.length,
        kind: 'image',
        data: base64Encode(imageBytes),
      },
    ]);

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments[0];
    expect(att).toBeDefined();
    expect(att!.present).toBe(true);
    // originalName must not contain the credential prefix.
    expect(att!.originalName).not.toContain('ghp_AAAA');
    expect(att!.originalName).toContain('⟦REDACTED:');
    // Opaque path extension comes from MIME (image/png → .png), not from credential filename.
    expect(att!.path).toMatch(/^attachments\/att-0001\.png$/);
    // The bundle bytes must still be correct.
    const stored = result.bundleFiles.get(att!.path)!;
    expect(Array.from(stored)).toEqual(Array.from(imageBytes));
  });
});

// ---------------------------------------------------------------------------
// Fix 4: redaction-unavailable preserved; attachment-unreadable only for decode failures
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — error code specificity (Fix 4)', () => {
  it('knownSecrets failure in single pass throws redaction-unavailable', async () => {
    // With the unified redactTranscript pass, a knownSecrets failure always
    // produces redaction-unavailable (no attachment-unreadable confusion).
    const convId = 'conv-err-code';
    const msgId = `${convId}-msg-000001`;
    const doc: TranscriptDocumentV1 = {
      ...makeDocWithImageRefs(convId, 0),
      conversations: [
        {
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'text', text: 'hi' }],
            },
          ],
        },
      ],
    };

    const uiMsg = makeUiUserMessage([
      {
        id: 'att-err',
        name: 'data.txt',
        mimeType: 'text/plain',
        size: 4,
        kind: 'text',
        text: 'data',
      },
    ]);

    await expect(
      processTranscriptAttachments({
        document: doc,
        chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
        knownSecrets: failingRedactor(),
      })
    ).rejects.toMatchObject({ code: 'redaction-unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Cross-wave: missingReason = attachment-association-unavailable passes validator
// ---------------------------------------------------------------------------

describe('processTranscriptAttachments — cross-wave missingReason invariants', () => {
  /**
   * Helper: build a minimal one-conversation, one-user-message doc with a
   * single attachment-ref block for the given attachmentId.
   */
  function makeDocWithRef(
    convId: string,
    msgId: string,
    attachmentId: string
  ): TranscriptDocumentV1 {
    return {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      export: {
        id: 'exp-cw',
        generatedAt: '2024-01-01T00:00:00.000Z',
        producer: { application: 'slicc', version: '0.0.0-test' },
        format: SLICC_TRANSCRIPT_FORMAT,
      },
      session: {
        id: 'sess-cw',
        title: 'CW test',
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
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msgId,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId }],
            },
          ],
        },
      ],
      delegations: [],
      attachments: [],
    };
  }

  it('association-mismatch: absent attachment gets missingReason attachment-association-unavailable and passes validator', async () => {
    const convId = 'conv-cw-assoc';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;

    // Document has a user-message attachment-ref but chatMessages has ZERO user messages
    // for that conversation — triggers association-unavailable.
    const doc = makeDocWithRef(convId, msgId, attachmentId);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments.find((a) => a.id === attachmentId);
    expect(att).toBeDefined();
    expect(att!.present).toBe(false);
    expect(att!.missingReason).toBe('attachment-association-unavailable');
    // The emitted document must pass the runtime validator.
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
    // Session must be partial.
    expect(result.document.session.completeness.status).toBe('partial');
    expect(result.document.session.completeness.missing).toContain(
      'attachment-association-unavailable'
    );
  });

  it('file-missing: absent attachment gets missingReason attachment-file-missing and passes validator', async () => {
    const convId = 'conv-cw-filemiss';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;

    // UI message exists but has no image data — triggers file-missing.
    const doc = makeDocWithRef(convId, msgId, attachmentId);
    // UI message has no attachment data at the expected index (empty attachments).
    const uiMsg = makeUiUserMessage([]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments.find((a) => a.id === attachmentId);
    expect(att).toBeDefined();
    expect(att!.present).toBe(false);
    expect(att!.missingReason).toBe('attachment-file-missing');
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
    expect(result.document.session.completeness.status).toBe('partial');
    expect(result.document.session.completeness.missing).toContain('attachment-file-missing');
  });

  it('present attachment emits no missingReason and passes validator', async () => {
    const convId = 'conv-cw-present';
    const msgId = `${convId}-msg-000001`;
    const attachmentId = `${msgId}-img-0`;
    const bytes = new Uint8Array([1, 2, 3]);

    const doc = makeDocWithRef(convId, msgId, attachmentId);
    const uiMsg = makeUiUserMessage([
      {
        id: 'a1',
        name: 'photo.png',
        mimeType: 'image/png',
        size: bytes.length,
        kind: 'image',
        data: base64Encode(bytes),
      },
    ]);
    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const att = result.document.attachments.find((a) => a.id === attachmentId);
    expect(att).toBeDefined();
    expect(att!.present).toBe(true);
    expect(att!.missingReason).toBeUndefined();
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
  });

  it('reordered attachment array: each entry still receives the correct bytes and hash by ID', async () => {
    // Two attachments with distinct bytes.
    // The test verifies that the ID-based lookup (not positional) gives each
    // attachment the correct bytes even if the internal allPending order
    // differs from the redactedDocument.attachments order.
    const convId = 'conv-cw-reorder';
    const msg1Id = `${convId}-msg-000001`;
    const msg2Id = `${convId}-msg-000002`;
    const attId1 = `${msg1Id}-img-0`;
    const attId2 = `${msg2Id}-img-0`; // second user message, second attachment

    const bytesA = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const bytesB = new Uint8Array([0x11, 0x22, 0x33]);

    const doc: TranscriptDocumentV1 = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      export: {
        id: 'exp-cw-reorder',
        generatedAt: '2024-01-01T00:00:00.000Z',
        producer: { application: 'slicc', version: '0.0.0-test' },
        format: SLICC_TRANSCRIPT_FORMAT,
      },
      session: {
        id: 'sess-cw-reorder',
        title: 'Reorder test',
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
          id: convId,
          kind: 'cone',
          name: 'Sliccy',
          messages: [
            {
              id: msg1Id,
              sequence: 1,
              role: 'user',
              timestamp: new Date(1000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: attId1 }],
            },
            {
              id: msg2Id,
              sequence: 2,
              role: 'user',
              timestamp: new Date(2000).toISOString(),
              content: [{ type: 'attachment-ref', attachmentId: attId2 }],
            },
          ],
        },
      ],
      delegations: [],
      attachments: [],
    };

    const uiMsg1 = makeUiUserMessage([
      {
        id: 'img-a',
        name: 'alpha.png',
        mimeType: 'image/png',
        size: bytesA.length,
        kind: 'image',
        data: base64Encode(bytesA),
      },
    ]);
    const uiMsg2 = makeUiUserMessage([
      {
        id: 'img-b',
        name: 'beta.png',
        mimeType: 'image/png',
        size: bytesB.length,
        kind: 'image',
        data: base64Encode(bytesB),
      },
    ]);

    const result = await processTranscriptAttachments({
      document: doc,
      chatMessagesByConversation: new Map([[convId, [uiMsg1, uiMsg2] as readonly ChatMessage[]]]),
      knownSecrets: noOpRedactor(),
    });

    const meta1 = result.document.attachments.find((a) => a.id === attId1);
    const meta2 = result.document.attachments.find((a) => a.id === attId2);

    expect(meta1).toBeDefined();
    expect(meta2).toBeDefined();
    expect(meta1!.present).toBe(true);
    expect(meta2!.present).toBe(true);

    // Verify bytes in bundle match by ID, not by position.
    const bundle1 = result.bundleFiles.get(meta1!.path);
    const bundle2 = result.bundleFiles.get(meta2!.path);
    expect(bundle1).toBeDefined();
    expect(bundle2).toBeDefined();
    expect(Array.from(bundle1!)).toEqual(Array.from(bytesA));
    expect(Array.from(bundle2!)).toEqual(Array.from(bytesB));

    // SHA-256 must match the bytes stored under each ID.
    expect(meta1!.sha256).toBe(await sha256Hex(bytesA));
    expect(meta2!.sha256).toBe(await sha256Hex(bytesB));

    // Validator must accept the whole document.
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
  });
});
