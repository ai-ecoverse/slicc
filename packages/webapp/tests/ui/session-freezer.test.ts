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
  freezeConeSession,
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

    // Memory append landed in /shared/CLAUDE.md with a dated heading.
    const memoryDoc = vfs.files.get('/shared/CLAUDE.md');
    expect(memoryDoc).toBeTruthy();
    expect(memoryDoc).toMatch(/Auto-extracted.*new-session/);
    expect(memoryDoc).toContain('user prefers vim');
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
