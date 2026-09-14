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

function makePassthroughRedactor() {
  return {
    redact: vi.fn(async (texts: readonly string[]) => [...texts]),
  };
}

function makeFailingRedactor() {
  return {
    redact: vi.fn(async (_texts: readonly string[]) => {
      throw new Error('redaction service unavailable');
    }),
  };
}

function makeCollectionDeps(): TranscriptCollectionDeps {
  return {
    listScoops: vi.fn(
      () =>
        [
          {
            jid: 'jid-cone',
            isCone: true,
            name: 'Sliccy',
            folder: 'cone',
            parentJid: null,
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

function makeEmptySnapshotStore() {
  return {
    read: vi.fn(async (_id: string) => null as SanitizedTranscriptSnapshot | null),
    write: vi.fn(async (_id: string, _snapshot: SanitizedTranscriptSnapshot) => undefined),
  };
}

function makeSnapshotStoreWith(snapshot: SanitizedTranscriptSnapshot) {
  return {
    read: vi.fn(async (_id: string) => snapshot),
    write: vi.fn(async (_id: string, _snapshot: SanitizedTranscriptSnapshot) => undefined),
  };
}

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

async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of chunks) parts.push(...chunk);
  return Uint8Array.from(parts);
}

function makeArchiveMarkdown(
  title: string,
  messages: Array<{ role: string; content: string }>,
  includeUsageMetadata = false
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
    (includeUsageMetadata
      ? `cost: {"total":0.037,"input":0.01,"output":0.02,"cacheRead":0.003,"cacheWrite":0.004}\n` +
        `models: [{"model":"claude-haiku-4-5","cost":0.037,"turns":1,"tokens":20}]\n`
      : '') +
    `---\n\n` +
    `<!-- slicc:session-data\n${dataBlock}\n-->\n\n` +
    `# ${title}\n\n` +
    messages
      .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`)
      .join('\n\n')
  );
}

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

    const PHASE_ORDER = ['waiting-for-conversations', 'collecting', 'redacting', 'packaging'];
    let lastIdx = -1;
    for (const phase of phases) {
      const idx = PHASE_ORDER.indexOf(phase);
      if (idx !== -1) {
        expect(idx).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    }

    expect(phases).toContain('collecting');
    expect(phases).toContain('packaging');
  });

  it('emits zero ZIP chunks when redaction fails', async () => {
    const deps = makeDeps({ knownSecrets: makeFailingRedactor() });

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
      isProcessing: vi.fn(() => true),
      wait: vi.fn(async () => {}),
    };

    const deps = makeDeps({ collection });
    const svc = new DefaultTranscriptExportService(deps);
    await expect(svc.export({ kind: 'active' }, { signal: controller.signal })).rejects.toThrow(
      TranscriptExportError
    );
  });
});

describe('DefaultTranscriptExportService — new-frozen path', () => {
  it('reloads stored snapshot and re-runs redaction', async () => {
    const storedDoc = makeTranscriptDocument({ text: 'secret-value' });

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
    const storedDoc = makeTranscriptDocument();
    storedDoc.session.state = 'frozen';

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

describe('DefaultTranscriptExportService — legacy path', () => {
  it('parses timestamps when cost metadata follows them in frontmatter', async () => {
    const markdown = makeArchiveMarkdown(
      'Costed Legacy Session',
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      true
    );
    const indexJson = JSON.stringify([
      {
        filename: 'costed-legacy.md',
        sessionId: 'sess-costed-legacy',
        title: 'Costed Legacy Session',
        frozenAt: '2024-01-01T00:00:00.000Z',
        messageCount: 2,
      },
    ]);
    const deps = makeDeps({
      snapshotStore: makeEmptySnapshotStore(),
      vfs: makeVfs({
        indexJson,
        sessionMarkdown: new Map([['costed-legacy.md', markdown]]),
      }) as any,
    });

    const result = await new DefaultTranscriptExportService(deps).export({
      kind: 'frozen',
      sessionId: 'sess-costed-legacy',
    });
    const files = unzipSync(await collectChunks(result.chunks));
    const doc = JSON.parse(strFromU8(files['transcript.json']!));
    expect(doc.session.createdAt).toBe('1970-01-01T00:00:01.000Z');
    expect(doc.session.updatedAt).toBe('1970-01-01T00:00:02.000Z');
  });

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

    expect(doc.session.completeness.status).toBe('partial');

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

  it('exports a legacy entry with no sessionId using filename as the selector id', async () => {
    const markdown = makeArchiveMarkdown('Legacy No SessionId', [
      { role: 'user', content: 'legacy message' },
    ]);

    const indexJson = JSON.stringify([
      {
        filename: 'legacy-no-sid.md',
        title: 'Legacy No SessionId',
        frozenAt: '2024-01-01T00:00:00.000Z',
        messageCount: 1,
      },
    ]);

    const vfs = makeVfs({
      indexJson,
      sessionMarkdown: new Map([['legacy-no-sid.md', markdown]]),
    });

    const deps = makeDeps({ snapshotStore: makeEmptySnapshotStore(), vfs: vfs as any });
    const svc = new DefaultTranscriptExportService(deps);

    const result = await svc.export({ kind: 'frozen', sessionId: 'legacy-no-sid.md' });
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));

    expect(doc.session.state).toBe('frozen');
    expect(doc.session.completeness.status).toBe('partial');
    expect(doc.session.completeness.missing).toContain('complete-snapshot-unavailable');
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

    const docJson = strFromU8(files['transcript.json']!);
    expect(docJson).toContain('⟦REDACTED:');
    expect(docJson).not.toContain('ghp_ABC123456789012345678901234567890123456');
    void doc;
  });
});

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

  it('scopes the snapshot to the named root, leaving a sibling cone out (#2272)', async () => {
    const snapshotStore = makeEmptySnapshotStore();
    const collection: TranscriptCollectionDeps = {
      ...makeCollectionDeps(),
      listScoops: vi.fn(
        () =>
          [
            { jid: 'jid-cone', isCone: true, name: 'Sliccy', folder: 'cone', parentJid: null },
            { jid: 'jid-scoop-a', isCone: false, name: 'A', folder: 'a', parentJid: 'jid-cone' },
            {
              jid: 'jid-cone-b',
              isCone: true,
              name: 'Research',
              folder: 'cone-research',
              parentJid: null,
            },
            { jid: 'jid-scoop-b', isCone: false, name: 'B', folder: 'b', parentJid: 'jid-cone-b' },
          ] as any
      ),
    };
    const svc = new DefaultTranscriptExportService(makeDeps({ snapshotStore, collection }));

    await svc.captureFrozen({
      sessionId: 'sess-freeze-scoped',
      title: 'Research chat',
      frozenAt: '2024-06-01T12:00:00.000Z',
      createdAt: 1_000,
      updatedAt: 2_000,
      rootJid: 'jid-cone-b',
    });

    const [, snapshot] = snapshotStore.write.mock.calls[0]!;
    expect(snapshot.document.conversations.map((c: { id: string }) => c.id)).toEqual([
      'jid-cone-b',
      'jid-scoop-b',
    ]);
  });

  it('writes NO snapshot when the named root vanished mid-freeze (#2272)', async () => {
    const snapshotStore = makeEmptySnapshotStore();
    const svc = new DefaultTranscriptExportService(makeDeps({ snapshotStore }));

    await svc.captureFrozen({
      sessionId: 'sess-freeze-gone',
      title: 'Gone',
      frozenAt: '2024-06-01T12:00:00.000Z',
      createdAt: 1_000,
      updatedAt: 2_000,
      rootJid: 'jid-vanished',
    });

    expect(snapshotStore.write).not.toHaveBeenCalled();
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

describe('DefaultTranscriptExportService — progress', () => {
  it('emits collecting BEFORE collection begins (not after)', async () => {
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
            collectionCalled = listScoopsMock.mock.calls.length > 0;
          }
        },
      }
    );
    expect(phases).toContain('collecting');

    expect(collectionCalled).toBe(false);
  });

  it('emits waiting-for-conversations before collecting', async () => {
    const deps = makeDeps();
    const svc = new DefaultTranscriptExportService(deps);
    const phases: TranscriptExportProgress['phase'][] = [];

    await svc.export({ kind: 'active' }, { onProgress: (p) => phases.push(p.phase) });

    const waitIdx = phases.indexOf('waiting-for-conversations');
    const collectIdx = phases.indexOf('collecting');

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

describe('DefaultTranscriptExportService — re-redaction metadata', () => {
  it('recomputes byteLength and sha256 after re-redacting stored text attachment', async () => {
    const storedDoc = makeTranscriptDocument();
    storedDoc.session.state = 'frozen';

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
    const textBytes = new TextEncoder().encode(originalText);
    const snapshot: SanitizedTranscriptSnapshot = {
      document: storedDoc,
      attachments: new Map([['attachments/att-0001.txt', textBytes]]),
    };

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

    expect(att.byteLength).toBe(expectedBytes.length);
    expect(att.byteLength).not.toBe(11);

    expect(att.sha256).toBe(expectedHash);
    expect(att.sha256).not.toBe('old-stale-hash-that-must-not-survive');

    const zipEntry = files['attachments/att-0001.txt']!;
    expect(zipEntry.byteLength).toBe(att.byteLength);
  });
});

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

    const teardown2 = registerTranscriptExportService(svc2);

    teardown1();
    expect(getTranscriptExportService()).toBe(svc2);

    teardown2();
  });

  it('throws session-not-found when no service is registered', () => {
    let teardown: (() => void) | null = null;
    try {
      getTranscriptExportService();
    } catch {}

    const tmp = new DefaultTranscriptExportService(makeDeps());
    teardown = registerTranscriptExportService(tmp);
    teardown();
    teardown = null;
    expect(() => getTranscriptExportService()).toThrow(TranscriptExportError);
  });
});

describe('DefaultTranscriptExportService — vfsReader wired for VFS path attachments', () => {
  function makeVfsWithFile(filePath: string, fileBytes: Uint8Array) {
    return {
      readFile: vi.fn(async (path: string, opts?: { encoding?: string }) => {
        if (path === '/sessions/index.json') return '[]';
        if (path === filePath) {
          if (opts?.encoding === 'binary') return fileBytes;
          return new TextDecoder().decode(fileBytes);
        }
        const err = Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        throw err;
      }),
      readDir: vi.fn(async () => []),
    };
  }

  function makeCollectionWithPathAttachment(filePath: string): TranscriptCollectionDeps {
    const base = makeCollectionDeps();

    (base.getAgentMessages as ReturnType<typeof vi.fn>).mockImplementation(() => [
      { role: 'user', content: 'see attached', timestamp: 1_000 } as any,
    ]);

    (base.loadUiChatSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'session-cone',
        messages: [
          {
            id: 'msg-path-1',
            role: 'user' as const,
            content: 'see attached',
            timestamp: 1_000,
            attachments: [
              {
                id: 'att-path-1',
                name: 'report.zip',
                mimeType: 'application/zip',
                size: 4,
                kind: 'file' as const,
                path: filePath,
              },
            ],
          },
        ],
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ] as any);
    return base;
  }

  it('buildActiveSnapshot resolves path-only file attachment via vfs.readFile', async () => {
    const filePath = '/tmp/report.zip';
    const fileBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    const vfs = makeVfsWithFile(filePath, fileBytes);
    const collection = makeCollectionWithPathAttachment(filePath);
    const deps = makeDeps({ vfs: vfs as any, collection });
    const svc = new DefaultTranscriptExportService(deps);

    const result = await svc.export({ kind: 'active' });
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);

    const attKey = Object.keys(files).find((k) => k.startsWith('attachments/'));
    expect(attKey).toBeDefined();
    expect(Array.from(files[attKey!]!)).toEqual(Array.from(fileBytes));

    const calls = (vfs.readFile as ReturnType<typeof vi.fn>).mock.calls;
    const binaryCall = calls.find(
      (c: unknown[]) =>
        c[0] === filePath && (c[1] as { encoding?: string } | undefined)?.encoding === 'binary'
    );
    expect(binaryCall).toBeDefined();

    const doc = JSON.parse(strFromU8(files['transcript.json']!));
    const att = doc.attachments.find((a: { path: string }) => a.path?.startsWith('attachments/'));
    expect(att).toBeDefined();
    expect(att.present).toBe(true);
    expect(att.byteLength).toBe(fileBytes.length);
  });

  it('captureFrozen resolves path-only file attachment via vfs.readFile', async () => {
    const filePath = '/tmp/frozen-report.zip';
    const fileBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

    const vfs = makeVfsWithFile(filePath, fileBytes);
    const collection = makeCollectionWithPathAttachment(filePath);
    const snapshotStore = makeEmptySnapshotStore();
    const deps = makeDeps({ vfs: vfs as any, collection, snapshotStore });
    const svc = new DefaultTranscriptExportService(deps);

    await svc.captureFrozen({
      sessionId: 'sess-frozen-vfs',
      title: 'VFS Frozen',
      frozenAt: '2024-06-01T12:00:00.000Z',
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    expect(snapshotStore.write).toHaveBeenCalledOnce();
    const [, snapshot] = (snapshotStore.write as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const attPath = [...snapshot.attachments.keys()].find((k: string) =>
      k.startsWith('attachments/')
    );
    expect(attPath).toBeDefined();
    expect(Array.from(snapshot.attachments.get(attPath)!)).toEqual(Array.from(fileBytes));

    const att = snapshot.document.attachments.find((a: { path: string }) =>
      a.path?.startsWith('attachments/')
    );
    expect(att).toBeDefined();
    expect(att.present).toBe(true);
    expect(att.byteLength).toBe(fileBytes.length);
  });

  it('export produces partial when vfs.readFile throws for path-only attachment', async () => {
    const filePath = '/tmp/missing.zip';
    const vfs = makeVfs();

    const base = makeCollectionDeps();

    (base.getAgentMessages as ReturnType<typeof vi.fn>).mockImplementation(() => [
      { role: 'user', content: 'see attached', timestamp: 1_000 } as any,
    ]);
    (base.loadUiChatSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'session-cone',
        messages: [
          {
            id: 'msg-m',
            role: 'user' as const,
            content: 'see attached',
            timestamp: 1_000,
            attachments: [
              {
                id: 'att-m',
                name: 'missing.zip',
                mimeType: 'application/zip',
                size: 0,
                kind: 'file' as const,
                path: filePath,
              },
            ],
          },
        ],
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ] as any);

    const deps = makeDeps({ vfs: vfs as any, collection: base });
    const svc = new DefaultTranscriptExportService(deps);
    const result = await svc.export({ kind: 'active' });
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    const doc = JSON.parse(strFromU8(files['transcript.json']!));

    expect(doc.session.completeness.status).toBe('partial');
    expect(doc.session.completeness.missing).toContain('attachment-file-missing');

    const att = doc.attachments[0];
    expect(att).toBeDefined();
    expect(att.present).toBe(false);
    expect(att.missingReason).toBe('attachment-file-missing');
  });
});
