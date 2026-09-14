import {
  type TranscriptAttachment,
  type TranscriptCompletenessReason,
  type TranscriptContentBlock,
  type TranscriptDocumentV1,
  TranscriptExportError,
} from '@slicc/shared-ts';
import type { ChatMessage } from '../scoops/chat-types.js';
import type { CanonicalImageEntry } from './normalize.js';
import { type KnownSecretBatchRedactor, redactTranscript } from './redact.js';

export interface AttachmentProcessingInput {
  document: TranscriptDocumentV1;
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>;
  knownSecrets: KnownSecretBatchRedactor;

  canonicalImages?: Map<string, CanonicalImageEntry>;

  vfsReader?: (path: string) => Promise<Uint8Array>;
  signal?: AbortSignal;
}

export interface AttachmentProcessingResult {
  document: TranscriptDocumentV1;

  bundleFiles: Map<string, Uint8Array>;
}

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

export function attachmentHandling(
  mimeType: string,
  name: string
): 'text-redacted' | 'binary-unchanged' {
  const textMime = mimeType.startsWith('text/') || mimeType === 'application/json';
  const textName = /\.(?:txt|md|json|csv|xml|ya?ml|js|mjs|cjs|ts|tsx|css|html)$/i.test(name);
  return textMime || textName ? 'text-redacted' : 'binary-unchanged';
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

const MIME_EXT_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/xml': '.xml',
  'application/xml': '.xml',
};

function mimeToExtension(mimeType: string, handling: 'text-redacted' | 'binary-unchanged'): string {
  return MIME_EXT_MAP[mimeType] ?? (handling === 'text-redacted' ? '.txt' : '.bin');
}

function assignOpaquePath(
  index: number,
  mimeType: string,
  handling: 'text-redacted' | 'binary-unchanged'
): string {
  const num = String(index + 1).padStart(4, '0');
  const ext = mimeToExtension(mimeType, handling);
  return `attachments/att-${num}${ext}`;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface AttachmentRefLocation {
  attachmentId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'tool-result';

  userOrdinal: number;

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

function buildRawAttachments(
  allPending: PendingAttachment[],
  partialReasons: Set<TranscriptCompletenessReason>
): { rawAttachments: TranscriptAttachment[]; textMap: Map<string, string> } {
  const textMap = new Map<string, string>();
  let idx = 0;
  const opaquePaths = new Map<string, string>();
  for (const p of allPending) {
    if (p.handling === 'text-redacted' && p.rawText !== undefined) {
      textMap.set(p.attachmentId, p.rawText);
    }
    if (p.present) {
      opaquePaths.set(p.attachmentId, assignOpaquePath(idx++, p.mimeType, p.handling));
    }
  }

  for (const p of allPending) {
    if (!p.present && p.missingReason !== undefined) {
      partialReasons.add(p.missingReason);
    }
  }

  const rawAttachments: TranscriptAttachment[] = allPending.map((p) => {
    if (!p.present) {
      return {
        id: p.attachmentId,
        path: '',
        originalName: p.originalName,
        mimeType: p.mimeType,
        byteLength: 0,
        sha256: '',
        sourceConversationId: p.sourceConversationId,
        sourceMessageId: p.sourceMessageId,
        handling: p.handling,
        present: false,

        missingReason: p.missingReason ?? 'attachment-file-missing',
      };
    }
    return {
      id: p.attachmentId,
      path: opaquePaths.get(p.attachmentId)!,
      originalName: p.originalName,
      mimeType: p.mimeType,
      byteLength: 0,
      sha256: '',
      sourceConversationId: p.sourceConversationId,
      sourceMessageId: p.sourceMessageId,
      handling: p.handling,
      present: true,
    };
  });
  return { rawAttachments, textMap };
}

async function redactAndBuildBundle(
  allPending: PendingAttachment[],
  document: TranscriptDocumentV1,
  partialReasons: Set<TranscriptCompletenessReason>,
  knownSecrets: KnownSecretBatchRedactor,
  signal?: AbortSignal
): Promise<{
  redactedDocument: TranscriptDocumentV1;
  bundleFiles: Map<string, Uint8Array>;
}> {
  const { rawAttachments, textMap } = buildRawAttachments(allPending, partialReasons);

  let redactedDocument: TranscriptDocumentV1;
  let redactedText: Map<string, string>;
  try {
    const res = await redactTranscript(
      { ...document, attachments: rawAttachments },
      textMap,
      knownSecrets,
      signal
    );
    redactedDocument = res.document;
    redactedText = res.textAttachments;
  } catch (err) {
    if (err instanceof TranscriptExportError) throw err;
    throw new TranscriptExportError('attachment-unreadable');
  }

  const pendingById = new Map<string, PendingAttachment>();
  for (const p of allPending) {
    if (pendingById.has(p.attachmentId)) {
      throw new TranscriptExportError('schema-invalid');
    }
    pendingById.set(p.attachmentId, p);
  }

  const bundleFiles = new Map<string, Uint8Array>();
  const patchedAttachments = await Promise.all(
    redactedDocument.attachments.map(async (att) => {
      if (!att.present || !att.path) return att;
      const p = pendingById.get(att.id);
      if (p === undefined) {
        throw new TranscriptExportError('schema-invalid');
      }
      const bytes =
        p.handling === 'text-redacted'
          ? new TextEncoder().encode(redactedText.get(p.attachmentId) ?? p.rawText ?? '')
          : p.rawBytes!;
      const hash = await sha256Hex(bytes);
      bundleFiles.set(att.path, bytes);
      return { ...att, byteLength: bytes.length, sha256: hash };
    })
  );

  return {
    redactedDocument: { ...redactedDocument, attachments: patchedAttachments },
    bundleFiles,
  };
}

export async function processTranscriptAttachments(
  input: AttachmentProcessingInput
): Promise<AttachmentProcessingResult> {
  const { document, chatMessagesByConversation, knownSecrets, signal } = input;
  const canonicalImages = input.canonicalImages ?? new Map<string, CanonicalImageEntry>();
  const vfsReader = input.vfsReader;
  const partialReasons = new Set<TranscriptCompletenessReason>();

  const existingRefs = collectExistingAttachmentRefs(document);
  const {
    pendingPromises: phase1Promises,
    mismatchedConvIds,
    processedUiPositions,
  } = resolveExistingRefs(existingRefs, chatMessagesByConversation, canonicalImages, vfsReader);

  if (mismatchedConvIds.size > 0) {
    partialReasons.add('attachment-association-unavailable');
  }

  for (const conv of document.conversations) {
    const normalizedUserCount = conv.messages.filter((m) => m.role === 'user').length;
    const uiMessages = chatMessagesByConversation.get(conv.id) ?? [];
    const uiUserCount = uiMessages.filter((m) => m.role === 'user').length;
    if (normalizedUserCount > uiUserCount) {
      partialReasons.add('attachment-association-unavailable');
    }
  }

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

  const { redactedDocument, bundleFiles } = await redactAndBuildBundle(
    allPending,
    workingDoc,
    partialReasons,
    knownSecrets,
    signal
  );

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
  };

  return { document: finalDocument, bundleFiles };
}
