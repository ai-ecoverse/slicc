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
import { processTranscriptAttachments } from './attachments.js';
import type { TranscriptCollectionDeps } from './collect.js';
import { collectActiveTranscriptSources } from './collect.js';
import { readSessionsIndex } from './frozen-archive-format.js';
import { type NormalizedTranscript, normalizeConversations } from './normalize.js';
import { type KnownSecretBatchRedactor, redactTranscript } from './redact.js';
import type { SanitizedTranscriptSnapshot } from './snapshot-store.js';
import { createTranscriptZip, type TranscriptZipResult } from './zip-stream.js';

export type TranscriptSessionSelector = { kind: 'active' } | { kind: 'frozen'; sessionId: string };

export interface FrozenTranscriptMetadata {
  sessionId: string;
  title: string;
  frozenAt: string;
  createdAt: number;
  updatedAt: number;

  rootJid?: string;
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

  vfs: LocalVfsClient;

  getActiveSessionInfo(): { id: string; title: string };

  version: string;
}

interface SnapshotResult {
  document: TranscriptDocumentV1;
  bundleFiles: Map<string, Uint8Array>;
}

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

function assertValid(document: TranscriptDocumentV1): void {
  const validation = validateTranscriptDocumentV1(document);
  if (!validation.ok) {
    throw new TranscriptExportError('schema-invalid', validation.error);
  }
}

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

async function patchTextAttachmentMetadata(
  attachments: TranscriptDocumentV1['attachments'],
  bundleFiles: Map<string, Uint8Array>
): Promise<TranscriptDocumentV1['attachments']> {
  return Promise.all(
    attachments.map(async (att) => {
      if (!att.present || !att.path || att.handling !== 'text-redacted') return att;
      const bytes = bundleFiles.get(att.path);
      if (!bytes) return att;
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      const sha256Hex = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return { ...att, byteLength: bytes.length, sha256: sha256Hex };
    })
  );
}

function parseFrontmatterTimestamps(
  markdown: string
): Partial<{ createdAt: string; updatedAt: string }> {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return {};
  const fm = fmMatch[1];
  const result: Partial<{ createdAt: string; updatedAt: string }> = {};
  const caMp = fm.match(/^createdAt:\s*(\d+)\s*$/m);
  const uaMp = fm.match(/^updatedAt:\s*(\d+)\s*$/m);
  if (caMp) result.createdAt = new Date(Number(caMp[1])).toISOString();
  if (uaMp) result.updatedAt = new Date(Number(uaMp[1])).toISOString();
  return result;
}

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

    assertValid(result.document);

    onProgress?.({ phase: 'packaging' });
    return createTranscriptZip(result.document, result.bundleFiles, signal);
  }

  async captureFrozen(metadata: FrozenTranscriptMetadata, signal?: AbortSignal): Promise<void> {
    const collected = await collectActiveTranscriptSources(this.deps.collection, signal, {
      ...(metadata.rootJid ? { rootJid: metadata.rootJid } : {}),
    });

    if (metadata.rootJid && collected.sources.length === 0) return;
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
      canonicalImages: normalized.canonicalImages,
      vfsReader: (path) => this.readBinaryFromVfs(path),
      signal,
    });

    assertValid(finalDoc);

    await this.deps.snapshotStore.write(metadata.sessionId, {
      document: finalDoc,
      attachments: bundleFiles,
    });
  }

  private async buildActiveSnapshot(
    signal?: AbortSignal,
    onProgress?: (p: TranscriptExportProgress) => void
  ): Promise<SnapshotResult> {
    onProgress?.({ phase: 'waiting-for-conversations' });
    onProgress?.({ phase: 'collecting' });

    const collected = await collectActiveTranscriptSources(this.deps.collection, signal);

    const normalized = normalizeConversations(collected.sources);
    const { id, title } = this.deps.getActiveSessionInfo();

    const document = buildDocumentSkeleton(id, title, 'active', normalized, this.deps.version);

    onProgress?.({ phase: 'redacting' });

    return processTranscriptAttachments({
      document,
      chatMessagesByConversation: collected.chatMessagesByConversation,
      knownSecrets: this.deps.knownSecrets,
      canonicalImages: normalized.canonicalImages,
      vfsReader: (path) => this.readBinaryFromVfs(path),
      signal,
    });
  }

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

  private async reredactStoredSnapshot(
    snapshot: SanitizedTranscriptSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotResult> {
    const textMap = new Map<string, string>();
    for (const att of snapshot.document.attachments) {
      if (att.handling !== 'text-redacted' || !att.present || !att.path) continue;
      const bytes = snapshot.attachments.get(att.path);
      if (!bytes) continue;
      textMap.set(att.id, new TextDecoder().decode(bytes));
    }

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

    const bundleFiles = rebuildBundleFiles(
      redactedDocument.attachments,
      redactedTextAttachments,
      snapshot.attachments
    );

    const patchedAttachments = await patchTextAttachmentMetadata(
      redactedDocument.attachments,
      bundleFiles
    );

    return { document: { ...redactedDocument, attachments: patchedAttachments }, bundleFiles };
  }

  private async buildLegacyPartial(
    sessionId: string,
    signal?: AbortSignal,
    onProgress?: (p: TranscriptExportProgress) => void
  ): Promise<SnapshotResult> {
    const index = await readSessionsIndex(this.deps.vfs);
    const entry = index.find(
      (e) => e.sessionId === sessionId || (!e.sessionId && e.filename === sessionId)
    );
    if (!entry) throw new TranscriptExportError('session-not-found');

    let markdown: string;
    try {
      const raw = await this.deps.vfs.readFile(`/sessions/${entry.filename}`, {
        encoding: 'utf-8',
      });
      markdown = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      throw new TranscriptExportError('session-not-found');
    }

    const { loadFrozenArchive } = await import('./session-jsonl.js');
    const { title, messages } = await loadFrozenArchive(this.deps.vfs, markdown, entry.filename);

    const convId = 'legacy-cone';
    const transcriptMessages = buildTranscriptMessages(messages, convId);

    const legacyTimestamps = parseFrontmatterTimestamps(markdown);

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
        ...legacyTimestamps,
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

    const chatMessagesByConversation = new Map<string, readonly ChatMessage[]>([
      [convId, messages],
    ]);

    onProgress?.({ phase: 'redacting' });

    return processTranscriptAttachments({
      document,
      chatMessagesByConversation,
      knownSecrets: this.deps.knownSecrets,
      vfsReader: (path) => this.readBinaryFromVfs(path),
      signal,
    });
  }

  private async readBinaryFromVfs(path: string): Promise<Uint8Array> {
    const raw = await this.deps.vfs.readFile(path, { encoding: 'binary' });
    if (!(raw instanceof Uint8Array)) {
      throw new TranscriptExportError('attachment-unreadable');
    }
    return raw;
  }
}
