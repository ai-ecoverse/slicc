/**
 * The compaction snapshot ACCUMULATES: every round appends only what the
 * previous round has not written yet, so the kept tail is never duplicated
 * and the earlier summary shows up as a checkpoint in the transcript.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import {
  discardLiveSnapshot,
  finalizeLiveSnapshot,
  snapshotLiveSession,
} from '../../src/scoops/live-session-snapshot.js';
import {
  parseFrozenArchive,
  readSessionsIndex,
  SESSIONS_INDEX_PATH,
} from '../../src/transcript/frozen-archive-format.js';
import type { ArchiveVfs } from '../../src/transcript/frozen-archive-writer.js';

function fakeVfs(): ArchiveVfs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return files.get(path)!;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async mkdir(): Promise<void> {},
    async rm(path: string): Promise<void> {
      files.delete(path);
    },
    async flush(): Promise<void> {},
  };
}

const user = (text: string, timestamp: number): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp }) as AgentMessage;
const assistant = (text: string, timestamp: number): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
    stopReason: 'stop',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'm',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as unknown as AgentMessage;

async function indexOf(vfs: ArchiveVfs) {
  return readSessionsIndex(vfs as never);
}

/** A snapshot that must have been written (the common case in these tests). */
async function snap(
  deps: Parameters<typeof snapshotLiveSession>[0]
): Promise<NonNullable<Awaited<ReturnType<typeof snapshotLiveSession>>>> {
  const result = await snapshotLiveSession(deps);
  if (!result) throw new Error('snapshot was skipped');
  return result;
}

describe('snapshotLiveSession', () => {
  it('writes a live archive plus index row on the first round', async () => {
    const vfs = fakeVfs();
    const result = await snap({
      vfs,
      cone: { folder: 'cone', label: 'sliccy' },
      messages: [user('fix the build', 10), assistant('on it', 20)],
      trigger: 'threshold',
      now: () => 1_000,
    });

    expect(result.transcriptPath).toMatch(/^\/sessions\/live-cone-/);
    expect(result.appended).toBe(2);
    const [entry] = await indexOf(vfs);
    expect(entry).toMatchObject({
      filename: result.entry.filename,
      title: 'fix the build',
      cone: 'cone',
      live: true,
      liveThrough: 20,
      compactions: 1,
      messageCount: 2,
    });
    expect(entry.coneLabel).toBeUndefined();
    const archive = parseFrozenArchive(vfs.files.get(result.transcriptPath)!);
    expect(archive.live).toBe(true);
    expect(archive.messages.map((m) => m.content)).toEqual(['fix the build', 'on it']);
  });

  it('appends only messages newer than the cursor on later rounds, keeping identity', async () => {
    const vfs = fakeVfs();
    const first = await snap({
      vfs,
      cone: { folder: 'cone-research', label: 'Research' },
      messages: [user('q1', 10), assistant('a1', 20), user('q2', 30), assistant('a2', 40)],
      trigger: 'threshold',
    });
    // After round one the agent holds [summary(50), kept tail(30, 40)] and
    // the conversation continued.
    const second = await snap({
      vfs,
      cone: { folder: 'cone-research', label: 'Research' },
      messages: [
        user('<context-summary>…</context-summary>', 50),
        user('q2', 30),
        assistant('a2', 40),
        user('q3', 60),
        assistant('a3', 70),
      ],
      trigger: 'idle',
    });

    expect(second.transcriptPath).toBe(first.transcriptPath);
    expect(second.entry.sessionId).toBe(first.entry.sessionId);
    expect(second.appended).toBe(3);
    const entries = await indexOf(vfs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      live: true,
      liveThrough: 70,
      compactions: 2,
      messageCount: 7,
      cone: 'cone-research',
      coneLabel: 'Research',
      title: 'q1',
    });
    const archive = parseFrozenArchive(vfs.files.get(second.transcriptPath)!);
    expect(archive.messages.map((m) => m.content)).toEqual([
      'q1',
      'a1',
      'q2',
      'a2',
      '<context-summary>…</context-summary>',
      'q3',
      'a3',
    ]);
  });

  it('starts over from the agent history when the live archive went missing', async () => {
    const vfs = fakeVfs();
    const first = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q1', 10)],
      trigger: 'overflow',
    });
    vfs.files.delete(first.transcriptPath);
    const second = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q1', 10), assistant('a1', 20)],
      trigger: 'overflow',
    });
    expect(second.transcriptPath).toBe(first.transcriptPath);
    // The row survived without its file: the cursor is dropped and the whole
    // history the agent still holds is written, not just the newer message.
    expect(parseFrozenArchive(vfs.files.get(second.transcriptPath)!).messages).toHaveLength(2);
    expect(second.entry.liveThrough).toBe(20);
  });

  it('appends a same-millisecond message unless the archive already holds it', async () => {
    const vfs = fakeVfs();
    await snap({ vfs, cone: { folder: 'cone' }, messages: [user('q1', 10)], trigger: 'threshold' });
    // Round two: the summary was stamped in the same ms as a queued prompt.
    const second = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q1', 10), user('<context-summary/>', 10), user('q2', 10)],
      trigger: 'threshold',
    });
    expect(second.appended).toBe(2);
    expect(parseFrozenArchive(vfs.files.get(second.transcriptPath)!).messages).toHaveLength(3);
    // And a third round re-presenting all three adds nothing.
    const third = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q1', 10), user('<context-summary/>', 10), user('q2', 10)],
      trigger: 'threshold',
    });
    expect(third.appended).toBe(0);
  });

  it('derives the cursor from the archive when the index row lost it (rebuilt index)', async () => {
    const vfs = fakeVfs();
    const first = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q1', 10), assistant('a1', 20)],
      trigger: 'threshold',
    });
    const rows = await indexOf(vfs);
    const { liveThrough: _cursor, ...rebuilt } = rows[0];
    vfs.files.set(SESSIONS_INDEX_PATH, JSON.stringify([rebuilt]));
    const second = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('summary', 30), assistant('a1', 20), user('q2', 40)],
      trigger: 'idle',
    });
    expect(second.transcriptPath).toBe(first.transcriptPath);
    expect(second.appended).toBe(2);
    expect(parseFrozenArchive(vfs.files.get(second.transcriptPath)!).messages).toHaveLength(4);
  });

  it('writes nothing when stillValid says the session is gone', async () => {
    const vfs = fakeVfs();
    const result = await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q1', 10)],
      trigger: 'threshold',
      stillValid: () => false,
    });
    expect(result).toBeNull();
    expect(vfs.files.size).toBe(0);
  });

  it('runs the whole snapshot inside the shared index lock', async () => {
    const vfs = fakeVfs();
    const held: string[] = [];
    const locks = {
      async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        held.push(`enter:${name}`);
        try {
          return await callback();
        } finally {
          held.push(`exit:${name}`);
        }
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks },
    });
    try {
      await snap({
        vfs,
        cone: { folder: 'cone' },
        messages: [user('q1', 10)],
        trigger: 'threshold',
      });
    } finally {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
    // One lock acquisition for the entire read-modify-write, none nested.
    expect(held).toEqual(['enter:slicc:sessions-index', 'exit:slicc:sessions-index']);
  });

  it('keeps cones apart: one live snapshot per cone', async () => {
    const vfs = fakeVfs();
    await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('a', 1)],
      trigger: 'threshold',
    });
    await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone-x', label: 'X' },
      messages: [user('b', 1)],
      trigger: 'threshold',
    });
    const entries = await indexOf(vfs);
    expect(entries.map((e) => e.cone).sort()).toEqual(['cone', 'cone-x']);
    expect(entries.every((e) => e.live)).toBe(true);
  });
});

describe('finalizeLiveSnapshot', () => {
  it('turns the live row into a pending draft and strips the archive marker', async () => {
    const vfs = fakeVfs();
    const { transcriptPath, entry } = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q', 1)],
      trigger: 'threshold',
    });

    expect(await finalizeLiveSnapshot(vfs, 'cone')).toBe(true);
    const [row] = await indexOf(vfs);
    expect(row.filename).toBe(entry.filename);
    expect(row.live).toBeUndefined();
    expect(row.liveThrough).toBeUndefined();
    expect(row.pendingEnrichment).toBe(true);
    expect(row.compactions).toBe(1);
    const text = vfs.files.get(transcriptPath)!;
    expect(text).not.toContain('live: true');
    expect(text).toMatch(/^---\nid: /);
    expect(parseFrozenArchive(text).messages).toHaveLength(1);
    // Nothing left to finalize, and the next round starts a NEW snapshot.
    expect(await finalizeLiveSnapshot(vfs, 'cone')).toBe(false);
    const next = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('q', 1)],
      trigger: 'threshold',
    });
    expect(next.transcriptPath).not.toBe(transcriptPath);
  });

  it('is a no-op without an index', async () => {
    const vfs = fakeVfs();
    expect(await finalizeLiveSnapshot(vfs, 'cone')).toBe(false);
    expect(vfs.files.has(SESSIONS_INDEX_PATH)).toBe(false);
  });
});

describe('discardLiveSnapshot', () => {
  it('removes the cone’s live archive and row, leaving other cones alone', async () => {
    const vfs = fakeVfs();
    const mine = await snap({
      vfs,
      cone: { folder: 'cone' },
      messages: [user('a', 1)],
      trigger: 'idle',
    });
    const other = await snap({
      vfs,
      cone: { folder: 'cone-x', label: 'X' },
      messages: [user('b', 1)],
      trigger: 'idle',
    });
    expect(await discardLiveSnapshot(vfs, 'cone')).toBe(1);
    expect(vfs.files.has(mine.transcriptPath)).toBe(false);
    expect(vfs.files.has(other.transcriptPath)).toBe(true);
    expect((await indexOf(vfs)).map((e) => e.filename)).toEqual([other.entry.filename]);
    expect(await discardLiveSnapshot(vfs, 'cone')).toBe(0);
  });
});
