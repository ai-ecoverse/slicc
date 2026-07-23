/**
 * Transcript attachment extraction, classification, and bundle building.
 *
 * Walks the normalized TranscriptDocumentV1 to find all `attachment-ref`
 * blocks in ALL message roles (user, assistant, tool-result), associates
 * them with canonical Pi image bytes or UI ChatMessage attachments by ordinal,
 * and walks UI messages for additional file attachments (text / binary).
 *
 * Text attachments are passed through `redactTranscript` (via
 * `KnownSecretBatchRedactor`). Binary attachments are copied unchanged.
 * Both kinds get opaque `att-NNNN.ext` bundle paths and SHA-256 hashes.
 *
 * Attachment metadata (originalName) is redacted via `knownSecrets` +
 * credential-pattern scanning before being stored in the document.
 * Binary deduplication uses full SHA-256 (not unsafe first-64-bytes sampling).
 */

import {
  redactCredentialPatterns,
  type TranscriptAttachment,
  type TranscriptCompletenessReason,
  type TranscriptContentBlock,
  type TranscriptDocumentV1,
  TranscriptExportError,
} from '@slicc/shared-ts';
import type { ChatMessage } from '../scoops/chat-types.js';
import type { CanonicalImageEntry } from './normalize.js';
import { type KnownSecretBatchRedactor, redactTranscript } from './redact.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AttachmentProcessingInput {
  document: TranscriptDocumentV1;
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>;
  knownSecrets: KnownSecretBatchRedactor;
  /** Base64 image data from assistant and tool-result Pi blocks, keyed by attachmentId. */
  canonicalImages?: Map<string, CanonicalImageEntry>;
  /**
   * Optional VFS reader for resolving path-backed UI attachments.
   * Called when a UI attachment has only `path` (no inline `data` or `text`).
   */
  vfsReader?: (path: string) => Promise<Uint8Array>;
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

// ---------------------------------------------------------------------------
// Attachment-ref location scanning (all message roles)
// ---------------------------------------------------------------------------

interface AttachmentRefLocation {
  attachmentId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'tool-result';
  /** Index among user-role messages in the conversation; only valid when role='user'. */
  userOrdinal: number;
  /** Index among image-eligible attachments in the UI message; only valid when role='user'. */
  imgIndex: number;
}

function collectExistingAttachmentRefs(document: TranscriptDocumentV1): AttachmentRefLocation[] {
  const locations: AttachmentRefLocation[] = [];
  for (const conv of document.conversations) {
    let userOrdinal = 0;
    for (const msg of conv.messages) {
      const role = msg.role as 'user' | 'assistant' | 'tool-result';
      if (role !== 'user' && role !== 'assistant' && role !== 'tool-result') continue;
      let imgIndex = 0;
      for (const block of msg.content) {
        if (block.type === 'attachment-ref') {
          locations.push({
            attachmentId: block.attachmentId,
            conversationId: conv.id,
            messageId: msg.id,
            role,
            userOrdinal,
            imgIndex,
          });
          imgIndex++;
        }
      }
      if (role === 'user') userOrdinal++;
    }
  }
  return locations;
}

// ---------------------------------------------------------------------------
// Source extraction from a single UI attachment (async for VFS path-backed files)
// ---------------------------------------------------------------------------

async function extractRawFromUiAttachment(
  uiAtt: UiAttachment,
  attachmentId: string,
  convId: string,
  messageId: string,
  vfsReader?: (path: string) => Promise<Uint8Array>
): Promise<PendingAttachment> {
  const handling = attachmentHandling(uiAtt.mimeType, uiAtt.name);
  const base = {
    attachmentId,
    originalName: uiAtt.name,
    mimeType: uiAtt.mimeType,
    handling,
    present: true,
    sourceConversationId: convId,
    sourceMessageId: messageId,
  };

  if (handling === 'text-redacted') {
    let rawText: string | undefined;
    if (uiAtt.text !== undefined) rawText = uiAtt.text;
    else if (uiAtt.data !== undefined) rawText = new TextDecoder().decode(decodeBase64(uiAtt.data));
    else if (uiAtt.path !== undefined && vfsReader !== undefined) {
      try {
        rawText = new TextDecoder().decode(await vfsReader(uiAtt.path));
      } catch {
        return {
          ...base,
          present: false,
          missingReason: 'attachment-file-missing',
        };
      }
    }
    if (rawText === undefined) {
      return { ...base, present: false, missingReason: 'attachment-file-missing' };
    }
    return { ...base, rawText };
  }

  // binary-unchanged
  let rawBytes: Uint8Array | undefined;
  if (uiAtt.data !== undefined) rawBytes = decodeBase64(uiAtt.data);
  else if (uiAtt.path !== undefined && vfsReader !== undefined) {
    try {
      rawBytes = await vfsReader(uiAtt.path);
    } catch {
      return { ...base, present: false, missingReason: 'attachment-file-missing' };
    }
  }
  if (rawBytes === undefined) {
    return { ...base, present: false, missingReason: 'attachment-file-missing' };
  }
  return { ...base, rawBytes };
}

// ---------------------------------------------------------------------------
// Phase 1: resolve existing attachment-ref blocks (all roles)
// ---------------------------------------------------------------------------

function resolveExistingRefs(
  refs: AttachmentRefLocation[],
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>,
  canonicalImages: Map<string, CanonicalImageEntry>,
  vfsReader: ((path: string) => Promise<Uint8Array>) | undefined
): {
  pendingPromises: Promise<PendingAttachment>[];
  mismatchedConvIds: Set<string>;
  processedUiPositions: Set<string>;
} {
  const pendingPromises: Promise<PendingAttachment>[] = [];
  const mismatchedConvIds = new Set<string>();
  const processedUiPositions = new Set<string>();

  for (const ref of refs) {
    // Non-user roles: resolve from canonical Pi image data.
    if (ref.role !== 'user') {
      const entry = canonicalImages.get(ref.attachmentId);
      if (entry === undefined) {
        pendingPromises.push(
          Promise.resolve<PendingAttachment>({
            attachmentId: ref.attachmentId,
            originalName: 'unknown',
            mimeType: 'application/octet-stream',
            handling: 'binary-unchanged',
            present: false,
            missingReason: 'attachment-file-missing',
            sourceConversationId: ref.conversationId,
            sourceMessageId: ref.messageId,
          })
        );
      } else {
        pendingPromises.push(
          Promise.resolve<PendingAttachment>({
            attachmentId: ref.attachmentId,
            originalName: `image-${ref.imgIndex}`,
            mimeType: entry.mimeType,
            handling: 'binary-unchanged',
            rawBytes: decodeBase64(entry.data),
            present: true,
            sourceConversationId: ref.conversationId,
            sourceMessageId: ref.messageId,
          })
        );
      }
      continue;
    }

    // User role: resolve from UI messages by ordinal.
    const uiMessages = chatMessagesByConversation.get(ref.conversationId) ?? [];
    const uiUserMessages = uiMessages.filter((m) => m.role === 'user');
    const uiMsg = uiUserMessages[ref.userOrdinal];

    if (uiMsg === undefined) {
      mismatchedConvIds.add(ref.conversationId);
      pendingPromises.push(
        Promise.resolve<PendingAttachment>({
          attachmentId: ref.attachmentId,
          originalName: 'unknown',
          mimeType: 'application/octet-stream',
          handling: 'binary-unchanged',
          present: false,
          missingReason: 'attachment-association-unavailable',
          sourceConversationId: ref.conversationId,
          sourceMessageId: ref.messageId,
        })
      );
      continue;
    }

    const allAtts = uiMsg.attachments ?? [];
    const uiImagesWithIdx = allAtts
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.kind === 'image' || (a.kind === 'file' && a.data !== undefined));
    const entry = uiImagesWithIdx[ref.imgIndex];

    if (entry === undefined) {
      pendingPromises.push(
        Promise.resolve<PendingAttachment>({
          attachmentId: ref.attachmentId,
          originalName: 'unknown',
          mimeType: 'application/octet-stream',
          handling: 'binary-unchanged',
          present: false,
          missingReason: 'attachment-file-missing',
          sourceConversationId: ref.conversationId,
          sourceMessageId: ref.messageId,
        })
      );
      continue;
    }

    processedUiPositions.add(`${ref.conversationId}:${uiMsg.id}:${entry.i}`);
    pendingPromises.push(
      extractRawFromUiAttachment(
        entry.a,
        ref.attachmentId,
        ref.conversationId,
        ref.messageId,
        vfsReader
      )
    );
  }

  return { pendingPromises, mismatchedConvIds, processedUiPositions };
}

// ---------------------------------------------------------------------------
// Phase 2: collect non-image file attachments from UI messages
// ---------------------------------------------------------------------------

interface ContentUpdateMap {
  updates: Map<string, Map<string, TranscriptContentBlock[]>>;
  additionalPendingPromises: Promise<PendingAttachment>[];
}

function selectPhase2Atts(
  uiMsg: ChatMessage,
  convId: string,
  processedUiPositions: Set<string>
): Array<{ a: UiAttachment; i: number }> {
  return (uiMsg.attachments ?? [])
    .map((a, i) => ({ a, i }))
    .filter(
      ({ a, i }) =>
        (a.kind === 'text' ||
          (a.kind === 'file' && (a.data !== undefined || a.path !== undefined))) &&
        !processedUiPositions.has(`${convId}:${uiMsg.id}:${i}`)
    );
}

function buildPhase2Blocks(
  msg: TranscriptDocumentV1['conversations'][number]['messages'][number],
  uiMsg: ChatMessage,
  convId: string,
  existingPendingIds: Set<string>,
  processedUiPositions: Set<string>,
  additionalPendingPromises: Promise<PendingAttachment>[],
  vfsReader: ((path: string) => Promise<Uint8Array>) | undefined
): TranscriptContentBlock[] {
  const fileAtts = selectPhase2Atts(uiMsg, convId, processedUiPositions);
  const newBlocks: TranscriptContentBlock[] = [];
  for (let k = 0; k < fileAtts.length; k++) {
    const { a: uiAtt } = fileAtts[k]!;
    const newId = `${msg.id}-file-${k}`;
    if (!existingPendingIds.has(newId)) {
      additionalPendingPromises.push(
        extractRawFromUiAttachment(uiAtt, newId, convId, msg.id, vfsReader)
      );
      newBlocks.push({ type: 'attachment-ref', attachmentId: newId });
    }
  }
  return newBlocks;
}

function collectFileAttachments(
  document: TranscriptDocumentV1,
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>,
  existingPendingIds: Set<string>,
  processedUiPositions: Set<string>,
  vfsReader: ((path: string) => Promise<Uint8Array>) | undefined
): ContentUpdateMap {
  const updates = new Map<string, Map<string, TranscriptContentBlock[]>>();
  const additionalPendingPromises: Promise<PendingAttachment>[] = [];

  for (const conv of document.conversations) {
    const uiMessages = chatMessagesByConversation.get(conv.id) ?? [];
    const uiUserMessages = uiMessages.filter((m) => m.role === 'user');
    let userOrdinal = 0;

    for (const msg of conv.messages) {
      if (msg.role !== 'user') continue;
      const uiMsg = uiUserMessages[userOrdinal];
      userOrdinal++;
      if (uiMsg === undefined) continue;

      const newBlocks = buildPhase2Blocks(
        msg,
        uiMsg,
        conv.id,
        existingPendingIds,
        processedUiPositions,
        additionalPendingPromises,
        vfsReader
      );
      if (newBlocks.length > 0) {
        if (!updates.has(conv.id)) updates.set(conv.id, new Map());
        updates.get(conv.id)!.set(msg.id, [...msg.content, ...newBlocks]);
      }
    }
  }

  return { updates, additionalPendingPromises };
}

// ---------------------------------------------------------------------------
// Metadata redaction: redact originalName values before storing in document
// ---------------------------------------------------------------------------

async function redactAttachmentNames(
  names: string[],
  knownSecrets: KnownSecretBatchRedactor,
  signal: AbortSignal | undefined
): Promise<string[]> {
  if (names.length === 0) return [];
  let afterKnown: readonly string[];
  try {
    afterKnown = await knownSecrets.redact(names, signal);
  } catch (err) {
    if (err instanceof TranscriptExportError) throw err;
    throw new TranscriptExportError('attachment-unreadable');
  }
  if (afterKnown.length !== names.length) throw new TranscriptExportError('attachment-unreadable');
  return afterKnown.map((name) => redactCredentialPatterns(name, 'mdr', 1).text);
}

// ---------------------------------------------------------------------------
// Phase 3: redact document, build bundle with SHA-256-based dedup
// ---------------------------------------------------------------------------

async function redactAndBuildBundle(
  allPending: PendingAttachment[],
  document: TranscriptDocumentV1,
  partialReasons: Set<TranscriptCompletenessReason>,
  knownSecrets: KnownSecretBatchRedactor,
  signal?: AbortSignal
): Promise<{
  redactedDocument: TranscriptDocumentV1;
  bundleFiles: Map<string, Uint8Array>;
  transcriptAttachments: TranscriptAttachment[];
}> {
  // Build text map for document redaction.
  const textMap = new Map<string, string>();
  for (const p of allPending) {
    if (p.handling === 'text-redacted' && p.rawText !== undefined) {
      textMap.set(p.attachmentId, p.rawText);
    }
  }

  // Redact the document (conversations, delegations, etc.). Rethrow any
  // TranscriptExportError (e.g. redaction-unavailable) unchanged.
  let redactedDocument: TranscriptDocumentV1;
  let redactedText: Map<string, string>;
  try {
    const res = await redactTranscript(document, textMap, knownSecrets, signal);
    redactedDocument = res.document;
    redactedText = res.textAttachments;
  } catch (err) {
    if (err instanceof TranscriptExportError) throw err;
    throw new TranscriptExportError('attachment-unreadable');
  }

  // Redact originalName values (metadata) separately before storing.
  const nameInputs = allPending.map((p) => p.originalName);
  const redactedNames = await redactAttachmentNames(nameInputs, knownSecrets, signal);

  // Build bundle with full SHA-256-based dedup (replaces unsafe first-64-bytes key).
  const bundleFiles = new Map<string, Uint8Array>();
  const transcriptAttachments: TranscriptAttachment[] = [];
  const dedupeByHash = new Map<string, string>(); // sha256 → opaquePath
  let idx = 0;

  for (let i = 0; i < allPending.length; i++) {
    const p = allPending[i]!;
    const redactedName = redactedNames[i] ?? p.originalName;

    if (!p.present) {
      transcriptAttachments.push({
        id: p.attachmentId,
        path: '',
        originalName: redactedName,
        mimeType: p.mimeType,
        byteLength: 0,
        sha256: '',
        sourceConversationId: p.sourceConversationId,
        sourceMessageId: p.sourceMessageId,
        handling: p.handling,
        present: false,
        missingReason:
          p.missingReason === 'attachment-file-missing' ? 'attachment-file-missing' : undefined,
      });
      if (p.missingReason === 'attachment-association-unavailable') {
        partialReasons.add('attachment-association-unavailable');
      } else if (p.missingReason === 'attachment-file-missing') {
        partialReasons.add('attachment-file-missing');
      }
      continue;
    }

    // Compute final bytes.
    const bytes =
      p.handling === 'text-redacted'
        ? new TextEncoder().encode(redactedText.get(p.attachmentId) ?? p.rawText ?? '')
        : p.rawBytes!;

    // SHA-256-based dedup (safe: full content hash, no sampling).
    const hash = await sha256Hex(bytes);
    const existingPath = dedupeByHash.get(hash);

    if (existingPath !== undefined) {
      transcriptAttachments.push({
        id: p.attachmentId,
        path: existingPath,
        originalName: redactedName,
        mimeType: p.mimeType,
        byteLength: bytes.length,
        sha256: hash,
        sourceConversationId: p.sourceConversationId,
        sourceMessageId: p.sourceMessageId,
        handling: p.handling,
        present: true,
      });
      continue;
    }

    const opaquePath = assignOpaquePath(idx++, p.originalName);
    bundleFiles.set(opaquePath, bytes);
    dedupeByHash.set(hash, opaquePath);
    transcriptAttachments.push({
      id: p.attachmentId,
      path: opaquePath,
      originalName: redactedName,
      mimeType: p.mimeType,
      byteLength: bytes.length,
      sha256: hash,
      sourceConversationId: p.sourceConversationId,
      sourceMessageId: p.sourceMessageId,
      handling: p.handling,
      present: true,
    });
  }

  return { redactedDocument, bundleFiles, transcriptAttachments };
}

// ---------------------------------------------------------------------------
// Main processing function
// ---------------------------------------------------------------------------

/**
 * Process all attachments in the document:
 *  1. Resolve existing `attachment-ref` blocks (all roles) from canonical Pi data or UI.
 *  2. Walk UI ChatMessage.attachments for additional text/binary files.
 *  3. Redact text attachments and attachment metadata (originalName) via KnownSecretBatchRedactor.
 *  4. Copy binary bytes unchanged.
 *  5. Assign opaque `att-NNNN.ext` names and compute full SHA-256 hashes for dedup.
 *  6. Populate `document.attachments[]` and return bundle files.
 *
 * Throws `TranscriptExportError('redaction-unavailable')` on redaction failure.
 * Throws `TranscriptExportError('attachment-unreadable')` on decode/read failure.
 */
export async function processTranscriptAttachments(
  input: AttachmentProcessingInput
): Promise<AttachmentProcessingResult> {
  const { document, chatMessagesByConversation, knownSecrets, signal } = input;
  const canonicalImages = input.canonicalImages ?? new Map<string, CanonicalImageEntry>();
  const vfsReader = input.vfsReader;
  const partialReasons = new Set<TranscriptCompletenessReason>();

  // Phase 1: resolve existing attachment-refs (all roles).
  const existingRefs = collectExistingAttachmentRefs(document);
  const {
    pendingPromises: phase1Promises,
    mismatchedConvIds,
    processedUiPositions,
  } = resolveExistingRefs(existingRefs, chatMessagesByConversation, canonicalImages, vfsReader);

  if (mismatchedConvIds.size > 0) {
    partialReasons.add('attachment-association-unavailable');
  }

  // Flag conversations where normalized has more user messages than UI.
  for (const conv of document.conversations) {
    const normalizedUserCount = conv.messages.filter((m) => m.role === 'user').length;
    const uiMessages = chatMessagesByConversation.get(conv.id) ?? [];
    const uiUserCount = uiMessages.filter((m) => m.role === 'user').length;
    if (normalizedUserCount > uiUserCount) {
      partialReasons.add('attachment-association-unavailable');
    }
  }

  // Phase 2: collect text/binary file attachments not yet in the doc.
  const phase1Pending = await Promise.all(phase1Promises);
  const existingIds = new Set(phase1Pending.map((p) => p.attachmentId));
  const { updates, additionalPendingPromises } = collectFileAttachments(
    document,
    chatMessagesByConversation,
    existingIds,
    processedUiPositions,
    vfsReader
  );
  const additionalPending = await Promise.all(additionalPendingPromises);

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
  const { redactedDocument, bundleFiles, transcriptAttachments } = await redactAndBuildBundle(
    allPending,
    workingDoc,
    partialReasons,
    knownSecrets,
    signal
  );

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
