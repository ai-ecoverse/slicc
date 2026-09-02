/**
 * "New chat" over a session whose compaction rounds already wrote a live
 * snapshot: save/skip COMPLETE that archive (same id, same file, `live` gone),
 * erase deletes it, and enrichment renames the provisional `live-` name like
 * any quick-freeze draft.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsError } from '../../src/fs/types.js';
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

import { enrichPendingSession, freezeConeSession } from '../../src/ui/session-freezer.js';

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
});
