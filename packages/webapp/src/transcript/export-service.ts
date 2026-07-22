/**
 * Transcript export service — three source paths.
 *
 * Orchestrates the active, new-frozen, and legacy export flows:
 *
 *   Active   → collect → normalize → processTranscriptAttachments (which
 *              includes redaction) → validate → createTranscriptZip
 *
 *   New-frozen → readSnapshot → reredactStoredSnapshot → validate →
 *               createTranscriptZip
 *
 *   Legacy   → readSessionsIndex → parseFrozenArchive → build partial
 *              document → processTranscriptAttachments → validate →
 *              createTranscriptZip
 *
 * JSON validates immediately before packaging. Redaction failure and schema
 * failures emit zero ZIP chunks (they throw before createTranscriptZip is
 * called). Registration teardown only clears its own service instance.
 */
import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptDocumentV1,
  TranscriptExportError,
  type TranscriptExportProgress,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import { parseFrozenArchive, readSessionsIndex } from '../ui/session-freezer.js';
import { processTranscriptAttachments } from './attachments.js';
import type { TranscriptCollectionDeps } from './collect.js';
import { collectActiveTranscriptSources } from './collect.js';
import { type NormalizedTranscript, normalizeConversations } from './normalize.js';
import { type KnownSecretBatchRedactor, redactTranscript } from './redact.js';
import type { SanitizedTranscriptSnapshot } from './snapshot-store.js';
import { createTranscriptZip, type TranscriptZipResult } from './zip-stream.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type TranscriptSessionSelector = { kind: 'active' } | { kind: 'frozen'; sessionId: string };

export interface FrozenTranscriptMetadata {
  sessionId: string;
  title: string;
  frozenAt: string;
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptExportService {
  export(
    selector: TranscriptSessionSelector,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: TranscriptExportProgress) => void;
    }
  ): Promise<TranscriptZipResult>;
  captureFrozen(metadata: FrozenTranscriptMetadata, signal?: AbortSignal): Promise<void>;
}

export interface ExportServiceDeps {
  collection: TranscriptCollectionDeps;
  knownSecrets: KnownSecretBatchRedactor;
  snapshotStore: {
    read(sessionId: string): Promise<SanitizedTranscriptSnapshot | null>;
    write(sessionId: string, snapshot: SanitizedTranscriptSnapshot): Promise<void>;
  };
  /** Read-only VFS — used for sessions index and legacy archive markdown. */
  vfs: LocalVfsClient;
  /** Returns id + title for the current active session. */
  getActiveSessionInfo(): { id: string; title: string };
  /** Displayed in `export.producer.version`. */
  version: string;
}

// ---------------------------------------------------------------------------
// Internal result type shared across paths
// ---------------------------------------------------------------------------

interface SnapshotResult {
  document: TranscriptDocumentV1;
  bundleFiles: Map<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Helpers — document skeleton builder
// ---------------------------------------------------------------------------

function buildDocumentSkeleton(
  sessionId: string,
  title: string,
  state: 'active' | 'frozen',
  normalized: NormalizedTranscript,
  version: string,
  extraSession: Partial<TranscriptDocumentV1['session']> = {}
): TranscriptDocumentV1 {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    export: {
      id: crypto.randomUUID(),
      generatedAt: new Date().toISOString(),
      producer: { application: 'slicc', version },
      format: SLICC_TRANSCRIPT_FORMAT,
    },
    session: {
      id: sessionId,
      title,
      state,
      completeness: { status: 'complete', missing: [] },
      ...extraSession,
    },
    privacy: {
      reasoningExcluded: true,
      excludedReasoningBlocks: normalized.excludedReasoningBlocks,
      binaryAttachments: 'included-unchanged',
      redactionCounts: {},
      redactions: [],
    },
    conversations: normalized.conversations,
    delegations: normalized.delegations,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers — ChatMessage → TranscriptMessage conversion (legacy path)
// ---------------------------------------------------------------------------

function buildTranscriptMessages(
  messages: readonly ChatMessage[],
  conversationId: string
): TranscriptDocumentV1['conversations'][number]['messages'] {
  const result: TranscriptDocumentV1['conversations'][number]['messages'] = [];
  let seq = 1;
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const id = `${conversationId}-msg-${String(seq).padStart(6, '0')}`;
    result.push({
      id,
      sequence: seq++,
      role: msg.role,
      timestamp: new Date(msg.timestamp || 0).toISOString(),
      content: msg.content ? [{ type: 'text' as const, text: msg.content }] : [],
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers — validate and throw on schema failure
// ---------------------------------------------------------------------------

function assertValid(document: TranscriptDocumentV1): void {
  const validation = validateTranscriptDocumentV1(document);
  if (!validation.ok) {
    throw new TranscriptExportError('schema-invalid');
  }
}

// ---------------------------------------------------------------------------
// Helpers — rebuild bundle files after re-redaction
// ---------------------------------------------------------------------------

/**
 * Reconstruct bundle files from re-redaction output.
 *
 * Text attachments: re-encoded from `textAttachments` (redacted content).
 * Binary attachments: copied unchanged from `originalFiles`.
 */
function rebuildBundleFiles(
  attachments: TranscriptDocumentV1['attachments'],
  textAttachments: Map<string, string>,
  originalFiles: Map<string, Uint8Array>
): Map<string, Uint8Array> {
  const bundleFiles = new Map<string, Uint8Array>();
  for (const att of attachments) {
    if (!att.present || !att.path) continue;
    if (att.handling === 'text-redacted') {
      const text = textAttachments.get(att.id);
      if (text !== undefined) bundleFiles.set(att.path, new TextEncoder().encode(text));
    } else {
      const bytes = originalFiles.get(att.path);
      if (bytes) bundleFiles.set(att.path, bytes);
    }
  }
  return bundleFiles;
}

// ---------------------------------------------------------------------------
// DefaultTranscriptExportService
// ---------------------------------------------------------------------------

export class DefaultTranscriptExportService implements TranscriptExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  async export(
    selector: TranscriptSessionSelector,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: TranscriptExportProgress) => void;
    } = {}
  ): Promise<TranscriptZipResult> {
    const { signal, onProgress } = options;

    let result: SnapshotResult;

    if (selector.kind === 'active') {
      result = await this.buildActiveSnapshot(signal, onProgress);
    } else {
      result = await this.buildFrozenSnapshot(selector.sessionId, signal, onProgress);
    }

    // Validate immediately before packaging — no ZIP chunks on schema failure.
    assertValid(result.document);

    onProgress?.({ phase: 'packaging' });
    return createTranscriptZip(result.document, result.bundleFiles, signal);
  }

  async captureFrozen(metadata: FrozenTranscriptMetadata, signal?: AbortSignal): Promise<void> {
    const collected = await collectActiveTranscriptSources(this.deps.collection, signal);
    const normalized = normalizeConversations(collected.sources);

    const document = buildDocumentSkeleton(
      metadata.sessionId,
      metadata.title,
      'frozen',
      normalized,
      this.deps.version,
      {
        frozenAt: metadata.frozenAt,
        createdAt: new Date(metadata.createdAt).toISOString(),
        updatedAt: new Date(metadata.updatedAt).toISOString(),
      }
    );

    const { document: finalDoc, bundleFiles } = await processTranscriptAttachments({
      document,
      chatMessagesByConversation: collected.chatMessagesByConversation,
      knownSecrets: this.deps.knownSecrets,
      signal,
    });

    assertValid(finalDoc);

    await this.deps.snapshotStore.write(metadata.sessionId, {
      document: finalDoc,
      attachments: bundleFiles,
    });
  }

  // ---------------------------------------------------------------------------
  // Private — active snapshot
  // ---------------------------------------------------------------------------

  private async buildActiveSnapshot(
    signal?: AbortSignal,
    onProgress?: (p: TranscriptExportProgress) => void
  ): Promise<SnapshotResult> {
    onProgress?.({ phase: 'waiting-for-conversations' });

    const collected = await collectActiveTranscriptSources(this.deps.collection, signal);

    onProgress?.({ phase: 'collecting' });

    const normalized = normalizeConversations(collected.sources);
    const { id, title } = this.deps.getActiveSessionInfo();

    const document = buildDocumentSkeleton(id, title, 'active', normalized, this.deps.version);

    onProgress?.({ phase: 'redacting' });

    return processTranscriptAttachments({
      document,
      chatMessagesByConversation: collected.chatMessagesByConversation,
      knownSecrets: this.deps.knownSecrets,
      signal,
    });
  }

  // ---------------------------------------------------------------------------
  // Private — frozen snapshot (new or legacy)
  // ---------------------------------------------------------------------------

  private async buildFrozenSnapshot(
    sessionId: string,
    signal?: AbortSignal,
    onProgress?: (p: TranscriptExportProgress) => void
  ): Promise<SnapshotResult> {
    const stored = await this.deps.snapshotStore.read(sessionId);

    if (stored) {
      onProgress?.({ phase: 'redacting' });
      return this.reredactStoredSnapshot(stored, signal);
    }

    return this.buildLegacyPartial(sessionId, signal, onProgress);
  }

  // ---------------------------------------------------------------------------
  // Private — re-redact an existing sanitized snapshot
  // ---------------------------------------------------------------------------

  private async reredactStoredSnapshot(
    snapshot: SanitizedTranscriptSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotResult> {
    // Build text map: attachmentId → plain text (decode from stored bytes).
    const textMap = new Map<string, string>();
    for (const att of snapshot.document.attachments) {
      if (att.handling !== 'text-redacted' || !att.present || !att.path) continue;
      const bytes = snapshot.attachments.get(att.path);
      if (!bytes) continue;
      textMap.set(att.id, new TextDecoder().decode(bytes));
    }

    // Re-run redaction with the current knownSecrets.
    let redactedDocument: TranscriptDocumentV1;
    let redactedTextAttachments: Map<string, string>;
    try {
      const res = await redactTranscript(
        snapshot.document,
        textMap,
        this.deps.knownSecrets,
        signal
      );
      redactedDocument = res.document;
      redactedTextAttachments = res.textAttachments;
    } catch {
      throw new TranscriptExportError('redaction-unavailable');
    }

    // Rebuild bundle files: re-encoded text + unchanged binary.
    const bundleFiles = rebuildBundleFiles(
      redactedDocument.attachments,
      redactedTextAttachments,
      snapshot.attachments
    );

    return { document: redactedDocument, bundleFiles };
  }

  // ---------------------------------------------------------------------------
  // Private — build partial document from legacy markdown archive
  // ---------------------------------------------------------------------------

  private async buildLegacyPartial(
    sessionId: string,
    signal?: AbortSignal,
    onProgress?: (p: TranscriptExportProgress) => void
  ): Promise<SnapshotResult> {
    // Find the sessions index entry for this sessionId.
    const index = await readSessionsIndex(this.deps.vfs);
    const entry = index.find((e) => e.sessionId === sessionId);
    if (!entry) throw new TranscriptExportError('session-not-found');

    // Read the markdown file.
    let markdown: string;
    try {
      const raw = await this.deps.vfs.readFile(`/sessions/${entry.filename}`, {
        encoding: 'utf-8',
      });
      markdown = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      throw new TranscriptExportError('session-not-found');
    }

    // Parse the frozen archive.
    const { title, messages } = parseFrozenArchive(markdown);

    // Build a partial TranscriptDocumentV1 from UI ChatMessages.
    const convId = 'legacy-cone';
    const transcriptMessages = buildTranscriptMessages(messages, convId);
    const document: TranscriptDocumentV1 = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      export: {
        id: crypto.randomUUID(),
        generatedAt: new Date().toISOString(),
        producer: { application: 'slicc', version: this.deps.version },
        format: SLICC_TRANSCRIPT_FORMAT,
      },
      session: {
        id: sessionId,
        title,
        state: 'frozen',
        ...(entry.frozenAt ? { frozenAt: entry.frozenAt } : {}),
        completeness: {
          status: 'partial',
          missing: ['complete-snapshot-unavailable', 'canonical-agent-history-unavailable'],
        },
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
          name: title,
          messages: transcriptMessages,
        },
      ],
      delegations: [],
      attachments: [],
    };

    // Use chatMessagesByConversation so processTranscriptAttachments can pick
    // up Phase-2 file attachments from UI ChatMessages.
    const chatMessagesByConversation = new Map<string, readonly ChatMessage[]>([
      [convId, messages],
    ]);

    onProgress?.({ phase: 'redacting' });

    return processTranscriptAttachments({
      document,
      chatMessagesByConversation,
      knownSecrets: this.deps.knownSecrets,
      signal,
    });
  }
}
