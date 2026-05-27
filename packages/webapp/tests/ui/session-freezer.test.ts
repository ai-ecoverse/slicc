import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, ChatMessage } from '../../src/ui/types.js';

const mockRunOneOffCompactionCall = vi.fn();
vi.mock('../../src/core/context-compaction.js', () => ({
  COMPACTION_MEMORY_INSTRUCTION: 'MEMORY',
  COMPACTION_TITLE_INSTRUCTION: 'TITLE',
  runOneOffCompactionCall: (...args: unknown[]) => mockRunOneOffCompactionCall(...args),
}));

// chat-panel imports a wide chunk (incl. SessionStore via indexeddb shims) at
// module load — the freezer only needs `formatChatForClipboard`. Stub it to a
// minimal markdown renderer so the freezer's `.md` output is testable without
// pulling the entire chat-panel surface into the test environment.
vi.mock('../../src/ui/chat-panel.js', () => ({
  formatChatForClipboard: (messages: { role: string; content: string }[]) =>
    messages
      .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.content}\n\n`)
      .join(''),
}));

import {
  enrichPendingSession,
  freezeConeSession,
  listPendingEnrichments,
  parseFrozenArchive,
  readSessionsIndex,
} from '../../src/ui/session-freezer.js';
import type { SessionStore } from '../../src/ui/session-store.js';

/**
 * Minimal VirtualFS double — just the subset the freezer touches. Backed by
 * a Map so we can introspect what was written without spinning up an
 * indexed-DB harness.
 */
function makeFakeVfs() {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        (err as unknown as { code: string }).code = 'ENOENT';
        throw err;
      }
      return files.get(path)!;
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async mkdir(_path: string, _opts?: unknown): Promise<void> {
      // no-op
    },
    async flush(): Promise<void> {
      // no-op
    },
    async rm(path: string, _opts?: unknown): Promise<void> {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        (err as unknown as { code: string }).code = 'ENOENT';
        throw err;
      }
      files.delete(path);
    },
  };
}

function makeFakeStore(session: Session | null) {
  return {
    async load(): Promise<Session | null> {
      return session;
    },
  } as unknown as SessionStore;
}

function userMessage(content: string): ChatMessage {
  return { id: crypto.randomUUID(), role: 'user', content, timestamp: 1 };
}
function assistantMessage(content: string): ChatMessage {
  return { id: crypto.randomUUID(), role: 'assistant', content, timestamp: 2 };
}

const fakeModel = { id: 'test-model', provider: 'anthropic' } as unknown as Parameters<
  typeof freezeConeSession
>[0]['model'];

describe('freezeConeSession', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
  });

  it('skips when session is below MIN_MESSAGES_TO_FREEZE', async () => {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('hi'), assistantMessage('hello')],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();
    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });
    expect(result).toBeNull();
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
    expect(vfs.files.size).toBe(0);
  });

  it('writes archive + index and appends memory on a long session', async () => {
    // Two LLM calls in order: memory bullets, then title.
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- user prefers vim\n- project uses ESM')
      .mockResolvedValueOnce('Fixing the auth bug');

    const messages: ChatMessage[] = [
      userMessage('q1'),
      assistantMessage('a1'),
      userMessage('q2'),
      assistantMessage('a2'),
    ];
    const store = makeFakeStore({
      id: 'session-cone',
      messages,
      createdAt: 100,
      updatedAt: 200,
    });
    const vfs = makeFakeVfs();

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Fixing the auth bug');
    expect(result!.messageCount).toBe(4);

    // Archive file landed under /sessions/, named with the slugified title.
    // Format: markdown with a YAML-style header.
    const archivePath = `/sessions/${result!.filename}`;
    expect(vfs.files.has(archivePath)).toBe(true);
    expect(result!.filename).toMatch(/fixing-the-auth-bug\.md$/);
    const archiveContent = vfs.files.get(archivePath)!;
    expect(archiveContent).toMatch(/^---\n/);
    expect(archiveContent).toContain('title: "Fixing the auth bug"');
    expect(archiveContent).toContain('messageCount: 4');
    expect(archiveContent).toContain('# Fixing the auth bug');
    expect(archiveContent).toContain('## User');
    expect(archiveContent).toContain('## Assistant');

    // Index updated with the new entry first.
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].title).toBe('Fixing the auth bug');

    // Memory append landed in /workspace/CLAUDE.md with a dated heading.
    const memoryDoc = vfs.files.get('/workspace/CLAUDE.md');
    expect(memoryDoc).toBeTruthy();
    expect(memoryDoc).toMatch(/Auto-extracted.*new-session/);
    expect(memoryDoc).toContain('user prefers vim');
    // /shared/CLAUDE.md is not touched by the freezer anymore.
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();
  });

  it('skips memory append when LLM returns NONE', async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('NONE').mockResolvedValueOnce('Quick chat');

    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();

    await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();
  });

  it('uses heuristic title when title LLM call fails', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- memory bullet')
      .mockRejectedValueOnce(new Error('rate limited'));

    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('help me debug the build pipeline'),
        assistantMessage('sure'),
        userMessage('here is the error'),
        assistantMessage('looking now'),
      ],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    expect(result).not.toBeNull();
    // Heuristic title falls back to first user message, truncated.
    expect(result!.title).toContain('help me debug');
  });

  it('still archives without an API key (no LLM calls, heuristic title)', async () => {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('plan the migration'),
        assistantMessage('ok'),
        userMessage('go'),
        assistantMessage('done'),
      ],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: undefined,
    });

    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.title).toContain('plan the migration');
    // Archive still landed.
    const archivePath = `/sessions/${result!.filename}`;
    expect(vfs.files.has(archivePath)).toBe(true);
  });

  it('prepends new entry to existing /sessions/index.json', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Second session');

    const vfs = makeFakeVfs();
    vfs.files.set(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: 'older.json',
          title: 'First session',
          frozenAt: '2026-01-01T00:00:00Z',
          messageCount: 4,
        },
      ])
    );
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('q'), assistantMessage('a'), userMessage('r'), assistantMessage('b')],
      createdAt: 0,
      updatedAt: 1,
    });

    await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(2);
    expect(index[0].title).toBe('Second session');
    expect(index[1].title).toBe('First session');
  });
});

describe('parseFrozenArchive', () => {
  it('round-trips title + user/assistant messages from a freezer-shaped archive', () => {
    const md = [
      '---',
      'id: session-cone',
      'title: "Auth bug investigation"',
      'frozenAt: 2026-05-13T19:00:00.000Z',
      'createdAt: 100',
      'updatedAt: 200',
      'messageCount: 3',
      '---',
      '',
      '# Auth bug investigation',
      '',
      '## User',
      'why is the token rotating every minute',
      '',
      '## Assistant',
      'checking the refresh window now',
      '',
      '## User',
      'thanks',
      '',
    ].join('\n');
    const { title, messages } = parseFrozenArchive(md);
    expect(title).toBe('Auth bug investigation');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'why is the token rotating every minute',
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'checking the refresh window now',
    });
    expect(messages[2]).toMatchObject({ role: 'user', content: 'thanks' });
  });

  it('folds nested ### Tool: blocks into the owning assistant message', () => {
    const md = [
      '---',
      'title: "tool run"',
      '---',
      '',
      '# tool run',
      '',
      '## User',
      'run ls',
      '',
      '## Assistant',
      'sure',
      '',
      '### Tool: bash',
      'Input: { "command": "ls" }',
      'Result: file1\nfile2',
      '',
    ].join('\n');
    const { messages } = parseFrozenArchive(md);
    expect(messages).toHaveLength(2);
    // The tool block is folded into the assistant's content verbatim.
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('### Tool: bash');
    expect(messages[1].content).toContain('"command": "ls"');
  });

  it('returns empty messages and Untitled when nothing matches', () => {
    expect(parseFrozenArchive('no headings here at all')).toEqual({
      title: 'Untitled',
      messages: [],
    });
  });

  it('prefers the embedded structured-data block over the markdown body', () => {
    // The data block carries the truth (toolCalls, timestamps, source);
    // the visible body below is just human-readable garnish and may be
    // less detailed. Parser must trust the data block when present.
    const data = JSON.stringify([
      {
        id: 'm1',
        role: 'user',
        content: 'run ls',
        timestamp: 100,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'sure',
        timestamp: 200,
        toolCalls: [{ id: 't1', name: 'bash', input: { command: 'ls' }, result: 'file1\nfile2' }],
      },
    ]);
    const md = [
      '---',
      'title: "tool run"',
      '---',
      '',
      '<!-- slicc:session-data',
      data,
      '-->',
      '',
      '# tool run',
      '',
      '## User',
      'run ls',
      '',
      '## Assistant',
      'sure',
      '',
      '### Tool: bash',
      'Input: { "command": "ls" }',
      'Result: file1\nfile2',
      '',
    ].join('\n');
    const { title, messages } = parseFrozenArchive(md);
    expect(title).toBe('tool run');
    expect(messages).toHaveLength(2);
    expect(messages[0].timestamp).toBe(100);
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls![0]).toMatchObject({
      id: 't1',
      name: 'bash',
      input: { command: 'ls' },
      result: 'file1\nfile2',
    });
  });

  it('preserves embedded quotes in the title via JSON-encoded frontmatter', () => {
    // The writer emits `title: ${JSON.stringify(value)}`, so a title like
    // `Debug "Auth" bug` round-trips as `title: "Debug \"Auth\" bug"`.
    // The reader must parse the value as JSON when it starts with a
    // quote so internal escapes survive — otherwise the regex stops at
    // the first `"` and reopens the session with a truncated header.
    const md = [
      '---',
      'id: session-cone',
      `title: ${JSON.stringify('Debug "Auth" bug — with backslash \\ too')}`,
      'frozenAt: 2026-05-13T19:00:00.000Z',
      '---',
      '',
      '## User',
      'hello',
      '',
    ].join('\n');
    const { title } = parseFrozenArchive(md);
    expect(title).toBe('Debug "Auth" bug — with backslash \\ too');
  });

  it('falls back to text parsing when the data block is malformed', () => {
    const md = [
      '---',
      'title: "broken"',
      '---',
      '',
      '<!-- slicc:session-data',
      '{not valid json',
      '-->',
      '',
      '## User',
      'hi',
      '',
      '## Assistant',
      'hello',
      '',
    ].join('\n');
    const { title, messages } = parseFrozenArchive(md);
    expect(title).toBe('broken');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('hi');
    expect(messages[1].content).toBe('hello');
  });
});

describe('freezeConeSession quick mode', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
  });

  it('writes a pending-named archive and pendingEnrichment index entry without LLM calls', async () => {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('refactor the auth flow'),
        assistantMessage('a'),
        userMessage('b'),
        assistantMessage('c'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });
    const vfs = makeFakeVfs();

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      mode: 'quick',
    });

    expect(result).not.toBeNull();
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
    expect(result!.pendingEnrichment).toBe(true);
    // Synthetic filename — `pending-<short-id>.md` shape.
    expect(result!.filename).toMatch(/^pending-[a-z0-9-]+\.md$/);
    // Heuristic title only — first user message, lightly truncated.
    expect(result!.title).toContain('refactor the auth flow');

    // Archive landed under /sessions/.
    expect(vfs.files.has(`/sessions/${result!.filename}`)).toBe(true);
    // No memory append in quick mode.
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();

    // Index entry carries the pendingEnrichment flag for the boot scanner.
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].pendingEnrichment).toBe(true);
    expect(index[0].filename).toBe(result!.filename);
  });
});

describe('listPendingEnrichments', () => {
  it('returns [] when the index is missing', async () => {
    const vfs = makeFakeVfs();
    const out = await listPendingEnrichments(
      vfs as unknown as Parameters<typeof listPendingEnrichments>[0]
    );
    expect(out).toEqual([]);
  });

  it('returns [] when the index is malformed', async () => {
    const vfs = makeFakeVfs();
    vfs.files.set('/sessions/index.json', '{not json');
    const out = await listPendingEnrichments(
      vfs as unknown as Parameters<typeof listPendingEnrichments>[0]
    );
    expect(out).toEqual([]);
  });

  it('returns only the pendingEnrichment=true subset of the index', async () => {
    const vfs = makeFakeVfs();
    vfs.files.set(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: 'pending-abc.md',
          title: 'rough',
          frozenAt: '2026-05-13T19:00:00.000Z',
          messageCount: 4,
          pendingEnrichment: true,
        },
        {
          filename: '2026-05-12T10-00-00-000Z-done.md',
          title: 'done',
          frozenAt: '2026-05-12T10:00:00.000Z',
          messageCount: 6,
        },
      ])
    );
    const out = await listPendingEnrichments(
      vfs as unknown as Parameters<typeof listPendingEnrichments>[0]
    );
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe('pending-abc.md');
    expect(out[0].pendingEnrichment).toBe(true);
  });
});

describe('enrichPendingSession', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
  });

  /** Build a fully-populated fake VFS with one quick-frozen pending entry. */
  async function seedPending(vfs: ReturnType<typeof makeFakeVfs>): Promise<{
    pendingFilename: string;
    frozenAt: string;
  }> {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('debug the build pipeline'),
        assistantMessage('looking'),
        userMessage('thanks'),
        assistantMessage('np'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });
    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      mode: 'quick',
    });
    return { pendingFilename: result!.filename, frozenAt: result!.frozenAt };
  }

  it('rewrites the title, renames the file, drops the pending flag, and appends memory', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    // Memory first, then title — same order the freezer uses.
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- prefers vitest\n- uses esm only')
      .mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(updated!.pendingEnrichment).toBeUndefined();
    expect(updated!.title).toBe('Build pipeline debug');
    expect(updated!.filename).toMatch(/build-pipeline-debug\.md$/);

    // Old pending file is gone, new file is present with the LLM title.
    expect(vfs.files.has(`/sessions/${pendingFilename}`)).toBe(false);
    const newContent = vfs.files.get(`/sessions/${updated!.filename}`);
    expect(newContent).toBeDefined();
    expect(newContent).toContain('title: "Build pipeline debug"');
    expect(newContent).toContain('# Build pipeline debug');

    // Memory landed under /workspace/CLAUDE.md with the pending-enrichment source tag.
    const memory = vfs.files.get('/workspace/CLAUDE.md');
    expect(memory).toBeTruthy();
    expect(memory).toMatch(/Auto-extracted.*pending-enrichment/);
    expect(memory).toContain('prefers vitest');
    // /shared/CLAUDE.md is no longer the auto-memory sink.
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();

    // Index now points to the renamed file and drops the pending flag.
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].filename).toBe(updated!.filename);
    expect(index[0].pendingEnrichment).toBeUndefined();
    expect(index[0].title).toBe('Build pipeline debug');
  });

  it('is a no-op when the archive file is missing (already renamed)', async () => {
    const vfs = makeFakeVfs();
    const result = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: 'pending-gone.md',
        title: 'phantom',
        frozenAt: '2026-05-13T19:00:00.000Z',
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );
    expect(result).toBeNull();
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
  });

  it('is a no-op when the entry is not flagged pendingEnrichment', async () => {
    const vfs = makeFakeVfs();
    // Even if the file exists, an entry without the flag must not be enriched.
    vfs.files.set('/sessions/foo.md', '---\ntitle: "foo"\n---\n\n# foo\n');
    const result = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: 'foo.md',
        title: 'foo',
        frozenAt: '2026-05-13T19:00:00.000Z',
        messageCount: 4,
      },
      { model: fakeModel!, apiKey: 'k' }
    );
    expect(result).toBeNull();
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
    // File untouched.
    expect(vfs.files.get('/sessions/foo.md')).toContain('# foo');
  });

  it('leaves the pending entry intact when the title LLM call fails', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    // Memory succeeds, title throws — pending entry must stay put and the
    // archive file must not be renamed or rewritten so the next boot can
    // retry from a clean slate.
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- bullet')
      .mockRejectedValueOnce(new Error('rate limited'));

    const result = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'heuristic title',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(result).toBeNull();
    // Pending file still on disk; no renamed file in its place.
    expect(vfs.files.has(`/sessions/${pendingFilename}`)).toBe(true);
    // No memory was appended either — we abort BEFORE the memory append
    // so retries don't accumulate duplicate bullets.
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();
    // Index unchanged — entry is still pending so the next boot retries.
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].pendingEnrichment).toBe(true);
    expect(index[0].filename).toBe(pendingFilename);
  });

  it('warns (not infos) and stays pending when archive read fails with a non-ENOENT error', async () => {
    // ENOENT means "already renamed" → info. Any other error is a real
    // failure (permission, IO, etc.) and must surface as warn so it
    // doesn't get hidden behind the misleading "already enriched" line.
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    const archivePath = `/sessions/${pendingFilename}`;
    const originalRead = vfs.readFile.bind(vfs);
    vfs.readFile = async (path: string) => {
      if (path === archivePath) {
        const err = new Error('EACCES: permission denied') as Error & { code: string };
        err.code = 'EACCES';
        throw err;
      }
      return originalRead(path);
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'heuristic',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(result).toBeNull();
    // The warn must mention the actual failure, not "already enriched".
    // The logger forwards the data object as a trailing arg, so serialize
    // each arg explicitly rather than relying on default toString.
    const stringifyArgs = (args: unknown[]): string =>
      args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
    const warnCalls = warnSpy.mock.calls.map((c) => stringifyArgs(c));
    expect(warnCalls.some((s) => s.includes('Failed to read pending archive'))).toBe(true);
    expect(warnCalls.some((s) => s.includes('EACCES'))).toBe(true);
    const infoCalls = infoSpy.mock.calls.map((c) => stringifyArgs(c));
    expect(infoCalls.some((s) => s.includes('already enriched'))).toBe(false);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
  });

  it('does not duplicate the canonical row when it already exists in the index', async () => {
    // Regression for PR #718 review: when `oldFilename` is missing from
    // the index but a row with the same `replacement.filename` is
    // already there, the old code prepended a second copy. The fix
    // dedupes by filename before prepending.
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Canonical title');

    const canonicalFilename = `${frozenAt.replace(/[:.]/g, '-')}-canonical-title.md`;

    // Replace the index with one whose `pendingFilename` row is missing
    // (so `findIndex` returns -1 inside `replaceIndexEntry`) but the
    // canonical row already exists. Pre-seed an extra unrelated row so
    // we can verify only the canonical duplicate is collapsed.
    vfs.files.set(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: canonicalFilename,
          title: 'Stale canonical',
          frozenAt,
          messageCount: 4,
        },
        {
          filename: 'unrelated.md',
          title: 'Unrelated',
          frozenAt: '2020-01-01T00:00:00.000Z',
          messageCount: 2,
        },
      ])
    );

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'heuristic',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(updated!.filename).toBe(canonicalFilename);

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    // Exactly one canonical row + the unrelated row — no duplicate.
    const canonicalRows = index.filter((e) => e.filename === canonicalFilename);
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0].title).toBe('Canonical title');
    expect(index.some((e) => e.filename === 'unrelated.md')).toBe(true);
  });

  it('serializes concurrent enrichments so both replacements land in the index', async () => {
    // Without the in-module promise-chain mutex, two parallel
    // read-modify-write updates to /sessions/index.json would race and
    // one of the new entries would be lost.
    const vfs = makeFakeVfs();

    // Seed two distinct pending entries with different frozenAt times
    // so the renamed filenames don't collide.
    const seedOne = async (utcSecond: number): Promise<{ filename: string; frozenAt: string }> => {
      const fixedNow = Date.UTC(2026, 4, 13, 19, 0, utcSecond);
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      try {
        const store = makeFakeStore({
          id: `session-${utcSecond}`,
          messages: [
            userMessage(`q ${utcSecond}`),
            assistantMessage(`a ${utcSecond}`),
            userMessage(`r ${utcSecond}`),
            assistantMessage(`b ${utcSecond}`),
          ],
          createdAt: 0,
          updatedAt: 1,
        });
        const r = await freezeConeSession({
          sessionStore: store,
          vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
          model: fakeModel,
          apiKey: 'k',
          mode: 'quick',
        });
        return { filename: r!.filename, frozenAt: r!.frozenAt };
      } finally {
        dateSpy.mockRestore();
      }
    };

    const a = await seedOne(10);
    const b = await seedOne(20);

    // Both enrichments produce the same title (slug `t`) but different
    // canonical filenames thanks to distinct frozenAt prefixes.
    mockRunOneOffCompactionCall.mockImplementation(
      async (opts: { instruction: string }): Promise<string> => {
        if (opts.instruction === 'MEMORY') return 'NONE';
        if (opts.instruction === 'TITLE') return 'T';
        return '';
      }
    );

    const [resA, resB] = await Promise.all([
      enrichPendingSession(
        vfs as unknown as Parameters<typeof enrichPendingSession>[0],
        {
          filename: a.filename,
          title: 'h',
          frozenAt: a.frozenAt,
          messageCount: 4,
          pendingEnrichment: true,
        },
        { model: fakeModel!, apiKey: 'k' }
      ),
      enrichPendingSession(
        vfs as unknown as Parameters<typeof enrichPendingSession>[0],
        {
          filename: b.filename,
          title: 'h',
          frozenAt: b.frozenAt,
          messageCount: 4,
          pendingEnrichment: true,
        },
        { model: fakeModel!, apiKey: 'k' }
      ),
    ]);

    expect(resA).not.toBeNull();
    expect(resB).not.toBeNull();

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    const filenames = index.map((e) => e.filename);
    // Both renamed entries must be present — neither was clobbered by the
    // other's read-modify-write.
    expect(filenames).toContain(resA!.filename);
    expect(filenames).toContain(resB!.filename);
  });
});
