/**
 * The archive writer is shared by the page-side freezer and the worker-side
 * compaction snapshot, so its document must round-trip through the reader
 * and its index primitives must be safe to call from either realm.
 */
import { describe, expect, it } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  type FrozenSessionIndexEntry,
  parseFrozenArchive,
  readSessionsIndex,
  SESSIONS_INDEX_PATH,
} from '../../src/transcript/frozen-archive-format.js';
import {
  type ArchiveVfs,
  discardLiveSnapshot,
  findLiveSnapshotEntry,
  formatArchiveAsMarkdown,
  heuristicTitle,
  isDraftArchiveFilename,
  liveSnapshotFilename,
  readSessionsIndexForWrite,
  removeSessionsIndexEntries,
  serializeIndexWrite,
  slugify,
  upsertSessionsIndexEntry,
} from '../../src/transcript/frozen-archive-writer.js';

function fakeVfs(): ArchiveVfs & { files: Map<string, string>; flushes: number } {
  const files = new Map<string, string>();
  const vfs = {
    files,
    flushes: 0,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return files.get(path)!;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async mkdir(): Promise<void> {},
    async rm(path: string): Promise<void> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      files.delete(path);
    },
    async flush(): Promise<void> {
      vfs.flushes++;
    },
  };
  return vfs;
}

const user: ChatMessage = { id: 'u1', role: 'user', content: 'fix "the" build', timestamp: 1 };
const assistant: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'done',
  timestamp: 2,
  toolCalls: [{ id: 't1', name: 'bash', input: { cmd: 'npm test' }, result: 'ok' }],
};

describe('formatArchiveAsMarkdown', () => {
  it('round-trips messages, provenance and the live marker through parseFrozenArchive', () => {
    const markdown = formatArchiveAsMarkdown({
      id: 'sid',
      title: 'Fix "the" build',
      frozenAt: '2026-09-02T10:00:00.000Z',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      messages: [user, assistant],
      cone: 'cone-research',
      coneLabel: 'Research',
      live: true,
    });
    expect(markdown).toMatch(/^---\nid: sid\n/);
    expect(markdown).toContain('live: true\n');
    expect(markdown).toContain('## User\nfix "the" build');
    const parsed = parseFrozenArchive(markdown);
    expect(parsed.title).toBe('Fix "the" build');
    expect(parsed.live).toBe(true);
    expect(parsed.cone).toBe('cone-research');
    expect(parsed.coneLabel).toBe('Research');
    expect(parsed.messages).toEqual([user, assistant]);
  });

  it('omits the live marker on a finished archive', () => {
    const markdown = formatArchiveAsMarkdown({
      id: 'sid',
      title: 't',
      frozenAt: 'now',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      messages: [user],
    });
    expect(markdown).not.toContain('live:');
    expect(parseFrozenArchive(markdown).live).toBeUndefined();
  });
});

describe('naming helpers', () => {
  it('treats pending- and live- names as provisional drafts, canonical names as final', () => {
    expect(isDraftArchiveFilename('pending-abc.md')).toBe(true);
    expect(isDraftArchiveFilename(liveSnapshotFilename('cone-research'))).toBe(true);
    expect(isDraftArchiveFilename('2026-09-02T10-00-00-000Z-fix-build.md')).toBe(false);
  });

  it('derives a live filename from the cone folder', () => {
    expect(liveSnapshotFilename('cone-research')).toMatch(
      /^live-cone-research-[a-z0-9]+-[a-z0-9]+\.md$/
    );
  });

  it('slugifies and titles from the first user message', () => {
    expect(slugify('Fix the Build!!')).toBe('fix-the-build');
    expect(slugify('')).toBe('session');
    expect(heuristicTitle([assistant, user])).toBe('fix "the" build');
    expect(heuristicTitle([assistant])).toBe('untitled-session');
    expect(heuristicTitle([{ ...user, content: 'x'.repeat(80) }])).toBe(`${'x'.repeat(60)}…`);
  });

  it('finds a cone’s live entry, defaulting a missing cone field to the primary cone', () => {
    const entries: FrozenSessionIndexEntry[] = [
      { filename: 'a.md', title: 'a', frozenAt: '', messageCount: 0, live: true },
      { filename: 'b.md', title: 'b', frozenAt: '', messageCount: 0, live: true, cone: 'cone-x' },
      { filename: 'c.md', title: 'c', frozenAt: '', messageCount: 0, cone: 'cone-x' },
    ];
    expect(findLiveSnapshotEntry(entries, 'cone')?.filename).toBe('a.md');
    expect(findLiveSnapshotEntry(entries, 'cone-x')?.filename).toBe('b.md');
    expect(findLiveSnapshotEntry(entries, 'cone-y')).toBeUndefined();
  });
});

describe('index primitives', () => {
  const entry = (filename: string, extra: Partial<FrozenSessionIndexEntry> = {}) => ({
    filename,
    title: filename,
    frozenAt: '',
    messageCount: 0,
    ...extra,
  });

  it('upserts newest-first and replaces a row with the same filename', async () => {
    const vfs = fakeVfs();
    await upsertSessionsIndexEntry(vfs, entry('one.md'));
    await upsertSessionsIndexEntry(vfs, entry('two.md'));
    await upsertSessionsIndexEntry(vfs, entry('one.md', { title: 'renamed' }));
    expect((await readSessionsIndex(vfs as never)).map((e) => [e.filename, e.title])).toEqual([
      ['one.md', 'renamed'],
      ['two.md', 'two.md'],
    ]);
  });

  it('reads a missing index as empty but propagates any other fault', async () => {
    const vfs = fakeVfs();
    expect(await readSessionsIndexForWrite(vfs)).toEqual([]);
    vfs.readFile = async () => {
      throw new FsError('EIO', 'disk on fire', SESSIONS_INDEX_PATH);
    };
    await expect(readSessionsIndexForWrite(vfs)).rejects.toThrow('disk on fire');
    await expect(upsertSessionsIndexEntry(vfs, entry('x.md'))).rejects.toThrow('disk on fire');
  });

  it('removes matching rows and returns them; a no-match leaves the file untouched', async () => {
    const vfs = fakeVfs();
    await upsertSessionsIndexEntry(vfs, entry('keep.md'));
    await upsertSessionsIndexEntry(vfs, entry('drop.md', { live: true }));
    const before = vfs.files.get(SESSIONS_INDEX_PATH);
    expect(await removeSessionsIndexEntries(vfs, (e) => e.filename === 'nope.md')).toEqual([]);
    expect(vfs.files.get(SESSIONS_INDEX_PATH)).toBe(before);
    const removed = await removeSessionsIndexEntries(vfs, (e) => e.live === true);
    expect(removed.map((e) => e.filename)).toEqual(['drop.md']);
    expect((await readSessionsIndex(vfs as never)).map((e) => e.filename)).toEqual(['keep.md']);
  });

  it('discardLiveSnapshot deletes the cone’s live archive and row, tolerating a missing file', async () => {
    const vfs = fakeVfs();
    await upsertSessionsIndexEntry(vfs, entry('done.md', { cone: 'cone' }));
    await upsertSessionsIndexEntry(vfs, entry('live-cone-1.md', { live: true, cone: 'cone' }));
    await upsertSessionsIndexEntry(vfs, entry('live-x-1.md', { live: true, cone: 'cone-x' }));
    vfs.files.set('/sessions/live-cone-1.md', 'archive');

    expect(await discardLiveSnapshot(vfs, 'cone')).toBe(1);
    expect(vfs.files.has('/sessions/live-cone-1.md')).toBe(false);
    expect((await readSessionsIndex(vfs as never)).map((e) => e.filename)).toEqual([
      'live-x-1.md',
      'done.md',
    ]);
    expect(vfs.flushes).toBe(1);
    // The other cone's snapshot, whose file was never written, still goes cleanly.
    expect(await discardLiveSnapshot(vfs, 'cone-x')).toBe(1);
    expect(await discardLiveSnapshot(vfs, 'cone-x')).toBe(0);
  });

  it('serializes index writes in arrival order and survives a failed writer', async () => {
    const order: string[] = [];
    const first = serializeIndexWrite(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first');
      throw new Error('boom');
    });
    const second = serializeIndexWrite(async () => {
      order.push('second');
      return 'ok';
    });
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });
});
