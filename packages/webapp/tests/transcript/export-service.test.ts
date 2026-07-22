/**
 * Unit tests for export-service.ts — three export source paths.
 *
 * TDD RED phase: all tests written before production code exists.
 *
 * Dependency injection via ExportServiceDeps. The export service is
 * instantiated with mock deps and the output ZIP is verified via fflate's
 * unzipSync.
 */

import { TranscriptExportError, type TranscriptExportProgress } from '@slicc/shared-ts';
import { strFromU8, unzipSync } from 'fflate';
import { sha256 } from 'js-sha256';
import { describe, expect, it, type MockedFunction, vi } from 'vitest';
import type { TranscriptCollectionDeps } from '../../src/transcript/collect.js';
import {
  getTranscriptExportService,
  registerTranscriptExportService,
} from '../../src/transcript/export-provider.js';
import {
  DefaultTranscriptExportService,
  type ExportServiceDeps,
} from '../../src/transcript/export-service.js';
import type { SanitizedTranscriptSnapshot } from '../../src/transcript/snapshot-store.js';
import { makeTranscriptDocument } from './fixtures.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/** A KnownSecretBatchRedactor that passes text through unchanged. */
function makePassthroughRedactor() {
  return {
    redact: vi.fn(async (texts: readonly string[]) => [...texts]),
  };
}

/** A KnownSecretBatchRedactor that always throws. */
function makeFailingRedactor() {
  return {
    redact: vi.fn(async (_texts: readonly string[]) => {
      throw new Error('redaction service unavailable');
    }),
  };
}

/**
 * A minimal TranscriptCollectionDeps that returns one cone conversation
 * with no messages.
 */
function makeCollectionDeps(): TranscriptCollectionDeps {
  return {
    listScoops: vi.fn(
      () =>
        [
          {
            jid: 'jid-cone',
            isCone: true,
            name: 'Sliccy',
            folder: undefined,
            parentJid: undefined,
            originToolCallId: undefined,
          },
        ] as any
    ),
    isProcessing: vi.fn(() => false),
    getAgentMessages: vi.fn(() => []),
    loadPersistedSessions: vi.fn(async () => []),
    loadUiChatSessions: vi.fn(async () => []),
    wait: vi.fn(async () => undefined),
  };
}

/** A snapshot store that always returns null (no stored snapshot). */
function makeEmptySnapshotStore() {
  return {
    read: vi.fn(async (_id: string) => null as SanitizedTranscriptSnapshot | null),
    write: vi.fn(async (_id: string, _snapshot: SanitizedTranscriptSnapshot) => undefined),
  };
}

/** A snapshot store that returns a pre-built snapshot. */
function makeSnapshotStoreWith(snapshot: SanitizedTranscriptSnapshot) {
  return {
    read: vi.fn(async (_id: string) => snapshot),
    write: vi.fn(async (_id: string, _snapshot: SanitizedTranscriptSnapshot) => undefined),
  };
}

/**
 * A minimal VFS that:
 * - Returns the given index JSON for /sessions/index.json
 * - Returns the given markdown for session markdown paths
 */
function makeVfs(options: { indexJson?: string; sessionMarkdown?: Map<string, string> } = {}) {
  const { indexJson = '[]', sessionMarkdown = new Map<string, string>() } = options;
  return {
    readFile: vi.fn(async (path: string, _opts?: unknown): Promise<string | Uint8Array> => {
      if (path === '/sessions/index.json') return indexJson;
      for (const [filename, content] of sessionMarkdown) {
        if (path === `/sessions/${filename}`) return content;
      }
      const err = Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      throw err;
    }),
    readDir: vi.fn(async () => []),
  };
}

/** Collect all ZIP bytes from an AsyncIterable<Uint8Array>. */
async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of chunks) parts.push(...chunk);
  return Uint8Array.from(parts);
}

/** Build a minimal frozen archive markdown that parseFrozenArchive can parse. */
function makeArchiveMarkdown(
  title: string,
  messages: Array<{ role: string; content: string }>
): string {
  const frozenAt = '2024-01-01T00:00:00.000Z';
  const dataBlock = JSON.stringify(
    messages.map((m, i) => ({
      id: `msg-${i}`,
      role: m.role,
      content: m.content,
      timestamp: 1_000 + i,
    }))
  );
  return (
    `---\n` +
    `id: sess-legacy-001\n` +
    `title: ${JSON.stringify(title)}\n` +
    `frozenAt: ${frozenAt}\n` +
    `createdAt: 1000\n` +
    `updatedAt: 2000\n` +
    `messageCount: ${messages.length}\n` +
    `---\n\n` +
    `<!-- slicc:session-data\n${dataBlock}\n-->\n\n` +
    `# ${title}\n\n` +
    messages
      .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`)
      .join('\n\n')
  );
}

/** Build a minimal deps object for the export service. */
function makeDeps(overrides: Partial<ExportServiceDeps> = {}): ExportServiceDeps {
  return {
    collection: makeCollectionDeps(),
    knownSecrets: makePassthroughRedactor(),
    snapshotStore: makeEmptySnapshotStore(),
    vfs: makeVfs() as any,
    getActiveSessionInfo: vi.fn(() => ({ id: 'sess-active-001', title: 'Active session' })),
    version: '0.0.0-test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Active path tests
// ---------------------------------------------------------------------------

describe('DefaultTranscriptExportService — active path', () => {
  it('collects, normalizes, redacts, and packages the active session', async () => {
    const deps = makeDeps();
    const svc = new DefaultTranscriptExportService(deps);
    const result = await svc.export({ kind: 'active' });

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;
    expect(completion.byteLength).toBe(archive.length);

    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));
    expect(doc.session.state).toBe('active');
    expect(doc.session.id).toBe('sess-active-001');
  });

  it('calls the collection deps to collect sources', async () => {
    const collection = makeCollectionDeps();
    const deps = makeDeps({ collection });
    const svc = new DefaultTranscriptExportService(deps);
    await svc.export({ kind: 'active' });
    expect(collection.listScoops).toHaveBeenCalled();
  });

  it('emits progress phases in order', async () => {
    const deps = makeDeps();
    const svc = new DefaultTranscriptExportService(deps);
    const phases: string[] = [];
    await svc.export({ kind: 'active' }, { onProgress: (p) => phases.push(p.phase) });
    // Phases must be ordered (no going back)
    const PHASE_ORDER = ['waiting-for-conversations', 'collecting', 'redacting', 'packaging'];
    let lastIdx = -1;
    for (const phase of phases) {
      const idx = PHASE_ORDER.indexOf(phase);
      if (idx !== -1) {
        expect(idx).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    }
    // At least collecting and packaging must appear
    expect(phases).toContain('collecting');
    expect(phases).toContain('packaging');
  });

  it('emits zero ZIP chunks when redaction fails', async () => {
    const deps = makeDeps({ knownSecrets: makeFailingRedactor() });
    // Inject an attachment so redaction is triggered
    const collection = makeCollectionDeps();
    (
      collection.loadUiChatSessions as MockedFunction<typeof collection.loadUiChatSessions>
    ).mockResolvedValue([
      {
        id: 'session-cone',
        messages: [
          {
            id: 'msg-1',
            role: 'user' as const,
            content: 'hi',
            timestamp: 1_000,
            attachments: [
              {
                id: 'att-1',
                name: 'secret.txt',
                mimeType: 'text/plain',
                size: 6,
                kind: 'text' as const,
                text: 'secret',
              },
            ],
          },
        ],
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ] as any);
    const deps2 = makeDeps({ knownSecrets: makeFailingRedactor(), collection });

    await expect(
      (async () => {
        const result = await new DefaultTranscriptExportService(deps2).export({ kind: 'active' });
        await collectChunks(result.chunks);
      })()
    ).rejects.toThrow(TranscriptExportError);
  });

  it('propagates abort signal to collection', async () => {
    const controller = new AbortController();
    controller.abort();

    const collection: TranscriptCollectionDeps = {
      ...makeCollectionDeps(),
      isProcessing: vi.fn(() => true), // Forces a poll loop
      wait: vi.fn(async () => {
        /* signal check handled in collect.ts */
      }),
    };

    const deps = makeDeps({ collection });
    const svc = new DefaultTranscriptExportService(deps);
    await expect(svc.export({ kind: 'active' }, { signal: controller.signal })).rejects.toThrow(
      TranscriptExportError
    );
  });
});

// ---------------------------------------------------------------------------
// New-frozen path tests
// ---------------------------------------------------------------------------

describe('DefaultTranscriptExportService — new-frozen path', () => {
  it('reloads stored snapshot and re-runs redaction', async () => {
    const storedDoc = makeTranscriptDocument({ text: 'secret-value' });
    // Mark session as frozen
    storedDoc.session.state = 'frozen';
    storedDoc.session.id = 'sess-frozen-001';

    const snapshot: SanitizedTranscriptSnapshot = {
      document: storedDoc,
      attachments: new Map(),
    };
    const snapshotStore = makeSnapshotStoreWith(snapshot);
    const redactor = makePassthroughRedactor();

    const deps = makeDeps({ snapshotStore, knownSecrets: redactor });
    const svc = new DefaultTranscriptExportService(deps);
    const result = await svc.export({ kind: 'frozen', sessionId: 'sess-frozen-001' });

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;
    expect(completion.byteLength).toBe(archive.length);

    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));
    expect(doc.session.state).toBe('frozen');
    expect(doc.session.id).toBe('sess-frozen-001');

    // Redactor was called (re-ran on the stored snapshot)
    expect(redactor.redact).toHaveBeenCalled();
  });

  it('re-redacts stored text attachments using current secrets', async () => {
    const storedDoc = makeTranscriptDocument();
    storedDoc.session.state = 'frozen';
    storedDoc.attachments = [
      {
        id: 'att-001',
        path: 'attachments/att-0001.txt',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 11,
        sha256: '',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        handling: 'text-redacted',
        present: true,
      },
    ];

    const textBytes = new TextEncoder().encode('hello world');
    const snapshot: SanitizedTranscriptSnapshot = {
      document: storedDoc,
      attachments: new Map([['attachments/att-0001.txt', textBytes]]),
    };

    const redactor = {
      redact: vi.fn(async (texts: readonly string[]) =>
        texts.map((t) => t.replace('hello', '⟦REDACTED:credential-pattern:r1⟧'))
      ),
    };

    const deps = makeDeps({
      snapshotStore: makeSnapshotStoreWith(snapshot),
      knownSecrets: redactor,
    });
    const svc = new DefaultTranscriptExportService(deps);
    const result = await svc.export({ kind: 'frozen', sessionId: 'any-id' });

    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    // The text attachment should have been re-redacted
    const attText = new TextDecoder().decode(files['attachments/att-0001.txt']!);
    expect(attText).toContain('⟦REDACTED:');
    expect(attText).not.toContain('hello');
  });

  it('emits zero ZIP chunks when re-redaction fails', async () => {
    const storedDoc = makeTranscriptDocument();
    storedDoc.session.state = 'frozen';
    storedDoc.attachments = [
      {
        id: 'att-001',
        path: 'attachments/att-0001.txt',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 5,
        sha256: '',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        handling: 'text-redacted',
        present: true,
      },
    ];
    const snapshot: SanitizedTranscriptSnapshot = {
      document: storedDoc,
      attachments: new Map([['attachments/att-0001.txt', new TextEncoder().encode('hello')]]),
    };

    const deps = makeDeps({
      snapshotStore: makeSnapshotStoreWith(snapshot),
      knownSecrets: makeFailingRedactor(),
    });
    const svc = new DefaultTranscriptExportService(deps);

    await expect(svc.export({ kind: 'frozen', sessionId: 'any-id' })).rejects.toThrow(
      TranscriptExportError
    );
  });

  it('validates the frozen document before packaging', async () => {
    // Create a document with an invalid schema to trigger schema-invalid
    const storedDoc = makeTranscriptDocument();
    storedDoc.session.state = 'frozen';
    // Corrupt the schema version
    (storedDoc as any).schemaVersion = 99;

    const snapshot: SanitizedTranscriptSnapshot = {
      document: storedDoc,
      attachments: new Map(),
    };

    const deps = makeDeps({ snapshotStore: makeSnapshotStoreWith(snapshot) });
    const svc = new DefaultTranscriptExportService(deps);

    await expect(svc.export({ kind: 'frozen', sessionId: 'any-id' })).rejects.toThrow(
      TranscriptExportError
    );
  });
});

// ---------------------------------------------------------------------------
// Legacy path tests
// ---------------------------------------------------------------------------

describe('DefaultTranscriptExportService — legacy path', () => {
  it('falls back to legacy archive when no snapshot exists', async () => {
    const markdown = makeArchiveMarkdown('Legacy Session', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);

    const indexJson = JSON.stringify([
      {
        filename: 'legacy-session.md',
        sessionId: 'sess-legacy-001',
        title: 'Legacy Session',
        frozenAt: '2024-01-01T00:00:00.000Z',
        messageCount: 2,
      },
    ]);

    const vfs = makeVfs({
      indexJson,
      sessionMarkdown: new Map([['legacy-session.md', markdown]]),
    });

    const deps = makeDeps({ snapshotStore: makeEmptySnapshotStore(), vfs: vfs as any });
    const svc = new DefaultTranscriptExportService(deps);

    const result = await svc.export({ kind: 'frozen', sessionId: 'sess-legacy-001' });
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));

    expect(doc.session.state).toBe('frozen');
    expect(doc.session.id).toBe('sess-legacy-001');
    // Must be marked as partial
    expect(doc.session.completeness.status).toBe('partial');
    // Must include complete-snapshot-unavailable reason
    expect(doc.session.completeness.missing).toContain('complete-snapshot-unavailable');
  });

  it('throws session-not-found when sessionId is not in index', async () => {
    const deps = makeDeps({
      snapshotStore: makeEmptySnapshotStore(),
      vfs: makeVfs({ indexJson: '[]' }) as any,
    });
    const svc = new DefaultTranscriptExportService(deps);

    await expect(
      svc.export({ kind: 'frozen', sessionId: 'nonexistent-session' })
    ).rejects.toMatchObject({ code: 'session-not-found' });
  });

  it('includes message content from the legacy archive', async () => {
    const markdown = makeArchiveMarkdown('My Session', [
      { role: 'user', content: 'what is 2+2?' },
      { role: 'assistant', content: 'It is 4.' },
    ]);

    const indexJson = JSON.stringify([
      {
        filename: 'my-session.md',
        sessionId: 'sess-001',
        title: 'My Session',
        frozenAt: '2024-01-01T00:00:00.000Z',
        messageCount: 2,
      },
    ]);

    const vfs = makeVfs({
      indexJson,
      sessionMarkdown: new Map([['my-session.md', markdown]]),
    });

    const deps = makeDeps({ snapshotStore: makeEmptySnapshotStore(), vfs: vfs as any });
    const svc = new DefaultTranscriptExportService(deps);

    const result = await svc.export({ kind: 'frozen', sessionId: 'sess-001' });
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));

    // Should have a conversation with messages from the archive
    const messages = doc.conversations[0]?.messages ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const textBlock = userMsg?.content?.find((b: any) => b.type === 'text');
    expect(textBlock?.text).toContain('2+2');
  });

  it('runs redaction over legacy text content', async () => {
    const markdown = makeArchiveMarkdown('Redact Me', [
      { role: 'user', content: 'token=ghp_ABC123456789012345678901234567890123456' },
    ]);

    const indexJson = JSON.stringify([
      {
        filename: 'redact-me.md',
        sessionId: 'sess-redact-001',
        title: 'Redact Me',
        frozenAt: '2024-01-01T00:00:00.000Z',
        messageCount: 1,
      },
    ]);

    const vfs = makeVfs({
      indexJson,
      sessionMarkdown: new Map([['redact-me.md', markdown]]),
    });

    const deps = makeDeps({
      snapshotStore: makeEmptySnapshotStore(),
      vfs: vfs as any,
      knownSecrets: makePassthroughRedactor(),
    });
    const svc = new DefaultTranscriptExportService(deps);

    const result = await svc.export({ kind: 'frozen', sessionId: 'sess-redact-001' });
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));

    // Credential pattern (ghp_) should have been redacted in the document
    const docJson = strFromU8(files['transcript.json']!);
    expect(docJson).toContain('⟦REDACTED:');
    expect(docJson).not.toContain('ghp_ABC123456789012345678901234567890123456');
    void doc; // suppress lint warning
  });
});

// ---------------------------------------------------------------------------
// captureFrozen tests
// ---------------------------------------------------------------------------

describe('DefaultTranscriptExportService — captureFrozen', () => {
  it('writes a sanitized snapshot to the snapshot store', async () => {
    const snapshotStore = makeEmptySnapshotStore();
    const deps = makeDeps({ snapshotStore });
    const svc = new DefaultTranscriptExportService(deps);

    await svc.captureFrozen({
      sessionId: 'sess-freeze-001',
      title: 'Frozen Title',
      frozenAt: '2024-06-01T12:00:00.000Z',
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    expect(snapshotStore.write).toHaveBeenCalledWith(
      'sess-freeze-001',
      expect.objectContaining({
        document: expect.objectContaining({
          session: expect.objectContaining({
            id: 'sess-freeze-001',
            title: 'Frozen Title',
            state: 'frozen',
          }),
        }),
      })
    );
  });

  it('propagates abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const collection: TranscriptCollectionDeps = {
      ...makeCollectionDeps(),
      isProcessing: vi.fn(() => true),
      wait: vi.fn(async () => undefined),
    };

    const deps = makeDeps({ collection });
    const svc = new DefaultTranscriptExportService(deps);

    await expect(
      svc.captureFrozen(
        {
          sessionId: 'sess-001',
          title: 'Title',
          frozenAt: '2024-01-01T00:00:00.000Z',
          createdAt: 0,
          updatedAt: 0,
        },
        controller.signal
      )
    ).rejects.toThrow(TranscriptExportError);
  });
});

// ---------------------------------------------------------------------------
// Progress emission tests
// ---------------------------------------------------------------------------

describe('DefaultTranscriptExportService — progress', () => {
  it('emits collecting BEFORE collection begins (not after)', async () => {
    // Track whether `collecting` fires before collection runs.
    const collectingFiredBeforeCollection = false;
    let collectionCalled = false;

    const collection = makeCollectionDeps();
    const listScoopsMock = vi.fn(() => [] as any);
    collection.listScoops = listScoopsMock;

    const deps = makeDeps({ collection });
    const svc = new DefaultTranscriptExportService(deps);
    const phases: TranscriptExportProgress['phase'][] = [];

    await svc.export(
      { kind: 'active' },
      {
        onProgress: (p) => {
          phases.push(p.phase);
          if (p.phase === 'collecting') {
            // At the moment 'collecting' fires, collection must not have started yet.
            collectionCalled = listScoopsMock.mock.calls.length > 0;
          }
        },
      }
    );
    expect(phases).toContain('collecting');
    // 'collecting' must fire before listScoops is called by the collector.
    expect(collectionCalled).toBe(false);
  });

  it('emits waiting-for-conversations before collecting', async () => {
    const deps = makeDeps();
    const svc = new DefaultTranscriptExportService(deps);
    const phases: TranscriptExportProgress['phase'][] = [];

    await svc.export({ kind: 'active' }, { onProgress: (p) => phases.push(p.phase) });

    const waitIdx = phases.indexOf('waiting-for-conversations');
    const collectIdx = phases.indexOf('collecting');
    // waiting-for-conversations must come before collecting (if both appear)
    if (waitIdx !== -1 && collectIdx !== -1) {
      expect(waitIdx).toBeLessThan(collectIdx);
    }
    expect(phases.some((p) => ['waiting-for-conversations', 'collecting'].includes(p))).toBe(true);
  });

  it('emits packaging after redacting', async () => {
    const deps = makeDeps();
    const svc = new DefaultTranscriptExportService(deps);
    const phases: TranscriptExportProgress['phase'][] = [];

    await svc.export({ kind: 'active' }, { onProgress: (p) => phases.push(p.phase) });

    const redactIdx = phases.indexOf('redacting');
    const packageIdx = phases.indexOf('packaging');
    if (redactIdx !== -1 && packageIdx !== -1) {
      expect(redactIdx).toBeLessThan(packageIdx);
    }
    expect(phases).toContain('packaging');
  });
});

// ---------------------------------------------------------------------------
// Re-redaction metadata consistency tests (H3 regression)
// ---------------------------------------------------------------------------

describe('DefaultTranscriptExportService — re-redaction metadata', () => {
  it('recomputes byteLength and sha256 after re-redacting stored text attachment', async () => {
    const storedDoc = makeTranscriptDocument();
    storedDoc.session.state = 'frozen';
    // Stale metadata: 11 bytes / old hash — will be wrong after redaction expands the text.
    storedDoc.attachments = [
      {
        id: 'att-001',
        path: 'attachments/att-0001.txt',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 11,
        sha256: 'old-stale-hash-that-must-not-survive',
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        handling: 'text-redacted',
        present: true,
      },
    ];

    const originalText = 'hello world';
    const textBytes = new TextEncoder().encode(originalText); // 11 bytes
    const snapshot: SanitizedTranscriptSnapshot = {
      document: storedDoc,
      attachments: new Map([['attachments/att-0001.txt', textBytes]]),
    };

    // Redactor only modifies the known attachment text so enum values are preserved.
    const sentinel = '\u27e6REDACTED:secret:r1\u27e7';
    const redactor = {
      redact: vi.fn(async (texts: readonly string[]) =>
        texts.map((t) => (t === originalText ? sentinel : t))
      ),
    };

    const deps = makeDeps({
      snapshotStore: makeSnapshotStoreWith(snapshot),
      knownSecrets: redactor,
    });
    const svc = new DefaultTranscriptExportService(deps);
    const result = await svc.export({ kind: 'frozen', sessionId: 'any-id' });

    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!)) as {
      attachments: Array<{ id: string; byteLength: number; sha256: string; path: string }>;
    };
    const att = doc.attachments[0]!;

    const expectedBytes = new TextEncoder().encode(sentinel);
    const expectedHash = sha256(expectedBytes);

    // byteLength in transcript.json must match the re-encoded zip entry.
    expect(att.byteLength).toBe(expectedBytes.length);
    expect(att.byteLength).not.toBe(11); // must NOT be the stale value

    // sha256 in transcript.json must match the actual zip entry bytes.
    expect(att.sha256).toBe(expectedHash);
    expect(att.sha256).not.toBe('old-stale-hash-that-must-not-survive');

    // Cross-check: the zip entry itself must have the same length.
    const zipEntry = files['attachments/att-0001.txt']!;
    expect(zipEntry.byteLength).toBe(att.byteLength);
  });
});

// ---------------------------------------------------------------------------
// Registration / teardown tests (export-provider seam)
// ---------------------------------------------------------------------------

describe('registerTranscriptExportService / getTranscriptExportService', () => {
  it('getTranscriptExportService returns the registered service', () => {
    const svc = new DefaultTranscriptExportService(makeDeps());
    const teardown = registerTranscriptExportService(svc);
    try {
      expect(getTranscriptExportService()).toBe(svc);
    } finally {
      teardown();
    }
  });

  it('teardown clears the registered service', () => {
    const svc = new DefaultTranscriptExportService(makeDeps());
    const teardown = registerTranscriptExportService(svc);
    teardown();
    expect(() => getTranscriptExportService()).toThrow(TranscriptExportError);
  });

  it('stale teardown does not evict a newer registration', () => {
    const svc1 = new DefaultTranscriptExportService(makeDeps());
    const svc2 = new DefaultTranscriptExportService(makeDeps());
    const teardown1 = registerTranscriptExportService(svc1);
    // Override with a newer registration.
    const teardown2 = registerTranscriptExportService(svc2);
    // Calling the OLD teardown must NOT clear svc2.
    teardown1();
    expect(getTranscriptExportService()).toBe(svc2);
    // Clean up.
    teardown2();
  });

  it('throws session-not-found when no service is registered', () => {
    // Ensure no leftover registration from other tests.
    let teardown: (() => void) | null = null;
    try {
      // Try to get a live service and tear it down first.
      getTranscriptExportService();
    } catch {
      // Expected: no service registered.
    }
    // Ensure we start clean by registering and immediately tearing down.
    const tmp = new DefaultTranscriptExportService(makeDeps());
    teardown = registerTranscriptExportService(tmp);
    teardown();
    teardown = null;
    expect(() => getTranscriptExportService()).toThrow(TranscriptExportError);
  });
});
