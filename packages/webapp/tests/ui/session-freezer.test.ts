import 'fake-indexeddb/auto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { Bridge } from '../../src/kernel/facade.js';
import { resetNewSessionTmp } from '../../src/ui/new-session.js';
import type { ChatMessage, Session } from '../../src/ui/types.js';

const mockRunOneOffCompactionCall = vi.fn();
vi.mock('../../src/core/context-compaction.js', () => ({
  COMPACTION_MEMORY_INSTRUCTION: 'MEMORY',
  COMPACTION_TITLE_INSTRUCTION: 'TITLE',
  runOneOffCompactionCall: (...args: unknown[]) => mockRunOneOffCompactionCall(...args),
}));

const mockRunAgenticMemoryPass = vi.fn();
vi.mock('../../src/scoops/agentic-memory.js', () => ({
  runAgenticMemoryPass: (...args: unknown[]) => mockRunAgenticMemoryPass(...args),

  curatorReceiptPath: (sessionArchivePath: string) =>
    `/sessions/.curated/${sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1)}`,

  curationBasePath: (sessionArchivePath: string) =>
    `/sessions/.curation/${sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1)}/base.md`,
  curationDraftPath: (sessionArchivePath: string) =>
    `/sessions/.curation/${sessionArchivePath.slice(sessionArchivePath.lastIndexOf('/') + 1)}/draft.md`,
}));

const { mockApplyConeMemoryBudget, mockReadSessionCount } = vi.hoisted(() => ({
  mockApplyConeMemoryBudget: vi.fn(async (..._args: unknown[]) => ({
    restructured: false,
    reason: 'no-llm' as const,
  })),
  mockReadSessionCount: vi.fn(async (..._args: unknown[]) => 1),
}));
vi.mock('../../src/scoops/cone-memory-budget.js', () => ({
  applyConeMemoryBudget: (...args: unknown[]) => mockApplyConeMemoryBudget(...args),
  readSessionCount: (...args: unknown[]) => mockReadSessionCount(...args),

  CONE_MEMORY_PATH: '/workspace/CLAUDE.md',
}));

vi.mock('../../src/ui/chat-panel.js', () => ({
  formatChatForClipboard: (messages: { role: string; content: string }[]) =>
    messages
      .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.content}\n\n`)
      .join(''),
}));

import type { SessionStore } from '../../src/scoops/chat-session-store.js';
import { applyDictationMarkers } from '../../src/speech/dictation-priming.js';
import {
  curateFrozenSessionMemories,
  enrichPendingSession,
  type FrozenSessionIndexEntry,
  freezeConeSession,
  listPendingEnrichments,
  markSnapshotUnavailable,
  parseFrozenArchive,
  processPendingSessions,
  readSessionsIndex,
  SESSIONS_INDEX_PATH,
} from '../../src/ui/session-freezer.js';

function makeFakeVfs() {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  return {
    files,

    mtimes,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return files.get(path)!;
    },
    async stat(
      path: string
    ): Promise<{ type: string; size: number; mtime: number; ctime: number }> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return {
        type: 'file',
        size: files.get(path)!.length,
        mtime: mtimes.get(path) ?? 0,
        ctime: 0,
      };
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async mkdir(_path: string, _opts?: unknown): Promise<void> {},
    async flush(): Promise<void> {},
    async rm(path: string, _opts?: unknown): Promise<void> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
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

type ChatUsage = NonNullable<ChatMessage['usage']>;

function assistantAgentMessage(content: string, model: string, usage: ChatUsage): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model,
    usage: {
      ...usage,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AgentMessage;
}

async function produceLiveAssistantMessages(
  turns: Array<{ content: string; model: string; usage: ChatUsage }>
): Promise<ChatMessage[]> {
  const canonical: AgentMessage[] = [];
  const bridge = new Bridge({
    onMessage: () => () => {},
    send: () => {},
  });
  const scoop = { jid: 'cone-jid', name: 'cone', folder: 'cone', isCone: true };
  const orchestrator = {
    getScoops: () => [scoop],
    getScoopContext: () => ({ getAgentMessages: () => canonical }),
  } as unknown as Parameters<typeof bridge.bind>[0];
  await bridge.bind(orchestrator);
  const callbacks = Bridge.createCallbacks(bridge);
  for (const turn of turns) {
    canonical.push(assistantAgentMessage(turn.content, turn.model, turn.usage));
    callbacks.onResponse(scoop.jid, turn.content, false);
    callbacks.onResponseDone(scoop.jid);
  }
  return bridge.getMessagesForJid(scoop.jid);
}

const fakeModel = { id: 'test-model', provider: 'anthropic' } as unknown as Parameters<
  typeof freezeConeSession
>[0]['model'];

describe('freezeConeSession', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockRunAgenticMemoryPass.mockReset();
    mockApplyConeMemoryBudget.mockReset();
    mockReadSessionCount.mockReset().mockResolvedValue(1);
    mockApplyConeMemoryBudget.mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
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

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].title).toBe('Fixing the auth bug');

    const memoryDoc = vfs.files.get('/workspace/CLAUDE.md');
    expect(memoryDoc).toBeTruthy();
    expect(memoryDoc).toMatch(/Auto-extracted.*new-session/);
    expect(memoryDoc).toContain('user prefers vim');

    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();
  });

  it("memory: 'skip' freezes without any memory call and marks the archive memorySkipped (#2272)", async () => {
    const store = makeFakeStore({
      id: 'session-cone-research',
      messages: [
        userMessage('q1'),
        assistantMessage('a1'),
        userMessage('q2'),
        assistantMessage('a2'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });
    const vfs = makeFakeVfs();
    const spawn = vi.fn();

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      mode: 'quick',
      memory: 'skip',

      agenticMemorySpawn: spawn as never,
      cone: { folder: 'cone-research', label: 'Research' },
    });

    expect(result).not.toBeNull();
    expect(result!.memorySkipped).toBe(true);
    expect(result!.memoryPending).toBeUndefined();
    expect(result!.pendingEnrichment).toBe(true);
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0]).toMatchObject({ memorySkipped: true, cone: 'cone-research' });
    expect(index[0].memoryPending).toBeUndefined();

    const archive = vfs.files.get(`/sessions/${index[0].filename}`);
    expect(String(archive)).toContain('memorySkipped: true');
  });

  it('writes memoryPending before the agentic pass and clears it on success', async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('Agentic memory session');
    const vfs = makeFakeVfs();
    const spawn = vi.fn(async () => ({ finalText: 'done', exitCode: 0 }));
    mockRunAgenticMemoryPass.mockImplementationOnce(async (options) => {
      expect(vfs.files.has(options.sessionArchivePath)).toBe(true);
      expect(options.sessionCount).toBe(1);
      await options.spawn({} as never);
      return { ok: true };
    });

    const options = {
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon: async () => null,
      agenticMemorySpawn: spawn,
    };
    const frozen = await freezeConeSession(options);

    expect(frozen).not.toBeNull();
    expect(frozen?.memoryPending).toBe(true);
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
    expect((await readSessionsIndex(vfs as never))[0].memoryPending).toBe(true);

    const updated = await curateFrozenSessionMemories(options, frozen!);

    expect(updated?.memoryPending).toBeUndefined();
    expect(frozen?.memoryPending).toBeUndefined();
    const [entry] = await readSessionsIndex(vfs as never);
    expect(entry.memoryPending).toBeUndefined();

    expect(entry.memoryCuratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated?.memoryCuratedAt).toBe(entry.memoryCuratedAt);
    expect(mockRunAgenticMemoryPass).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledOnce();
    expect(mockRunOneOffCompactionCall.mock.calls[0][0].instruction).toBe('TITLE');
    expect(mockApplyConeMemoryBudget).not.toHaveBeenCalled();
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
  });

  it("runs the curator for the cone that was frozen, on that cone's memory file (#2271)", async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('Beta cone session');
    const vfs = makeFakeVfs();
    mockRunAgenticMemoryPass.mockResolvedValueOnce({ ok: true, report: 'curated' });

    const options = {
      sessionStore: makeFakeStore({
        id: 'session-cone-beta',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon: async () => null,
      agenticMemorySpawn: vi.fn(),
      cone: { folder: 'cone-beta', label: 'Beta', jid: 'cone_beta' },
    };
    const frozen = await freezeConeSession(options);
    await curateFrozenSessionMemories(options, frozen!);

    expect(mockRunAgenticMemoryPass).toHaveBeenCalledOnce();
    expect(mockRunAgenticMemoryPass.mock.calls[0][0]).toMatchObject({
      sessionArchivePath: `/sessions/${frozen!.filename}`,
      cone: { folder: 'cone-beta', jid: 'cone_beta' },
    });

    expect(vfs.files.get('/cones/cone-beta/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
  });

  it("appends an extra cone's legacy-extracted memory to ITS OWN CLAUDE.md (#2271)", async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- beta learned something')
      .mockResolvedValueOnce('Beta session');
    const vfs = makeFakeVfs();

    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone-beta',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon: async () => null,
      cone: { folder: 'cone-beta', label: 'Beta' },
    });

    expect(frozen).not.toBeNull();
    expect(vfs.files.get('/cones/cone-beta/CLAUDE.md')).toContain('beta learned something');

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();

    expect(mockApplyConeMemoryBudget).toHaveBeenCalledOnce();
    expect(mockApplyConeMemoryBudget.mock.calls[0][0]).toMatchObject({
      memoryPath: '/cones/cone-beta/CLAUDE.md',
    });
  });

  it('falls back to legacy extraction and budgeting when the agentic pass fails', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('Agentic fallback session')
      .mockResolvedValueOnce('- durable fallback memory');
    mockRunAgenticMemoryPass.mockResolvedValueOnce({
      ok: false,
      reason: 'spawn failed',
      legacyFallbackSafe: true,
    });
    const vfs = makeFakeVfs();

    const options = {
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon: async () => null,
      agenticMemorySpawn: vi.fn(),
    };
    const frozen = await freezeConeSession(options);
    await curateFrozenSessionMemories(options, frozen!);

    expect(frozen).not.toBeNull();
    expect(mockRunOneOffCompactionCall.mock.calls.map(([arg]) => arg.instruction)).toEqual([
      'TITLE',
      'MEMORY',
    ]);
    expect(vfs.files.get('/workspace/CLAUDE.md')).toContain('durable fallback memory');
    expect(mockApplyConeMemoryBudget).toHaveBeenCalledOnce();
    expect(frozen?.memoryPending).toBe(true);
    const [failedEntry] = await readSessionsIndex(vfs as never);
    expect(failedEntry.memoryPending).toBe(true);

    expect(failedEntry.memoryFailed).toBe('spawn failed');
    expect(failedEntry.memoryCuratedAt).toBeUndefined();
  });

  it('retains persisted memoryPending when reload interrupts before curation', async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('Interrupted agentic session');
    const vfs = makeFakeVfs();
    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon: async () => null,
      agenticMemorySpawn: vi.fn(),
    });

    const filename = frozen!.filename;
    delete frozen!.memoryPending;
    const [reloaded] = await readSessionsIndex(vfs as never);

    expect(reloaded).not.toBe(frozen);
    expect(reloaded).toMatchObject({ filename, memoryPending: true });
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
  });

  it('skips legacy extraction when the agentic pass times out', async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('Timed out agentic session');
    mockRunAgenticMemoryPass.mockResolvedValueOnce({
      ok: false,
      reason: 'timeout',
      legacyFallbackSafe: false,
    });
    const vfs = makeFakeVfs();

    const options = {
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon: async () => null,
      agenticMemorySpawn: vi.fn(),
    };
    const frozen = await freezeConeSession(options);
    await curateFrozenSessionMemories(options, frozen!);

    expect(frozen).not.toBeNull();
    expect(frozen?.memoryPending).toBe(true);
    const [timedOutEntry] = await readSessionsIndex(vfs as never);
    expect(timedOutEntry.memoryPending).toBe(true);
    expect(timedOutEntry.memoryFailed).toBe('timeout');
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledOnce();
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(mockApplyConeMemoryBudget).not.toHaveBeenCalled();
  });

  it('round-trips aggregate cost and per-model usage through the index and archive', async () => {
    const [first, second, third] = await produceLiveAssistantMessages([
      {
        content: 'first',
        model: 'model-a',
        usage: {
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 10,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.003,
            cacheWrite: 0.004,
            total: 0.037,
          },
        },
      },
      {
        content: 'second',
        model: 'model-a',
        usage: {
          input: 200,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        },
      },
      {
        content: 'third',
        model: 'model-b',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
        },
      },
    ]);
    const messages = [
      userMessage('measure this session'),
      first,
      userMessage('continue'),
      second,
      userMessage('switch models'),
      third,
    ];
    const vfs = makeFakeVfs();

    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages,
        createdAt: 100,
        updatedAt: 200,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });

    const expectedCost = {
      total: 0.28700000000000003,
      input: 0.13,
      output: 0.15000000000000002,
      cacheRead: 0.003,
      cacheWrite: 0.004,
    };
    const expectedModels = [
      { model: 'model-b', cost: 0.2, turns: 1, tokens: 15 },
      { model: 'model-a', cost: 0.087, turns: 2, tokens: 480 },
    ];
    expect(frozen?.cost).toEqual(expectedCost);
    expect(frozen?.models).toEqual(expectedModels);

    const [indexEntry] = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(indexEntry.cost).toEqual(expectedCost);
    expect(indexEntry.models).toEqual(expectedModels);

    const archiveContent = vfs.files.get(`/sessions/${frozen!.filename}`)!;
    expect(archiveContent).toContain(`cost: ${JSON.stringify(expectedCost)}`);
    expect(archiveContent).toContain(`models: ${JSON.stringify(expectedModels)}`);
    const parsed = parseFrozenArchive(archiveContent);
    expect(parsed.cost).toEqual(expectedCost);
    expect(parsed.models).toEqual(expectedModels);
  });

  it('omits cost metadata when assistant usage is unavailable', async () => {
    const vfs = makeFakeVfs();
    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });

    expect(frozen?.cost).toBeUndefined();
    expect(frozen?.models).toBeUndefined();
    const archiveContent = vfs.files.get(`/sessions/${frozen!.filename}`)!;
    expect(archiveContent).not.toMatch(/^cost:/m);
    expect(archiveContent).not.toMatch(/^models:/m);
  });

  it('keeps a restored legacy session unknown after a production-attributed turn', async () => {
    const [attributed] = await produceLiveAssistantMessages([
      {
        content: 'new attributed answer',
        model: 'model-a',
        usage: {
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 10,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
        },
      },
    ]);
    const vfs = makeFakeVfs();
    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('legacy question'),
          assistantMessage('legacy answer without accounting metadata'),
          userMessage('new question'),
          attributed,
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });

    expect(frozen?.cost).toBeUndefined();
    expect(frozen?.models).toBeUndefined();
    const [indexEntry] = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(indexEntry.cost).toBeUndefined();
    expect(indexEntry.models).toBeUndefined();
  });

  it('preserves existing /workspace/CLAUDE.md on a non-ENOENT read fault (never clobbers durable memory)', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- new bullet extracted this round')
      .mockResolvedValueOnce('Fixing the auth bug');

    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('q1'),
        assistantMessage('a1'),
        userMessage('q2'),
        assistantMessage('a2'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });

    const vfs = makeFakeVfs();
    const durable = '## Auto-extracted (2025-01-01, compaction)\n\n- long-standing preference\n';
    vfs.files.set('/workspace/CLAUDE.md', durable);

    const realReadFile = vfs.readFile.bind(vfs);
    vfs.readFile = async (path: string): Promise<string> => {
      if (path === '/workspace/CLAUDE.md') {
        throw new FsError('EIO', 'transient OPFS fault', path);
      }
      return realReadFile(path);
    };

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    expect(result).not.toBeNull();
    expect(vfs.files.has(`/sessions/${result!.filename}`)).toBe(true);

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBe(durable);
  });

  it('records the LLM-picked lucide icon in the index entry (full mode only)', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Fix the auth bug');
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('q1'),
        assistantMessage('a1'),
        userMessage('q2'),
        assistantMessage('a2'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });
    const vfs = makeFakeVfs();
    const pickIcon = vi.fn(async (_ctx: { subject: string }) => 'wrench');

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon,
    });
    expect(pickIcon).toHaveBeenCalledTimes(1);
    expect(pickIcon.mock.calls[0][0].subject).toContain('Fix the auth bug');
    expect(result!.icon).toBe('wrench');
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].icon).toBe('wrench');

    pickIcon.mockClear();
    const store2 = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('q1'),
        assistantMessage('a1'),
        userMessage('q2'),
        assistantMessage('a2'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });
    const r2 = await freezeConeSession({
      sessionStore: store2,
      vfs: makeFakeVfs() as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      pickIcon,
    });
    expect(pickIcon).not.toHaveBeenCalled();
    expect(r2!.icon).toBeUndefined();
  });

  it('drops a non-lucide picked name so the full-freeze entry records no icon', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Fix the auth bug');
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [
        userMessage('q1'),
        assistantMessage('a1'),
        userMessage('q2'),
        assistantMessage('a2'),
      ],
      createdAt: 100,
      updatedAt: 200,
    });
    const vfs = makeFakeVfs();
    const pickIcon = vi.fn(async (_ctx: { subject: string }) => 'not-a-real-icon');

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      pickIcon,
    });
    expect(pickIcon).toHaveBeenCalledTimes(1);
    expect(result!.icon).toBeUndefined();
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].icon).toBeUndefined();
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

  it('routes the post-append step through applyConeMemoryBudget with the caller credentials', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- bullet from freezer')
      .mockResolvedValueOnce('Freezer wired title');

    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('q'), assistantMessage('a'), userMessage('r'), assistantMessage('b')],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();

    await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'secret-key',
      headers: { 'X-Session-Id': 'sess-123' },
    });

    expect(mockApplyConeMemoryBudget).toHaveBeenCalledTimes(1);
    const call = mockApplyConeMemoryBudget.mock.calls[0][0] as {
      vfs: unknown;
      model: unknown;
      apiKey: string;
      headers?: Record<string, string>;
    };
    expect(call.vfs).toBe(vfs);
    expect(call.model).toBe(fakeModel);
    expect(call.apiKey).toBe('secret-key');
    expect(call.headers).toEqual({ 'X-Session-Id': 'sess-123' });
  });

  it('skips the budget step when no LLM credentials are wired (no throw, no call args mismatch)', async () => {
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

    await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: undefined,
    });

    expect(mockApplyConeMemoryBudget).not.toHaveBeenCalled();
  });

  it('swallows applyConeMemoryBudget failures (memory append still succeeds)', async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('- bullet').mockResolvedValueOnce('Title');
    mockApplyConeMemoryBudget.mockRejectedValueOnce(new Error('budget exploded'));

    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('q'), assistantMessage('a'), userMessage('r'), assistantMessage('b')],
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

    expect(vfs.files.get('/workspace/CLAUDE.md')).toContain('- bullet');

    expect(vfs.files.has(`/sessions/${result!.filename}`)).toBe(true);
  });

  it.each([
    ['Save', 'full'],
    ['Skip', 'quick'],
  ] as const)(
    'keeps a path-only /tmp attachment usable after %s cleanup',
    async (_action, mode) => {
      const vfs = await VirtualFS.create({
        dbName: `session-freezer-attachment-${mode}-${Math.random()}`,
        wipe: true,
      });
      const sourcePath = '/tmp/upload/demo.webm';
      const bytes = new Uint8Array([0, 255, 42, 7]);
      await vfs.mkdir('/tmp/upload', { recursive: true });
      await vfs.writeFile(sourcePath, bytes);
      await vfs.writeFile('/tmp/unrelated.txt', 'discard');
      const attached = userMessage('review this recording');
      attached.attachments = [
        {
          id: 'video-1',
          name: 'demo.webm',
          mimeType: 'video/webm',
          size: bytes.length,
          kind: 'file',
          path: sourcePath,
        },
      ];
      const store = makeFakeStore({
        id: 'session-cone',
        messages: [
          attached,
          assistantMessage('looking'),
          userMessage('any findings?'),
          assistantMessage('yes'),
        ],
        createdAt: 0,
        updatedAt: 1,
      });

      const frozen = await freezeConeSession({ sessionStore: store, vfs, mode });
      expect(frozen).not.toBeNull();

      await resetNewSessionTmp(vfs, '/tmp');

      const raw = await vfs.readTextFile(`/sessions/${frozen!.filename}`);
      const thawed = parseFrozenArchive(raw);
      const archivedPath = thawed.messages[0].attachments?.[0].path;
      expect(archivedPath).toMatch(/^\/sessions\/attachments\//);
      const archivedBytes = await vfs.readFile(archivedPath!, { encoding: 'binary' });
      expect(archivedBytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(archivedBytes as Uint8Array)).toEqual(Array.from(bytes));
      expect(await vfs.readDir('/tmp')).toEqual([]);
      await expect(vfs.stat('/tmp/unrelated.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it.each(['directory', 'file'] as const)(
    'does not follow a %s symlink in a referenced /tmp attachment path',
    async (symlinkAt) => {
      const vfs = await VirtualFS.create({
        dbName: `session-freezer-symlink-${symlinkAt}-${Math.random()}`,
        wipe: true,
      });
      await vfs.mkdir('/workspace/private', { recursive: true });
      await vfs.writeFile('/workspace/private/demo.bin', new Uint8Array([9, 8, 7]));
      await vfs.mkdir('/tmp', { recursive: true });
      const sourcePath = '/tmp/upload/demo.bin';
      if (symlinkAt === 'directory') {
        await vfs.symlink('/workspace/private', '/tmp/upload');
      } else {
        await vfs.mkdir('/tmp/upload', { recursive: true });
        await vfs.symlink('/workspace/private/demo.bin', sourcePath);
      }
      const attached = userMessage('archive this');
      attached.attachments = [
        {
          id: 'binary-1',
          name: 'demo.bin',
          mimeType: 'application/octet-stream',
          size: 3,
          kind: 'file',
          path: sourcePath,
        },
      ];
      const frozen = await freezeConeSession({
        sessionStore: makeFakeStore({
          id: 'session-cone',
          messages: [
            attached,
            assistantMessage('ok'),
            userMessage('new'),
            assistantMessage('done'),
          ],
          createdAt: 0,
          updatedAt: 1,
        }),
        vfs,
        mode: 'quick',
      });

      const raw = await vfs.readTextFile(`/sessions/${frozen!.filename}`);
      const archivedAttachment = parseFrozenArchive(raw).messages[0].attachments?.[0];
      expect(archivedAttachment?.path).toBeUndefined();
      expect(archivedAttachment?.error).toContain('missing or unsafe');
      await expect(vfs.readDir('/sessions/attachments')).rejects.toMatchObject({ code: 'ENOENT' });
      const privateBytes = await vfs.readFile('/workspace/private/demo.bin', {
        encoding: 'binary',
      });
      expect(Array.from(privateBytes as Uint8Array)).toEqual([9, 8, 7]);
    }
  );

  it('strips a missing path-only reference without copying inline attachments', async () => {
    const vfs = await VirtualFS.create({
      dbName: `session-freezer-missing-${Math.random()}`,
      wipe: true,
    });
    await vfs.mkdir('/tmp/upload', { recursive: true });
    await vfs.writeFile('/tmp/upload/inline.png', new Uint8Array([1, 2, 3]));
    const attached = userMessage('archive these');
    attached.attachments = [
      {
        id: 'missing-1',
        name: 'missing.zip',
        mimeType: 'application/zip',
        size: 10,
        kind: 'file',
        path: '/tmp/upload/missing.zip',
      },
      {
        id: 'inline-1',
        name: 'inline.png',
        mimeType: 'image/png',
        size: 3,
        kind: 'image',
        data: 'AQID',
        path: '/tmp/upload/inline.png',
      },
    ];
    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [attached, assistantMessage('ok'), userMessage('new'), assistantMessage('done')],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs,
      mode: 'quick',
    });

    const raw = await vfs.readTextFile(`/sessions/${frozen!.filename}`);
    const archivedAttachments = parseFrozenArchive(raw).messages[0].attachments!;
    expect(archivedAttachments[0].path).toBeUndefined();
    expect(archivedAttachments[0].error).toContain('missing or unsafe');
    expect(archivedAttachments[1]).toMatchObject({
      data: 'AQID',
      path: '/tmp/upload/inline.png',
    });
    await expect(vfs.readDir('/sessions/attachments')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['EIO', 'EACCES'] as const)(
    'preserves mixed attachments and messages when one attachment fails with %s',
    async (errorCode) => {
      const vfs = await VirtualFS.create({
        dbName: `session-freezer-read-error-${errorCode}-${Math.random()}`,
        wipe: true,
      });
      const readablePath = '/tmp/readable/notes.txt';
      const failingPath = '/tmp/restricted/private.bin';
      const readableBytes = new Uint8Array([4, 2, 1]);
      await vfs.mkdir('/tmp/readable', { recursive: true });
      await vfs.mkdir('/tmp/restricted', { recursive: true });
      await vfs.writeFile(readablePath, readableBytes);
      await vfs.writeFile(failingPath, new Uint8Array([9, 9, 9]));

      const originalReadFile = vfs.readFile.bind(vfs);
      const originalReadDir = vfs.readDir.bind(vfs);
      const failAttachmentRead = (): never => {
        const error = new Error('sensitive backend detail') as Error & { code: string };
        error.code = errorCode;
        throw error;
      };
      if (errorCode === 'EIO') {
        vfs.readFile = async (path, options) =>
          path === failingPath ? failAttachmentRead() : originalReadFile(path, options);
      } else {
        vfs.readDir = async (path) =>
          path === '/tmp/restricted' ? failAttachmentRead() : originalReadDir(path);
      }

      const attached = userMessage('archive both files');
      attached.attachments = [
        {
          id: 'readable-1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: readableBytes.length,
          kind: 'file',
          path: readablePath,
        },
        {
          id: 'failing-1',
          name: 'private.bin',
          mimeType: 'application/octet-stream',
          size: 3,
          kind: 'file',
          path: failingPath,
        },
      ];
      const frozen = await freezeConeSession({
        sessionStore: makeFakeStore({
          id: 'session-cone',
          messages: [
            attached,
            assistantMessage('first response'),
            userMessage('follow up'),
            assistantMessage('final response'),
          ],
          createdAt: 0,
          updatedAt: 1,
        }),
        vfs,
        mode: 'quick',
      });

      expect(frozen).not.toBeNull();
      vfs.readFile = originalReadFile;
      vfs.readDir = originalReadDir;
      await resetNewSessionTmp(vfs, '/tmp');

      const raw = await vfs.readTextFile(`/sessions/${frozen!.filename}`);
      expect(raw).not.toContain(failingPath);
      expect(raw).not.toContain('sensitive backend detail');
      const archived = parseFrozenArchive(raw);
      expect(archived.messages.map(({ content }) => content)).toEqual([
        'archive both files',
        'first response',
        'follow up',
        'final response',
      ]);
      const attachments = archived.messages[0].attachments!;
      const archivedReadablePath = attachments[0].path!;
      expect(archivedReadablePath).toMatch(/^\/sessions\/attachments\//);
      expect(
        Array.from((await vfs.readFile(archivedReadablePath, { encoding: 'binary' })) as Uint8Array)
      ).toEqual(Array.from(readableBytes));
      expect(attachments[1]).toEqual({
        id: 'failing-1',
        name: 'private.bin',
        mimeType: 'application/octet-stream',
        size: 3,
        kind: 'file',
        error: 'Archived attachment file is missing or unsafe to preserve.',
      });
      expect(await vfs.readDir('/tmp')).toEqual([]);
    }
  );
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
    mockRunAgenticMemoryPass.mockReset();
    mockApplyConeMemoryBudget.mockReset();
    mockReadSessionCount.mockReset().mockResolvedValue(1);
    mockApplyConeMemoryBudget.mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
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
      agenticMemorySpawn: vi.fn(),
    });

    expect(result).not.toBeNull();
    expect(mockRunOneOffCompactionCall).not.toHaveBeenCalled();
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
    expect(result!.pendingEnrichment).toBe(true);

    expect(result!.filename).toMatch(/^pending-[a-z0-9-]+\.md$/);

    expect(result!.title).toContain('refactor the auth flow');

    expect(vfs.files.has(`/sessions/${result!.filename}`)).toBe(true);

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].pendingEnrichment).toBe(true);
    expect(index[0].memoryPending).toBe(true);
    expect(result!.memoryPending).toBe(true);
    expect(index[0].filename).toBe(result!.filename);
  });

  it('quick mode without a curator spawn never sets memoryPending', async () => {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('q'), assistantMessage('a'), userMessage('r'), assistantMessage('b')],
      createdAt: 100,
      updatedAt: 200,
    });
    const vfs = makeFakeVfs();

    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });

    expect(result).not.toBeNull();
    expect(result!.memoryPending).toBeUndefined();
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].memoryPending).toBeUndefined();
  });

  it('preserves the sessions index when its read fails with a non-ENOENT error', async () => {
    const vfs = makeFakeVfs();
    const durableIndex = JSON.stringify([
      {
        filename: 'existing.md',
        title: 'Existing session',
        frozenAt: '2026-08-01T00:00:00.000Z',
        messageCount: 4,
      },
    ]);
    vfs.files.set(SESSIONS_INDEX_PATH, durableIndex);
    const originalReadFile = vfs.readFile.bind(vfs);
    vfs.readFile = async (path: string): Promise<string> => {
      if (path === SESSIONS_INDEX_PATH) throw new FsError('EIO', 'transient fault', path);
      return originalReadFile(path);
    };

    const result = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 100,
        updatedAt: 200,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });

    expect(result).toBeNull();
    expect(vfs.files.get(SESSIONS_INDEX_PATH)).toBe(durableIndex);
  });
});

describe('listPendingEnrichments', () => {
  it('loads a legacy index entry without cost metadata', async () => {
    const vfs = makeFakeVfs();
    vfs.files.set(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: 'legacy.md',
          title: 'legacy',
          frozenAt: '2026-05-12T10:00:00.000Z',
          messageCount: 4,
        },
      ])
    );

    const [entry] = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(entry.cost).toBeUndefined();
    expect(entry.models).toBeUndefined();
  });

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

  it('returns both pending marker types below the retry cap', async () => {
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
          filename: 'memory-pending.md',
          title: 'memory pending',
          frozenAt: '2026-05-13T18:00:00.000Z',
          messageCount: 5,
          memoryPending: true,
        },
        {
          filename: 'retry-capped.md',
          title: 'capped',
          frozenAt: '2026-05-13T17:00:00.000Z',
          messageCount: 5,
          memoryPending: true,
          pendingAttemptCount: 3,
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
    expect(out.map((entry) => entry.filename)).toEqual(['pending-abc.md', 'memory-pending.md']);
  });
});

describe('processPendingSessions', () => {
  const indexEntry = (
    filename: string,
    pending: Partial<Pick<FrozenSessionIndexEntry, 'pendingEnrichment' | 'memoryPending'>>
  ): FrozenSessionIndexEntry => ({
    filename,
    title: filename,
    frozenAt: '2026-08-06T12:00:00.000Z',
    messageCount: 4,
    ...pending,
  });

  beforeEach(() => {
    mockRunAgenticMemoryPass.mockReset();
    mockRunOneOffCompactionCall.mockReset();
    mockReadSessionCount.mockReset().mockResolvedValue(3);
    mockApplyConeMemoryBudget.mockReset().mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
  });

  it('recovers every pending marker serially without ever running the curator', async () => {
    const vfs = makeFakeVfs();
    vfs.files.set(
      '/sessions/index.json',
      JSON.stringify([
        indexEntry('pending-one.md', { pendingEnrichment: true }),
        indexEntry('pending-two.md', { memoryPending: true }),
        indexEntry('pending-three.md', { pendingEnrichment: true, memoryPending: true }),
      ])
    );

    const result = await processPendingSessions({
      vfs: vfs as unknown as Parameters<typeof processPendingSessions>[0]['vfs'],
      model: {} as never,
      apiKey: 'k',
    });

    expect(result.attempted).toBe(3);
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
  });

  it('uses legacy enrichment for a memoryPending archive when no curator is supplied', async () => {
    const vfs = makeFakeVfs();
    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    const entry = { ...frozen!, pendingEnrichment: undefined, memoryPending: true as const };
    const { archive: _archive, ...index } = entry;
    vfs.files.set('/sessions/index.json', JSON.stringify([index]));
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Recovered archive');

    const result = await processPendingSessions({
      vfs: vfs as unknown as Parameters<typeof processPendingSessions>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    expect(result).toEqual({ attempted: 1, completed: 1 });
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledTimes(2);
    const [updated] = await readSessionsIndex(vfs as never);
    expect(updated.title).toBe('Recovered archive');
    expect(updated.memoryPending).toBeUndefined();
    expect(updated.pendingAttemptCount).toBeUndefined();
  });

  it('keeps a canonical curator archive at its name when legacy enrichment runs', async () => {
    const vfs = makeFakeVfs();
    const frozen = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('q'),
          assistantMessage('a'),
          userMessage('r'),
          assistantMessage('b'),
        ],
        createdAt: 0,
        updatedAt: 1,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'full',
    });
    const canonicalName = frozen!.filename;
    expect(canonicalName.startsWith('pending-')).toBe(false);
    const { archive: _archive, ...index } = {
      ...frozen!,
      pendingEnrichment: undefined,
      memoryPending: true as const,
    };
    vfs.files.set('/sessions/index.json', JSON.stringify([index]));

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('A slightly different title');

    const result = await processPendingSessions({
      vfs: vfs as unknown as Parameters<typeof processPendingSessions>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    });

    expect(result).toEqual({ attempted: 1, completed: 1 });
    const [updated] = await readSessionsIndex(vfs as never);
    expect(updated.filename).toBe(canonicalName);
    expect(updated.title).toBe(frozen!.title);
    expect(updated.memoryPending).toBeUndefined();
    expect(updated.pendingAttemptCount).toBeUndefined();
    expect(vfs.files.has(`/sessions/${canonicalName}`)).toBe(true);
  });

  it('persists the third failed attempt and skips the archive thereafter', async () => {
    const vfs = makeFakeVfs();
    vfs.files.set(
      '/sessions/index.json',
      JSON.stringify([
        { ...indexEntry('always-fails.md', { memoryPending: true }), pendingAttemptCount: 2 },
      ])
    );
    mockRunOneOffCompactionCall.mockRejectedValue(new Error('provider unavailable'));
    const opts = {
      vfs: vfs as unknown as Parameters<typeof processPendingSessions>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
    };

    expect(await processPendingSessions(opts)).toEqual({ attempted: 1, completed: 0 });
    expect(await processPendingSessions(opts)).toEqual({ attempted: 0, completed: 0 });
    expect(mockRunAgenticMemoryPass).not.toHaveBeenCalled();
    const [failed] = await readSessionsIndex(vfs as never);
    expect(failed).toMatchObject({ memoryPending: true, pendingAttemptCount: 3 });

    expect(failed.memoryFailed).toBe('catch-up retries exhausted (3)');
    expect(await listPendingEnrichments(vfs as never)).toEqual([]);
  });
});

describe('readSessionsIndex over RemoteVfsClient', () => {
  it('reads /sessions/index.json through the RPC host', async () => {
    const { createRemoteVfsClient } = await import('../../src/kernel/remote-vfs-client.js');
    const { createBridgeMessageChannelTransport, createPanelMessageChannelTransport } =
      await import('../../src/kernel/transport-message-channel.js');
    const { startVfsRpcHost } = await import('../../src/kernel/vfs-rpc-host.js');

    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const panel = createPanelMessageChannelTransport(channel.port1);

    const indexPayload = JSON.stringify([
      {
        filename: '2026-05-13T19-30-00-000Z-fix-build.md',
        title: 'fix build',
        frozenAt: '2026-05-13T19:30:00.000Z',
        messageCount: 12,
      },
      {
        filename: 'pending-xyz.md',
        title: 'rough',
        frozenAt: '2026-05-14T08:00:00.000Z',
        messageCount: 5,
        pendingEnrichment: true,
      },
    ]);

    const readFile = vi.fn(async (path: string) => {
      if (path === '/sessions/index.json') return indexPayload;
      const err = new Error(`ENOENT: ${path}`);
      (err as unknown as { code: string }).code = 'ENOENT';
      throw err;
    });

    const host = startVfsRpcHost({
      transport: bridge,
      client: {
        readDir: async () => [],
        readFile,
        stat: async () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }),
      },
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const remoteVfs = createRemoteVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    try {
      const all = await readSessionsIndex(remoteVfs);
      expect(all).toHaveLength(2);
      expect(all[0].filename).toBe('2026-05-13T19-30-00-000Z-fix-build.md');

      const pending = await listPendingEnrichments(remoteVfs);
      expect(pending).toHaveLength(1);
      expect(pending[0].filename).toBe('pending-xyz.md');

      expect(readFile).toHaveBeenCalledWith('/sessions/index.json', expect.anything());
    } finally {
      remoteVfs.dispose();
      host.stop();
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe('enrichPendingSession', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockApplyConeMemoryBudget.mockReset();
    mockApplyConeMemoryBudget.mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
  });

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

  it('curator-already-ran: completion receipt present → title-only, marker + receipt drop (#1989)', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    const curated = '## Memory\n- curated by the agentic pass\n';
    vfs.files.set('/workspace/CLAUDE.md', curated);
    const receiptPath = `/sessions/.curated/${pendingFilename}`;
    vfs.files.set(receiptPath, '2026-08-08T00:00:00.000Z');

    mockRunOneOffCompactionCall.mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
        memoryPending: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledTimes(1);

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBe(curated);

    expect(updated!.memoryPending).toBeUndefined();
    expect(updated!.pendingEnrichment).toBeUndefined();
    expect(vfs.files.has(receiptPath)).toBe(false);
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].memoryPending).toBeUndefined();
  });

  it('memoryPending with NO receipt still runs the legacy extraction', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- curated nothing; legacy extraction owns memory')
      .mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
        memoryPending: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledTimes(2);
    expect(vfs.files.get('/workspace/CLAUDE.md')).toContain('legacy extraction owns memory');
    expect(updated!.memoryPending).toBeUndefined();
  });

  it("catch-up enrichment writes back to the archive's OWN cone (#2271)", async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- a fact beta learned')
      .mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
        memoryPending: true,

        cone: 'cone-beta',
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(vfs.files.get('/cones/cone-beta/CLAUDE.md')).toContain('a fact beta learned');
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
  });

  it("a sibling archive's memory write is never misattributed (per-entry receipts)", async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename: fileA, frozenAt: frozenAtA } = await seedPending(vfs);
    const { pendingFilename: fileB, frozenAt: frozenAtB } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- fact from archive A')
      .mockResolvedValueOnce('Archive A title')
      .mockResolvedValueOnce('- fact from archive B')
      .mockResolvedValueOnce('Archive B title');

    const entryA = {
      filename: fileA,
      title: 'a',
      frozenAt: frozenAtA,
      messageCount: 4,
      pendingEnrichment: true,
      memoryPending: true as const,
    };
    const entryB = {
      filename: fileB,
      title: 'b',
      frozenAt: frozenAtB,
      messageCount: 4,
      pendingEnrichment: true,
      memoryPending: true as const,
    };

    const updatedA = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      entryA,
      { model: fakeModel!, apiKey: 'k' }
    );
    expect(updatedA).not.toBeNull();

    expect(vfs.files.get('/workspace/CLAUDE.md')).toContain('fact from archive A');

    const updatedB = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      entryB,
      { model: fakeModel!, apiKey: 'k' }
    );
    expect(updatedB).not.toBeNull();

    expect(mockRunOneOffCompactionCall).toHaveBeenCalledTimes(4);
    expect(vfs.files.get('/workspace/CLAUDE.md')).toContain('fact from archive B');
  });

  it('rewrites the title, renames the file, drops the pending flag, and appends memory', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

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

    expect(vfs.files.has(`/sessions/${pendingFilename}`)).toBe(false);
    const newContent = vfs.files.get(`/sessions/${updated!.filename}`);
    expect(newContent).toBeDefined();
    expect(newContent).toContain('title: "Build pipeline debug"');
    expect(newContent).toContain('# Build pipeline debug');

    const memory = vfs.files.get('/workspace/CLAUDE.md');
    expect(memory).toBeTruthy();
    expect(memory).toMatch(/Auto-extracted.*pending-enrichment/);
    expect(memory).toContain('prefers vitest');

    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].filename).toBe(updated!.filename);
    expect(index[0].pendingEnrichment).toBeUndefined();
    expect(index[0].title).toBe('Build pipeline debug');

    expect(mockApplyConeMemoryBudget).toHaveBeenCalled();
    const lastCall = mockApplyConeMemoryBudget.mock.calls.at(-1)![0] as {
      vfs: unknown;
      model: unknown;
      apiKey: string;
    };
    expect(lastCall.vfs).toBe(vfs);
    expect(lastCall.model).toBe(fakeModel);
    expect(lastCall.apiKey).toBe('k');
  });

  it('memorySkipped archive (dropped cone): title-only pass, no memory, marker survives the rename (#2272)', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);
    mockRunOneOffCompactionCall.mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
        memorySkipped: true,
      },

      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledOnce();
    expect(mockRunOneOffCompactionCall.mock.calls[0][0].instruction).toBe('TITLE');
    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(updated!.pendingEnrichment).toBeUndefined();
    expect(updated!.memoryPending).toBeUndefined();
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].memorySkipped).toBe(true);
  });

  it('skipMemory: title-only pass skips the memory call and keeps memoryPending across the rename', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall.mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
        memoryPending: true,
      },
      { model: fakeModel!, apiKey: 'k', skipMemory: true }
    );

    expect(updated).not.toBeNull();
    expect(mockRunOneOffCompactionCall).toHaveBeenCalledOnce();
    expect(mockRunOneOffCompactionCall.mock.calls[0][0].instruction).toBe('TITLE');

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(mockApplyConeMemoryBudget).not.toHaveBeenCalled();

    expect(updated!.filename).toMatch(/build-pipeline-debug\.md$/);
    expect(updated!.pendingEnrichment).toBeUndefined();
    expect(updated!.memoryPending).toBe(true);
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].memoryPending).toBe(true);
    expect(index[0].pendingEnrichment).toBeUndefined();
  });

  it('records a picked lucide icon on the renamed entry when pickIcon is supplied', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Build pipeline debug');
    const pickIcon = vi.fn(async (_ctx: { subject: string }) => 'wrench');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k', pickIcon }
    );

    expect(pickIcon).toHaveBeenCalledTimes(1);
    expect(pickIcon.mock.calls[0][0].subject).toContain('Build pipeline debug');
    expect(updated!.icon).toBe('wrench');
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].icon).toBe('wrench');

    const vfs2 = makeFakeVfs();
    const seeded2 = await seedPending(vfs2);
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Another title');
    const updated2 = await enrichPendingSession(
      vfs2 as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: seeded2.pendingFilename,
        title: 'debug the build pipeline',
        frozenAt: seeded2.frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );
    expect(updated2!.icon).toBeUndefined();
  });

  it('drops a non-lucide picked name so the renamed entry records no icon', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Build pipeline debug');
    const pickIcon = vi.fn(async (_ctx: { subject: string }) => 'not-a-real-icon');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k', pickIcon }
    );

    expect(pickIcon).toHaveBeenCalledTimes(1);
    expect(updated!.icon).toBeUndefined();
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0].icon).toBeUndefined();
  });

  it('picks the icon before appending memory: a hung pick writes no memory, retry appends once', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- prefers vitest')
      .mockResolvedValueOnce('Build pipeline debug');
    const hang = vi.fn(() => new Promise<string>(() => {}));

    void enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'debug the build pipeline',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k', pickIcon: hang }
    );

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(hang).toHaveBeenCalledTimes(1);

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.has(`/sessions/${pendingFilename}`)).toBe(true);
    const indexAfterHang = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(indexAfterHang[0].pendingEnrichment).toBe(true);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- prefers vitest')
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

    expect(updated!.pendingEnrichment).toBeUndefined();
    const memory = vfs.files.get('/workspace/CLAUDE.md');
    expect(memory).toBeTruthy();

    expect(memory!.match(/prefers vitest/g)).toHaveLength(1);
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

    expect(vfs.files.get('/sessions/foo.md')).toContain('# foo');
  });

  it('leaves the pending entry intact when the title LLM call fails', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

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

    expect(vfs.files.has(`/sessions/${pendingFilename}`)).toBe(true);

    expect(vfs.files.get('/workspace/CLAUDE.md')).toBeUndefined();
    expect(vfs.files.get('/shared/CLAUDE.md')).toBeUndefined();

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0].pendingEnrichment).toBe(true);
    expect(index[0].filename).toBe(pendingFilename);
  });

  it('warns (not infos) and stays pending when archive read fails with a non-ENOENT error', async () => {
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

  it('preserves the sessions index when replacement reads fail with a non-ENOENT error', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);
    const durableIndex = vfs.files.get(SESSIONS_INDEX_PATH)!;
    const originalReadFile = vfs.readFile.bind(vfs);
    vfs.readFile = async (path: string): Promise<string> => {
      if (path === SESSIONS_INDEX_PATH) throw new FsError('EACCES', 'permission denied', path);
      return originalReadFile(path);
    };
    mockRunOneOffCompactionCall.mockResolvedValueOnce('Canonical title');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: pendingFilename,
        title: 'heuristic',
        frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k', skipMemory: true }
    );

    expect(updated).toBeNull();
    expect(vfs.files.get(SESSIONS_INDEX_PATH)).toBe(durableIndex);
  });

  it('does not duplicate the canonical row when it already exists in the index', async () => {
    const vfs = makeFakeVfs();
    const { pendingFilename, frozenAt } = await seedPending(vfs);

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Canonical title');

    const canonicalFilename = `${frozenAt.replace(/[:.]/g, '-')}-canonical-title.md`;

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

    const canonicalRows = index.filter((e) => e.filename === canonicalFilename);
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0].title).toBe('Canonical title');
    expect(index.some((e) => e.filename === 'unrelated.md')).toBe(true);
  });

  it('serializes concurrent enrichments so both replacements land in the index', async () => {
    const vfs = makeFakeVfs();

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

    expect(filenames).toContain(resA!.filename);
    expect(filenames).toContain(resB!.filename);
  });
});

describe('freezeConeSession — writes route through WritableVfsClient', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockApplyConeMemoryBudget.mockReset();
    mockApplyConeMemoryBudget.mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
  });

  it('routes every freezer write through the RPC wire', async () => {
    const [
      { startVfsRpcHost: startHost },
      { createRemoteWritableVfsClient: createClient },
      transportMod,
      { FsError },
    ] = await Promise.all([
      import('../../src/kernel/vfs-rpc-host.js'),
      import('../../src/kernel/writable-vfs-client.js'),
      import('../../src/kernel/transport-message-channel.js'),
      import('../../src/fs/types.js'),
    ]);

    const files = new Map<string, string>();
    const mkdirCalls: string[] = [];
    const flushes = { count: 0 };
    const backend = {
      async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
      },
      async mkdir(path: string): Promise<void> {
        mkdirCalls.push(path);
      },
      async rm(path: string): Promise<void> {
        if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
        files.delete(path);
      },
      async flush(): Promise<void> {
        flushes.count++;
      },
    };
    const readClient = {
      async readDir(): Promise<never[]> {
        return [];
      },
      async readFile(path: string, opts?: { encoding?: 'utf-8' | 'binary' }): Promise<string> {
        const encoding = opts?.encoding ?? 'utf-8';
        if (encoding !== 'utf-8') throw new FsError('EINVAL', 'binary not used here', path);
        const value = files.get(path);
        if (value === undefined) throw new FsError('ENOENT', `missing ${path}`, path);
        return value;
      },
      async stat(): Promise<never> {
        throw new FsError('EIO', 'stat not used by the freezer', '');
      },
    };

    const channel = new MessageChannel();
    const bridge = transportMod.createBridgeMessageChannelTransport(channel.port2);
    const panel = transportMod.createPanelMessageChannelTransport(channel.port1);
    const host = startHost({
      transport: bridge,
      client: readClient,
      writableClient: backend,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const writableClient = createClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    try {
      mockRunOneOffCompactionCall
        .mockResolvedValueOnce('- always run lint before commit')
        .mockResolvedValueOnce('Wire B4 freezer route');

      const messages: ChatMessage[] = [
        userMessage('plan the migration'),
        assistantMessage('ok'),
        userMessage('go'),
        assistantMessage('done'),
      ];
      const store = makeFakeStore({
        id: 'session-cone',
        messages,
        createdAt: 100,
        updatedAt: 200,
      });

      const result = await freezeConeSession({
        sessionStore: store,
        vfs: writableClient,
        model: fakeModel,
        apiKey: 'k',
      });

      expect(result).not.toBeNull();
      const archivePath = `/sessions/${result!.filename}`;

      expect(files.has(archivePath)).toBe(true);
      expect(files.get(archivePath)).toContain('# Wire B4 freezer route');

      const indexRaw = files.get('/sessions/index.json');
      expect(indexRaw).toBeTruthy();
      const indexParsed = JSON.parse(indexRaw!);
      expect(indexParsed[0].title).toBe('Wire B4 freezer route');

      const memoryDoc = files.get('/workspace/CLAUDE.md');
      expect(memoryDoc).toContain('always run lint before commit');

      expect(mkdirCalls).toEqual(expect.arrayContaining(['/sessions', '/workspace']));

      expect(flushes.count).toBeGreaterThanOrEqual(1);
    } finally {
      writableClient.dispose();
      host.stop();
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe('freezeConeSession — dictation marker handling', () => {
  const MIC = '\uD83C\uDF99\uFE0F';
  const LEFT = '\u25C1';
  const RIGHT = '\u25B7';

  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockApplyConeMemoryBudget.mockReset();
    mockApplyConeMemoryBudget.mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
  });

  it('strips 🎙️ + ◁…▷ from the human-readable body but KEEPS them in the structured data block', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('NONE')
      .mockResolvedValueOnce('Dictation chat');

    const dictatedFirst = applyDictationMarkers('Hello there', true);
    const dictatedLater = applyDictationMarkers('Try again', false);
    const messages: ChatMessage[] = [
      userMessage(dictatedFirst),
      assistantMessage('Hi back'),
      userMessage(dictatedLater),
      assistantMessage('Sure thing'),
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

    const archivePath = `/sessions/${result!.filename}`;
    const archiveContent = vfs.files.get(archivePath)!;

    const dataMatch = archiveContent.match(/<!-- slicc:session-data\n([\s\S]*?)\n-->/);
    expect(dataMatch).not.toBeNull();
    const dataJson = dataMatch![1];
    const bodyStart = archiveContent.indexOf('-->\n') + '-->\n'.length;
    const body = archiveContent.slice(bodyStart);

    expect(dataJson).toContain(MIC);
    expect(dataJson).toContain(LEFT);
    expect(dataJson).toContain(RIGHT);

    expect(body).not.toContain(MIC);
    expect(body).not.toContain(LEFT);
    expect(body).not.toContain(RIGHT);

    expect(body).toContain('## User\nHello there\n');
    expect(body).toContain('## User\nTry again\n');

    expect(body).toContain('## Assistant\nHi back\n');
    expect(body).toContain('## Assistant\nSure thing\n');
  });

  it('parseFrozenArchive round-trips: thawed user messages retain markers (render-time strip handles display)', async () => {
    mockRunOneOffCompactionCall.mockResolvedValueOnce('NONE').mockResolvedValueOnce('Roundtrip');

    const dictated = applyDictationMarkers('Round trip test', true);
    const messages: ChatMessage[] = [
      userMessage(dictated),
      assistantMessage('ok'),
      userMessage('plain text follow-up'),
      assistantMessage('done'),
    ];
    const store = makeFakeStore({
      id: 'session-cone',
      messages,
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
    const archiveContent = vfs.files.get(`/sessions/${result!.filename}`)!;

    const { messages: thawed } = parseFrozenArchive(archiveContent);
    expect(thawed).toHaveLength(4);

    expect(thawed[0].role).toBe('user');
    expect(thawed[0].content).toBe(dictated);
    expect(thawed[0].content).toContain(MIC);

    expect(thawed[2].content).toBe('plain text follow-up');

    expect(thawed[1].content).toBe('ok');
    expect(thawed[3].content).toBe('done');
  });
});

describe('freezeConeSession — sessionId generation', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockApplyConeMemoryBudget.mockReset();
    mockApplyConeMemoryBudget.mockResolvedValue({ restructured: false, reason: 'no-llm' });
  });

  it('generates a sessionId on each freeze', async () => {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();
    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    expect(result).not.toBeNull();
    expect(typeof result!.sessionId).toBe('string');
    expect(result!.sessionId!.length).toBeGreaterThan(0);
  });

  it('sessionId is recorded in the index entry', async () => {
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();
    const result = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0]!.sessionId).toBe(result!.sessionId);
  });

  it('sessionId is preserved through enrichment rename', async () => {
    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- bullet')
      .mockResolvedValueOnce('Enriched Title');
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 0,
      updatedAt: 1,
    });
    const vfs = makeFakeVfs();
    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    expect(frozen).not.toBeNull();
    const originalSessionId = frozen!.sessionId!;

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      {
        filename: frozen!.filename,
        sessionId: originalSessionId,
        title: 'heuristic',
        frozenAt: frozen!.frozenAt,
        messageCount: 4,
        pendingEnrichment: true,
      },
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated).not.toBeNull();
    expect(updated!.sessionId).toBe(originalSessionId);

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0]!.sessionId).toBe(originalSessionId);
  });

  it('two sequential freezes produce distinct sessionIds', async () => {
    const makeStore = () =>
      makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('a'),
          assistantMessage('b'),
          userMessage('c'),
          assistantMessage('d'),
        ],
        createdAt: 0,
        updatedAt: 1,
      });
    const vfs1 = makeFakeVfs();
    const vfs2 = makeFakeVfs();
    const r1 = await freezeConeSession({
      sessionStore: makeStore(),
      vfs: vfs1 as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    const r2 = await freezeConeSession({
      sessionStore: makeStore(),
      vfs: vfs2 as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    expect(r1!.sessionId).not.toBe(r2!.sessionId);
  });
});

describe('markSnapshotUnavailable — serialized inside indexWriteChain', () => {
  it('sets completeSnapshotUnavailable on the pending entry', async () => {
    const vfs = makeFakeVfs();
    const store = makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 0,
      updatedAt: 1,
    });
    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });
    expect(frozen).not.toBeNull();
    const filename = frozen!.filename;

    await markSnapshotUnavailable(
      vfs as unknown as Parameters<typeof markSnapshotUnavailable>[0],
      filename
    );

    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index).toHaveLength(1);
    expect(index[0]!.completeSnapshotUnavailable).toBe(true);

    expect(index[0]!.filename).toBe(filename);
  });

  it('concurrent mark + freeze produce no duplicate entries', async () => {
    const vfs1 = makeFakeVfs();
    const store1 = makeFakeStore({
      id: 'session-1',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 0,
      updatedAt: 1,
    });
    const store2 = makeFakeStore({
      id: 'session-2',
      messages: [userMessage('x'), assistantMessage('y'), userMessage('z'), assistantMessage('w')],
      createdAt: 2,
      updatedAt: 3,
    });

    const freezeQuickAt = async (store: SessionStore, utcSecond: number) => {
      const dateSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Date.UTC(2026, 4, 13, 19, 0, utcSecond));
      try {
        return await freezeConeSession({
          sessionStore: store,
          vfs: vfs1 as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
          mode: 'quick',
        });
      } finally {
        dateSpy.mockRestore();
      }
    };

    const frozen1 = await freezeQuickAt(store1, 10);
    expect(frozen1).not.toBeNull();

    const markPromise = markSnapshotUnavailable(
      vfs1 as unknown as Parameters<typeof markSnapshotUnavailable>[0],
      frozen1!.filename
    );
    const freezePromise = freezeQuickAt(store2, 20);

    const [, frozen2] = await Promise.all([markPromise, freezePromise]);
    expect(frozen2).not.toBeNull();
    expect(frozen2!.filename).not.toBe(frozen1!.filename);

    const index = await readSessionsIndex(
      vfs1 as unknown as Parameters<typeof readSessionsIndex>[0]
    );

    expect(index).toHaveLength(2);
    const marked = index.find((e) => e.filename === frozen1!.filename);
    expect(marked?.completeSnapshotUnavailable).toBe(true);
  });

  it('is a no-op when filename is not in the index', async () => {
    const vfs = makeFakeVfs();

    await expect(
      markSnapshotUnavailable(
        vfs as unknown as Parameters<typeof markSnapshotUnavailable>[0],
        'non-existent-file.md'
      )
    ).resolves.not.toThrow();
  });

  it('does not throw when the index file does not exist yet', async () => {
    const vfs = makeFakeVfs();

    await expect(
      markSnapshotUnavailable(
        vfs as unknown as Parameters<typeof markSnapshotUnavailable>[0],
        'pending-abc.md'
      )
    ).resolves.toBeUndefined();
  });

  it('preserves the sessions index when its read fails with a non-ENOENT error', async () => {
    const vfs = makeFakeVfs();
    const durableIndex = JSON.stringify([
      {
        filename: 'existing.md',
        title: 'Existing session',
        frozenAt: '2026-08-01T00:00:00.000Z',
        messageCount: 4,
      },
    ]);
    vfs.files.set(SESSIONS_INDEX_PATH, durableIndex);
    vfs.readFile = async (path: string): Promise<string> => {
      throw new FsError('EIO', 'transient fault', path);
    };

    await expect(
      markSnapshotUnavailable(
        vfs as unknown as Parameters<typeof markSnapshotUnavailable>[0],
        'existing.md'
      )
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(vfs.files.get(SESSIONS_INDEX_PATH)).toBe(durableIndex);
  });
});

describe('freezeConeSession — cone provenance (#2272)', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockRunAgenticMemoryPass.mockReset();
    mockApplyConeMemoryBudget.mockReset().mockResolvedValue({
      restructured: false,
      reason: 'no-llm',
    });
    mockReadSessionCount.mockReset().mockResolvedValue(1);
  });

  function makeKeyedStore(sessions: Record<string, Session>) {
    const requested: string[] = [];
    const store = {
      async load(id: string): Promise<Session | null> {
        requested.push(id);
        return sessions[id] ?? null;
      },
    } as unknown as SessionStore;
    return { store, requested };
  }

  function session(id: string, first: string): Session {
    return {
      id,
      messages: [
        userMessage(first),
        assistantMessage('sure'),
        userMessage('and then?'),
        assistantMessage('done'),
      ],
      createdAt: 100,
      updatedAt: 200,
    };
  }

  it('defaults to the primary cone and records it as the archive owner', async () => {
    const vfs = makeFakeVfs();
    const { store, requested } = makeKeyedStore({ 'session-cone': session('session-cone', 'hi') });

    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
    });

    expect(requested).toEqual(['session-cone']);
    expect(frozen!.cone).toBe('cone');
    expect(frozen!.coneLabel).toBeUndefined();
    expect(frozen!.archive.cone).toBe('cone');
  });

  it('freezes the selected extra cone, not the primary one', async () => {
    const vfs = makeFakeVfs();
    const { store, requested } = makeKeyedStore({
      'session-cone': session('session-cone', 'primary chat'),
      'session-cone-research': session('session-cone-research', 'research chat'),
    });

    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
      cone: { folder: 'cone-research', label: 'Research' },
    });

    expect(requested).toEqual(['session-cone-research']);
    expect(frozen!.archive.messages[0].content).toBe('research chat');
    expect(frozen!.cone).toBe('cone-research');
    expect(frozen!.coneLabel).toBe('Research');
    const index = await readSessionsIndex(
      vfs as unknown as Parameters<typeof readSessionsIndex>[0]
    );
    expect(index[0]).toMatchObject({ cone: 'cone-research', coneLabel: 'Research' });
  });

  it('writes provenance into the archive frontmatter and parses it back', async () => {
    const vfs = makeFakeVfs();
    const { store } = makeKeyedStore({
      'session-cone-note-taking': session('session-cone-note-taking', 'take notes'),
    });

    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
      cone: { folder: 'cone-note-taking', label: 'Note "taking"' },
    });

    const markdown = vfs.files.get(`/sessions/${frozen!.filename}`)!;
    expect(markdown).toContain('cone: cone-note-taking');
    const parsed = parseFrozenArchive(markdown);
    expect(parsed.cone).toBe('cone-note-taking');

    expect(parsed.coneLabel).toBe('Note "taking"');
  });

  it('omits the label for the primary cone (every card would say the same)', async () => {
    const vfs = makeFakeVfs();
    const { store } = makeKeyedStore({ 'session-cone': session('session-cone', 'hello') });

    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
      cone: { folder: 'cone', label: 'sliccy' },
    });

    expect(frozen!.cone).toBe('cone');
    expect(frozen!.coneLabel).toBeUndefined();
    expect(vfs.files.get(`/sessions/${frozen!.filename}`)).not.toContain('coneLabel:');
  });

  it('skips (and reports nothing) when the selected cone has no history', async () => {
    const vfs = makeFakeVfs();
    const { store, requested } = makeKeyedStore({
      'session-cone': session('session-cone', 'primary has plenty'),
    });

    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
      cone: { folder: 'cone-empty' },
    });

    expect(requested).toEqual(['session-cone-empty']);
    expect(frozen).toBeNull();
    expect(vfs.files.has(SESSIONS_INDEX_PATH)).toBe(false);
  });

  it('keeps provenance across the enrichment rename', async () => {
    const vfs = makeFakeVfs();
    const { store } = makeKeyedStore({
      'session-cone-research': session('session-cone-research', 'debug the build pipeline'),
    });
    const frozen = await freezeConeSession({
      sessionStore: store,
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      mode: 'quick',
      cone: { folder: 'cone-research', label: 'Research' },
    });

    mockRunOneOffCompactionCall
      .mockResolvedValueOnce('- learned something')
      .mockResolvedValueOnce('Build pipeline debug');

    const updated = await enrichPendingSession(
      vfs as unknown as Parameters<typeof enrichPendingSession>[0],
      frozen as FrozenSessionIndexEntry,
      { model: fakeModel!, apiKey: 'k' }
    );

    expect(updated!.filename).not.toBe(frozen!.filename);
    expect(updated).toMatchObject({ cone: 'cone-research', coneLabel: 'Research' });
  });
});
