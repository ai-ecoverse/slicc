/**
 * "New chat" over a session whose compaction rounds already wrote a live
 * snapshot: save/skip COMPLETE that archive (same id, same file, `live` gone),
 * erase deletes it, and enrichment renames the provisional `live-` name like
 * any quick-freeze draft.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import type { AgentSpawnOptions } from '../../src/scoops/agent-bridge.js';
import type { SessionStore } from '../../src/scoops/chat-session-store.js';
import { snapshotLiveSession } from '../../src/scoops/live-session-snapshot.js';
import {
  parseFrozenArchive,
  readSessionsIndex,
} from '../../src/transcript/frozen-archive-format.js';
import type { ChatMessage, Session } from '../../src/ui/types.js';

const mockRunOneOffCompactionCall = vi.fn();
vi.mock('../../src/core/context-compaction.js', () => ({
  COMPACTION_MEMORY_INSTRUCTION: 'MEMORY',
  COMPACTION_TITLE_INSTRUCTION: 'TITLE',
  runOneOffCompactionCall: (...args: unknown[]) => mockRunOneOffCompactionCall(...args),
}));

import {
  advanceCuratedThrough,
  liveDeltaArchivePath,
} from '../../src/scoops/live-session-curation.js';
import {
  curateFrozenSessionMemories,
  enrichPendingSession,
  freezeConeSession,
} from '../../src/ui/session-freezer.js';

function makeFakeVfs() {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return files.get(path)!;
    },
    async readDir(): Promise<never[]> {
      return [];
    },
    async listMountPoints(): Promise<never[]> {
      return [];
    },
    async stat(path: string) {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return { type: 'file' as const, size: files.get(path)!.length, mtime: 0, ctime: 0 };
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async mkdir(): Promise<void> {},
    async flush(): Promise<void> {},
    async rm(path: string): Promise<void> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      files.delete(path);
    },
  };
}
type FakeVfs = ReturnType<typeof makeFakeVfs>;

const chat = (role: 'user' | 'assistant', content: string, timestamp: number): ChatMessage => ({
  id: `${role}-${timestamp}`,
  role,
  content,
  timestamp,
});
const agentText = (role: 'user' | 'assistant', text: string, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }) as AgentMessage;

const session: Session = {
  id: 'session-cone',
  createdAt: 1,
  updatedAt: 9,
  messages: [
    chat('user', 'first question', 1),
    chat('assistant', 'first answer', 2),
    chat('user', 'second question', 3),
    chat('assistant', 'second answer', 4),
    chat('user', 'third question', 5),
  ],
};
const store = {
  async load() {
    return session;
  },
} as unknown as SessionStore;

async function seedLiveSnapshot(vfs: FakeVfs, folder = 'cone') {
  const result = await snapshotLiveSession({
    vfs,
    cone: { folder, label: folder === 'cone' ? 'sliccy' : 'Research' },
    messages: [agentText('user', 'first question', 1), agentText('assistant', 'first answer', 2)],
    trigger: 'threshold',
  });
  if (!result) throw new Error('snapshot was skipped');
  return result;
}

beforeEach(() => mockRunOneOffCompactionCall.mockReset());

describe('freezeConeSession over a live snapshot', () => {
  it('completes the live archive instead of adding a second one', async () => {
    const vfs = makeFakeVfs();
    const live = await seedLiveSnapshot(vfs);

    const frozen = await freezeConeSession({ sessionStore: store, vfs, mode: 'quick' });

    expect(frozen?.filename).toBe(live.entry.filename);
    expect(frozen?.sessionId).toBe(live.entry.sessionId);
    const entries = await readSessionsIndex(vfs as never);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      filename: live.entry.filename,
      sessionId: live.entry.sessionId,
      pendingEnrichment: true,
      messageCount: 5,
      cone: 'cone',
    });
    expect(entries[0].live).toBeUndefined();
    expect(entries[0].liveThrough).toBeUndefined();
    const archive = parseFrozenArchive(vfs.files.get(live.transcriptPath)!);
    expect(archive.live).toBeUndefined();
    // The UI store's full chat replaces the accumulated agent transcript.
    expect(archive.messages.map((m) => m.content)).toEqual(session.messages.map((m) => m.content));
  });

  it('only completes the snapshot of the cone being frozen', async () => {
    const vfs = makeFakeVfs();
    const other = await seedLiveSnapshot(vfs, 'cone-research');

    const frozen = await freezeConeSession({ sessionStore: store, vfs, mode: 'quick' });

    expect(frozen?.filename).toMatch(/^pending-/);
    const entries = await readSessionsIndex(vfs as never);
    expect(entries.map((e) => [e.filename, e.live ?? false])).toEqual([
      [frozen?.filename, false],
      [other.entry.filename, true],
    ]);
  });

  it('renames the provisional live- name to the canonical form on enrichment', async () => {
    const vfs = makeFakeVfs();
    await seedLiveSnapshot(vfs);
    const frozen = await freezeConeSession({ sessionStore: store, vfs, mode: 'quick' });
    mockRunOneOffCompactionCall.mockResolvedValue('Build Fixed Twice');

    const updated = await enrichPendingSession(vfs, frozen!, {
      model: { id: 'm', provider: 'anthropic' } as never,
      apiKey: 'k',
      skipMemory: true,
      pickIcon: async () => null,
    });

    expect(updated?.filename).toMatch(/-build-fixed-twice\.md$/);
    expect(updated?.filename.startsWith('live-')).toBe(false);
    expect(updated?.sessionId).toBe(frozen?.sessionId);
    expect(vfs.files.has(`/sessions/${frozen?.filename}`)).toBe(false);
    expect(parseFrozenArchive(vfs.files.get(`/sessions/${updated?.filename}`)!).title).toBe(
      'Build Fixed Twice'
    );
  });

  it('rewrites every transcript pointer to the renamed archive path', async () => {
    const vfs = makeFakeVfs();
    const live = await seedLiveSnapshot(vfs);
    const livePath = live.transcriptPath;
    const pointerSentence = `The full transcript of the conversation before this compaction is saved at ${livePath} — read it when the summary is not enough.`;
    const sessionWithPointers: Session = {
      id: 'session-cone',
      createdAt: 1,
      updatedAt: 9,
      messages: [
        chat('user', `Earlier turns summarized.\n\n${pointerSentence}`, 1),
        {
          id: 'compaction-seam',
          role: 'assistant',
          content: '',
          timestamp: 2,
          compaction: {
            trigger: 'threshold',
            state: 'summarized',
            transcriptPath: livePath,
          },
        },
        chat('user', 'follow-up after compaction', 3),
        chat('assistant', 'reply after compaction', 4),
        chat('user', 'another follow-up', 5),
      ],
    };
    const pointedStore = {
      async load() {
        return sessionWithPointers;
      },
    } as unknown as SessionStore;

    const frozen = await freezeConeSession({
      sessionStore: pointedStore,
      vfs,
      mode: 'quick',
    });
    expect(frozen?.filename).toBe(live.entry.filename);
    // Freeze keeps the provisional name — pointers still resolve to the live file.
    expect(vfs.files.has(livePath)).toBe(true);
    mockRunOneOffCompactionCall.mockResolvedValue('Pointer Rewrite');

    const updated = await enrichPendingSession(vfs, frozen!, {
      model: { id: 'm', provider: 'anthropic' } as never,
      apiKey: 'k',
      skipMemory: true,
      pickIcon: async () => null,
    });

    const newPath = `/sessions/${updated!.filename}`;
    expect(vfs.files.has(livePath)).toBe(false);
    expect(vfs.files.has(newPath)).toBe(true);

    const raw = vfs.files.get(newPath)!;
    expect(raw).not.toContain(livePath);
    expect(raw).toContain(newPath);

    const archive = parseFrozenArchive(raw);
    const summary = archive.messages.find((m) => m.content.includes('Earlier turns summarized'));
    expect(summary?.content).toContain(`saved at ${newPath}`);
    expect(summary?.content).not.toContain(livePath);

    const markers = archive.messages.filter((m) => m.compaction?.transcriptPath);
    expect(markers).toHaveLength(1);
    expect(markers[0].compaction?.transcriptPath).toBe(newPath);
    // Acceptance: every pointer resolves to an existing file.
    for (const marker of markers) {
      expect(vfs.files.has(marker.compaction!.transcriptPath!)).toBe(true);
    }
    const pathMatches = [...raw.matchAll(/\/sessions\/[^\s"'<>]+/g)].map((m) => m[0]);
    for (const path of new Set(pathMatches)) {
      expect(vfs.files.has(path)).toBe(true);
    }
  });
});

describe('finalize after incremental curation', () => {
  async function seedFull(vfs: FakeVfs) {
    const result = await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone', label: 'sliccy' },
      messages: session.messages.map((message) =>
        agentText(message.role, message.content, message.timestamp)
      ),
      trigger: 'idle',
    });
    if (!result) throw new Error('snapshot skipped');
    return result;
  }

  it('mines only the tail "New chat" has not already curated', async () => {
    const vfs = makeFakeVfs();
    const live = await seedFull(vfs);
    await advanceCuratedThrough(vfs, live.entry.filename, 2);
    const spawn = vi.fn(async (_options: AgentSpawnOptions) => ({
      finalText: 'tail',
      exitCode: 0,
    }));
    const options = {
      sessionStore: store,
      vfs,
      mode: 'quick' as const,
      agenticMemorySpawn: spawn,
    };

    const frozen = await freezeConeSession(options);
    expect(frozen?.curatedThrough).toBe(2);
    const updated = await curateFrozenSessionMemories(options, frozen!);

    expect(spawn).toHaveBeenCalledOnce();
    const sessionId = frozen?.sessionId;
    if (!sessionId) throw new Error('missing session id');
    const deltaPath = liveDeltaArchivePath(sessionId, 2, 5);
    const call = spawn.mock.calls[0];
    if (!call) throw new Error('expected a curator spawn');
    expect(call[0].prompt).toContain(deltaPath);
    expect(
      parseFrozenArchive(vfs.files.get(deltaPath)!).messages.map((message) => message.content)
    ).toEqual(['second question', 'second answer', 'third question']);
    expect(updated?.memoryPending).toBeUndefined();
    expect(updated?.memoryCuratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated?.curatedThrough).toBe(5);
  });

  it('keeps curatedThrough across the title rename that runs before curation', async () => {
    const vfs = makeFakeVfs();
    const live = await seedFull(vfs);
    await advanceCuratedThrough(vfs, live.entry.filename, 2);
    const frozen = await freezeConeSession({ sessionStore: store, vfs, mode: 'quick' });
    mockRunOneOffCompactionCall.mockResolvedValue('Renamed After Cursor');

    const updated = await enrichPendingSession(vfs, frozen!, {
      model: { id: 'm', provider: 'anthropic' } as never,
      apiKey: 'k',
      skipMemory: true,
      pickIcon: async () => null,
    });

    expect(updated?.curatedThrough).toBe(2);
    expect(updated?.filename.startsWith('live-')).toBe(false);
    const renamed = vfs.files.get(`/sessions/${updated?.filename}`);
    expect(String(renamed)).toContain('curatedThrough: 2');
  });

  it('does not spawn when the cursor already covers the frozen chat', async () => {
    const vfs = makeFakeVfs();
    const live = await seedFull(vfs);
    await advanceCuratedThrough(vfs, live.entry.filename, 5);
    const spawn = vi.fn(async () => ({ finalText: 'nope', exitCode: 0 }));
    const options = {
      sessionStore: store,
      vfs,
      mode: 'quick' as const,
      agenticMemorySpawn: spawn,
    };

    const frozen = await freezeConeSession(options);
    const updated = await curateFrozenSessionMemories(options, frozen!);

    expect(spawn).not.toHaveBeenCalled();
    expect(updated?.memoryPending).toBeUndefined();
    expect(updated?.curatedThrough).toBe(5);
    expect(updated?.memoryCuratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
