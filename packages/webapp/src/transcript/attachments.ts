/**
 * Transcript attachment extraction, classification, and bundle building.
 *
 * Walks the normalized TranscriptDocumentV1 to find all `attachment-ref`
 * blocks, associates them with UI ChatMessage.attachments by role ordinal,
 * and walks UI messages for additional file attachments (text / binary) that
 * were not captured as `attachment-ref` by the normalizer.
 *
 * Text attachments are passed through `redactTranscript` (via
 * `KnownSecretBatchRedactor`). Binary attachments are copied unchanged.
 * Both kinds get opaque `att-NNNN.ext` bundle paths and SHA-256 hashes.
 */

import {
  TranscriptExportError,
  type TranscriptAttachment,
  type TranscriptCompletenessReason,
  type TranscriptContentBlock,
  type TranscriptDocumentV1,
} from '@slicc/shared-ts';
import type { ChatMessage } from '../scoops/chat-types.js';
import { redactTranscript, type KnownSecretBatchRedactor } from './redact.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AttachmentProcessingInput {
  document: TranscriptDocumentV1;
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>;
  knownSecrets: KnownSecretBatchRedactor;
  signal?: AbortSignal;
}

export interface AttachmentProcessingResult {
  document: TranscriptDocumentV1;
  /** Bundle-relative paths (e.g. "attachments/att-0001.png") → bytes. */
  bundleFiles: Map<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingAttachment {
  attachmentId: string;
  originalName: string;
  mimeType: string;
  handling: 'text-redacted' | 'binary-unchanged';
  bundleKey: string;
  rawText?: string;
  rawBytes?: Uint8Array;
  present: boolean;
  missingReason?: 'attachment-file-missing' | 'attachment-association-unavailable';
  sourceConversationId: string;
  sourceMessageId: string;
}

type UiAttachment = NonNullable<ChatMessage['attachments']>[number];

// ---------------------------------------------------------------------------
// Pure classifier (exported per brief)
// ---------------------------------------------------------------------------

/**
 * Classify an attachment as needing text redaction or binary copy.
 *
 * Matches on MIME type first (text/* or application/json), then on
 * file extension as a fallback so content-type-free uploads are handled.
 */
export function attachmentHandling(
  mimeType: string,
  name: string
): 'text-redacted' | 'binary-unchanged' {
  const textMime = mimeType.startsWith('text/') || mimeType === 'application/json';
  const textName = /\.(?:txt|md|json|csv|xml|ya?ml|js|mjs|cjs|ts|tsx|css|html)$/i.test(name);
  return textMime || textName ? 'text-redacted' : 'binary-unchanged';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function assignOpaquePath(index: number, originalName: string): string {
  const num = String(index + 1).padStart(4, '0');
  const dotIdx = originalName.lastIndexOf('.');
  const ext = dotIdx !== -1 ? originalName.slice(dotIdx) : '';
  return `attachments/att-${num}${ext}`;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fast dedup key for binary bytes: first 64 bytes + total length. */
function binaryDedupKey(bytes: Uint8Array): string {
  const sample = bytes.slice(0, 64);
  return `${bytes.length}:${btoa(String.fromCharCode(...sample))}`;
}

// ---------------------------------------------------------------------------
// Attachment-ref location scanning
// ---------------------------------------------------------------------------

interface AttachmentRefLocation {
  attachmentId: string;
  conversationId: string;
  messageId: string;
  userOrdinal: number;
  imgIndex: number;
}

function collectExistingAttachmentRefs(
  document: TranscriptDocumentV1
): AttachmentRefLocation[] {
  const locations: AttachmentRefLocation[] = [];
  for (const conv of document.conversations) {
    let userOrdinal = 0;
    for (const msg of conv.messages) {
      if (msg.role !== 'user') continue;
      let imgIndex = 0;
      for (const block of msg.content) {
        if (block.type === 'attachment-ref') {
          locations.push({
            attachmentId: block.attachmentId,
            conversationId: conv.id,
            messageId: msg.id,
            userOrdinal,
            imgIndex,
          });
          imgIndex++;
        }
      }
      userOrdinal++;
    }
  }
  return locations;
}

// ---------------------------------------------------------------------------
// Source extraction from a single UI attachment
// ---------------------------------------------------------------------------

function extractRawFromUiAttachment(
  uiAtt: UiAttachment,
  attachmentId: string,
  convId: string,
  messageId: string
): PendingAttachment {
  const handling = attachmentHandling(uiAtt.mimeType, uiAtt.name);
  const base = { attachmentId, originalName: uiAtt.name, mimeType: uiAtt.mimeType,
    handling, present: true, sourceConversationId: convId, sourceMessageId: messageId };

  if (handling === 'text-redacted') {
    let rawText: string | undefined;
    if (uiAtt.text !== undefined) rawText = uiAtt.text;
    else if (uiAtt.data !== undefined) rawText = new TextDecoder().decode(decodeBase64(uiAtt.data));
    if (rawText === undefined) {
      return { ...base, present: false, missingReason: 'attachment-file-missing',
        bundleKey: `missing:${attachmentId}` };
    }
    return { ...base, rawText, bundleKey: `text:${rawText}` };
  }

  let rawBytes: Uint8Array | undefined;
  if (uiAtt.data !== undefined) rawBytes = decodeBase64(uiAtt.data);
  if (rawBytes === undefined) {
    return { ...base, present: false, missingReason: 'attachment-file-missing',
      bundleKey: `missing:${attachmentId}` };
  }
  return { ...base, rawBytes, bundleKey: `binary:${binaryDedupKey(rawBytes)}` };
}

// ---------------------------------------------------------------------------
// Phase 1: resolve existing attachment-ref blocks (inline images)
// ---------------------------------------------------------------------------

function resolveExistingRefs(
  refs: AttachmentRefLocation[],
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>
): { pending: PendingAttachment[]; mismatchedConvIds: Set<string> } {
  const pending: PendingAttachment[] = [];
  const mismatchedConvIds = new Set<string>();

  for (const ref of refs) {
    const uiMessages = chatMessagesByConversation.get(ref.conversationId) ?? [];
    const uiUserMessages = uiMessages.filter((m) => m.role === 'user');
    const uiMsg = uiUserMessages[ref.userOrdinal];

    if (uiMsg === undefined) {
      mismatchedConvIds.add(ref.conversationId);
      pending.push({
        attachmentId: ref.attachmentId, originalName: 'unknown',
        mimeType: 'application/octet-stream', handling: 'binary-unchanged',
        bundleKey: `missing:${ref.attachmentId}`, present: false,
        missingReason: 'attachment-association-unavailable',
        sourceConversationId: ref.conversationId, sourceMessageId: ref.messageId,
      });
      continue;
    }

    const uiImages = (uiMsg.attachments ?? []).filter(
      (a) => a.kind === 'image' || (a.kind === 'file' && a.data !== undefined)
    );
    const uiAtt = uiImages[ref.imgIndex];

    if (uiAtt === undefined) {
      pending.push({
        attachmentId: ref.attachmentId, originalName: 'unknown',
        mimeType: 'application/octet-stream', handling: 'binary-unchanged',
        bundleKey: `missing:${ref.attachmentId}`, present: false,
        missingReason: 'attachment-file-missing',
        sourceConversationId: ref.conversationId, sourceMessageId: ref.messageId,
      });
      continue;
    }

    pending.push(
      extractRawFromUiAttachment(uiAtt, ref.attachmentId, ref.conversationId, ref.messageId)
    );
  }

  return { pending, mismatchedConvIds };
}

// ---------------------------------------------------------------------------
// Phase 2: collect non-image file attachments from UI messages
// ---------------------------------------------------------------------------

interface ContentUpdateMap {
  /** conversationId → (messageId → updated content blocks) */
  updates: Map<string, Map<string, TranscriptContentBlock[]>>;
  additionalPending: PendingAttachment[];
}

function collectFileAttachments(
  document: TranscriptDocumentV1,
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>,
  existingPendingIds: Set<string>
): ContentUpdateMap {
  const updates = new Map<string, Map<string, TranscriptContentBlock[]>>();
  const additionalPending: PendingAttachment[] = [];

  for (const conv of document.conversations) {
    const uiMessages = chatMessagesByConversation.get(conv.id) ?? [];
    const uiUserMessages = uiMessages.filter((m) => m.role === 'user');
    let userOrdinal = 0;

    for (const msg of conv.messages) {
      if (msg.role !== 'user') continue;
      const uiMsg = uiUserMessages[userOrdinal];

      if (uiMsg !== undefined) {
        const fileAtts = (uiMsg.attachments ?? []).filter(
          (a) => a.kind === 'text' || (a.kind === 'file' && a.data !== undefined)
        );

        const newBlocks: TranscriptContentBlock[] = [];
        for (let k = 0; k < fileAtts.length; k++) {
          const uiAtt = fileAtts[k]!;
          const newId = `${msg.id}-file-${k}`;
          if (!existingPendingIds.has(newId)) {
            additionalPending.push(
              extractRawFromUiAttachment(uiAtt, newId, conv.id, msg.id)
            );
            newBlocks.push({ type: 'attachment-ref', attachmentId: newId });
          }
        }

        if (newBlocks.length > 0) {
          if (!updates.has(conv.id)) updates.set(conv.id, new Map());
          updates.get(conv.id)!.set(msg.id, [...msg.content, ...newBlocks]);
        }
      }
      userOrdinal++;
    }
  }

  return { updates, additionalPending };
}

// ---------------------------------------------------------------------------
// Phase 3: redact and build bundle
// ---------------------------------------------------------------------------

async function redactAndBuildBundle(
  allPending: PendingAttachment[],
  document: TranscriptDocumentV1,
  partialReasons: Set<TranscriptCompletenessReason>,
  knownSecrets: KnownSecretBatchRedactor,
  signal?: AbortSignal
): Promise<{
  redactedDocument: TranscriptDocumentV1;
  redactedText: Map<string, string>;
  bundleFiles: Map<string, Uint8Array>;
  transcriptAttachments: TranscriptAttachment[];
}> {
  const textMap = new Map<string, string>();
  for (const p of allPending) {
    if (p.handling === 'text-redacted' && p.rawText !== undefined) {
      textMap.set(p.attachmentId, p.rawText);
    }
  }

  let redactedDocument: TranscriptDocumentV1;
  let redactedText: Map<string, string>;
  try {
    const res = await redactTranscript(document, textMap, knownSecrets, signal);
    redactedDocument = res.document;
    redactedText = res.textAttachments;
  } catch {
    throw new TranscriptExportError('attachment-unreadable');
  }

  const bundleFiles = new Map<string, Uint8Array>();
  const transcriptAttachments: TranscriptAttachment[] = [];
  const dedupeByKey = new Map<string, string>();
  let idx = 0;

  for (const p of allPending) {
    if (!p.present) {
      transcriptAttachments.push({
        id: p.attachmentId, path: '', originalName: p.originalName, mimeType: p.mimeType,
        byteLength: 0, sha256: '', sourceConversationId: p.sourceConversationId,
        sourceMessageId: p.sourceMessageId, handling: p.handling, present: false,
        missingReason: p.missingReason === 'attachment-file-missing' ? 'attachment-file-missing'
          : undefined,
      });
      if (p.missingReason === 'attachment-association-unavailable') {
        partialReasons.add('attachment-association-unavailable');
      }
      continue;
    }

    const existingPath = dedupeByKey.get(p.bundleKey);
    if (existingPath !== undefined) {
      const existingBytes = bundleFiles.get(existingPath)!;
      transcriptAttachments.push({
        id: p.attachmentId, path: existingPath, originalName: p.originalName,
        mimeType: p.mimeType, byteLength: existingBytes.length,
        sha256: await sha256Hex(existingBytes), sourceConversationId: p.sourceConversationId,
        sourceMessageId: p.sourceMessageId, handling: p.handling, present: true,
      });
      continue;
    }

    const opaquePath = assignOpaquePath(idx++, p.originalName);
    const bytes = p.handling === 'text-redacted'
      ? new TextEncoder().encode(redactedText.get(p.attachmentId) ?? p.rawText ?? '')
      : p.rawBytes!;

    bundleFiles.set(opaquePath, bytes);
    dedupeByKey.set(p.bundleKey, opaquePath);
    transcriptAttachments.push({
      id: p.attachmentId, path: opaquePath, originalName: p.originalName, mimeType: p.mimeType,
      byteLength: bytes.length, sha256: await sha256Hex(bytes),
      sourceConversationId: p.sourceConversationId, sourceMessageId: p.sourceMessageId,
      handling: p.handling, present: true,
    });
  }

  return { redactedDocument, redactedText, bundleFiles, transcriptAttachments };
}

// ---------------------------------------------------------------------------
// Main processing function
// ---------------------------------------------------------------------------

/**
 * Process all attachments in the document:
 *  1. Resolve existing `attachment-ref` blocks (inline images) from UI data.
 *  2. Walk UI ChatMessage.attachments for additional text/binary files.
 *  3. Redact text attachments via `KnownSecretBatchRedactor`.
 *  4. Copy binary bytes unchanged.
 *  5. Assign opaque `att-NNNN.ext` names and compute SHA-256 hashes.
 *  6. Populate `document.attachments[]` and return bundle files.
 *
 * Throws `TranscriptExportError('attachment-unreadable')` on decode/redaction failure.
 */
export async function processTranscriptAttachments(
  input: AttachmentProcessingInput
): Promise<AttachmentProcessingResult> {
  const { document, chatMessagesByConversation, knownSecrets, signal } = input;
  const partialReasons = new Set<TranscriptCompletenessReason>();

  // Phase 1: resolve existing image attachment-refs by ordinal matching.
  const existingRefs = collectExistingAttachmentRefs(document);
  const { pending: phase1Pending, mismatchedConvIds } =
    resolveExistingRefs(existingRefs, chatMessagesByConversation);

  if (mismatchedConvIds.size > 0) {
    partialReasons.add('attachment-association-unavailable');
  }

  // Also flag conversations where normalized has more user messages than UI.
  for (const conv of document.conversations) {
    const normalizedUserCount = conv.messages.filter((m) => m.role === 'user').length;
    const uiMessages = chatMessagesByConversation.get(conv.id) ?? [];
    const uiUserCount = uiMessages.filter((m) => m.role === 'user').length;
    if (normalizedUserCount > uiUserCount) {
      partialReasons.add('attachment-association-unavailable');
    }
  }

  // Phase 2: collect text/binary file attachments not yet in the doc.
  const existingIds = new Set(phase1Pending.map((p) => p.attachmentId));
  const { updates, additionalPending } =
    collectFileAttachments(document, chatMessagesByConversation, existingIds);

  const allPending = [...phase1Pending, ...additionalPending];

  // Apply message-content updates to add new attachment-ref blocks.
  let workingDoc: TranscriptDocumentV1 = document;
  if (updates.size > 0) {
    workingDoc = {
      ...document,
      conversations: document.conversations.map((conv) => {
        const msgUpdates = updates.get(conv.id);
        if (!msgUpdates) return conv;
        return {
          ...conv,
          messages: conv.messages.map((msg) => {
            const updatedContent = msgUpdates.get(msg.id);
            return updatedContent ? { ...msg, content: updatedContent } : msg;
          }),
        };
      }),
    };
  }

  // Phase 3: redact and build bundle.
  const { redactedDocument, bundleFiles, transcriptAttachments } =
    await redactAndBuildBundle(allPending, workingDoc, partialReasons, knownSecrets, signal);

  // Assemble final document with completeness and attachments[].
  const existingMissing = redactedDocument.session.completeness.missing.filter(
    (r) => !partialReasons.has(r as TranscriptCompletenessReason)
  );
  const allMissing = [...existingMissing, ...partialReasons];
  const finalDocument: TranscriptDocumentV1 = {
    ...redactedDocument,
    session: {
      ...redactedDocument.session,
      completeness: {
        status: allMissing.length > 0 ? 'partial' : redactedDocument.session.completeness.status,
        missing: allMissing,
      },
    },
    attachments: transcriptAttachments,
  };

  return { document: finalDocument, bundleFiles };
}
