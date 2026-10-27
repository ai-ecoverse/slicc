/**
 * Agent transcripts (`/sessions/agent-*.md`, written by the agent bridge)
 * share the directory with frozen chats but never the index. The rebuild
 * before #4152 listed them anyway, and an index it healed still holds those
 * rows (title = filename, 1970, 0 turns). No reader may treat one as a
 * session — a rail delete would remove the transcript — and the next
 * whole-index write drops them, leaving the files and every other row as
 * they were. Refs #4151.
 */
import 'fake-indexeddb/auto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { WritableVfsClient } from '../../src/kernel/writable-vfs-client.js';
import { readSessionCount } from '../../src/scoops/cone-memory-budget.js';
import { scoopSessionsDir, snapshotLiveSession } from '../../src/scoops/live-session-snapshot.js';
import { runMemoryHealthCheck } from '../../src/scoops/memory-health.js';
import {
  type FrozenSessionIndexEntry,
  frozenSessionRows,
  readSessionsIndex,
  SESSIONS_INDEX_PATH,
} from '../../src/transcript/frozen-archive-format.js';
import {
  formatArchiveAsMarkdown,
  readSessionsIndexForWrite,
  upsertSessionsIndexEntry,
} from '../../src/transcript/frozen-archive-writer.js';
import { readIndexForPresence } from '../../src/transcript/frozen-session-identity.js';
import {
  deleteFrozenSession,
  findIndexedFrozenRow,
  removeCuratorByproducts,
  removeFrozenSessionArtifacts,
} from '../../src/ui/frozen-session-delete.js';
import { listPendingEnrichments } from '../../src/ui/session-freezer.js';

let dbCounter = 0;
let vfs: VirtualFS;
const page = (): WritableVfsClient => vfs as unknown as WritableVfsClient;
const utf8 = { encoding: 'utf-8' } as const;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `sessions-index-agent-rows-${dbCounter++}`, wipe: true });
});

const AGENT_FILE = 'agent-memory-curator-2026-06-04T10-00-00-000Z.md';
const TRANSCRIPT = '# Agent session: memory-curator\n\n- exit code: 0\n';

/** The row the old corrupt-index rebuild made for an agent transcript. */
const STALE_AGENT_ROW: FrozenSessionIndexEntry = {
  filename: AGENT_FILE,
  title: AGENT_FILE,
  frozenAt: new Date(0).toISOString(),
  messageCount: 0,
};

/** Three finished chats, newest first; one carries an icon, one a cost. */
const SESSIONS: FrozenSessionIndexEntry[] = [
  {
    filename: '2026-06-03T10-00-00-000Z-c.md',
    sessionId: 'sid-c',
    title: 'Session c',
    frozenAt: '2026-06-03T10:00:00.000Z',
    messageCount: 2,
    cone: 'cone',
    icon: 'wrench',
  },
  {
    filename: '2026-06-02T10-00-00-000Z-b.md',
    sessionId: 'sid-b',
    title: 'Session b',
    frozenAt: '2026-06-02T10:00:00.000Z',
    messageCount: 2,
    cone: 'cone',
    memoryCuratedAt: '2026-06-02T11:00:00.000Z',
  },
  {
    filename: '2026-06-01T10-00-00-000Z-a.md',
    sessionId: 'sid-a',
    title: 'Session a',
    frozenAt: '2026-06-01T10:00:00.000Z',
    messageCount: 2,
    cone: 'cone',
    cost: { total: 0.25, input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0 },
  },
];

async function writeArchive(entry: FrozenSessionIndexEntry, dir: string): Promise<void> {
  await vfs.writeFile(
    `${dir}/${entry.filename}`,
    formatArchiveAsMarkdown({
      id: 'session-cone',
      sessionId: entry.sessionId,
      title: entry.title,
      frozenAt: entry.frozenAt,
      createdAt: 1,
      updatedAt: 2,
      messageCount: entry.messageCount,
      messages: [
        { id: 'u1', role: 'user', content: `ask ${entry.title}`, timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'done', timestamp: 2 },
      ],
      cone: entry.cone,
    })
  );
}

/** Archives + the agent transcript on disk, under an index the old rebuild healed. */
async function seedHealedIndex(dir = '/sessions'): Promise<string> {
  await vfs.mkdir(dir, { recursive: true });
  for (const entry of SESSIONS) await writeArchive(entry, dir);
  await vfs.writeFile(`${dir}/${AGENT_FILE}`, TRANSCRIPT);
  const index = JSON.stringify([SESSIONS[0], STALE_AGENT_ROW, SESSIONS[1], SESSIONS[2]], null, 2);
  await vfs.writeFile(`${dir}/index.json`, index);
  return index;
}

async function indexAt(path = SESSIONS_INDEX_PATH): Promise<FrozenSessionIndexEntry[]> {
  return JSON.parse((await vfs.readFile(path, utf8)) as string);
}

const agentMessage = (role: 'user' | 'assistant', text: string, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }) as AgentMessage;

describe('a rail delete of an agent-transcript row', () => {
  it('is refused, and the transcript and the index stay as they were', async () => {
    const index = await seedHealedIndex();

    expect(await deleteFrozenSession(page(), { filename: AGENT_FILE })).toEqual({
      status: 'not-found',
    });

    expect(await vfs.readFile(`/sessions/${AGENT_FILE}`, utf8)).toBe(TRANSCRIPT);
    expect(await vfs.readFile(SESSIONS_INDEX_PATH, utf8)).toBe(index);
  });

  it('cannot reach the transcript through the artifact sweeps either', async () => {
    await seedHealedIndex();
    await vfs.mkdir(`/sessions/.curation/${AGENT_FILE}`, { recursive: true });
    await vfs.writeFile(`/sessions/.curation/${AGENT_FILE}/status.json`, '{}');

    for (const errors of [
      await removeFrozenSessionArtifacts(page(), STALE_AGENT_ROW, SESSIONS),
      await removeCuratorByproducts(page(), STALE_AGENT_ROW, SESSIONS),
    ]) {
      expect(errors).toEqual([`unsafe archive name: ${AGENT_FILE}`]);
    }

    expect(await vfs.readFile(`/sessions/${AGENT_FILE}`, utf8)).toBe(TRANSCRIPT);
    expect(await vfs.readFile(`/sessions/.curation/${AGENT_FILE}/status.json`, utf8)).toBe('{}');
  });

  it('still deletes a frozen chat listed beside it', async () => {
    await seedHealedIndex();
    const [c, b, a] = SESSIONS;

    expect(await deleteFrozenSession(page(), { filename: b.filename })).toEqual({
      status: 'deleted',
    });

    expect(await indexAt()).toEqual([c, a]);
    expect(await vfs.readFile(`/sessions/${AGENT_FILE}`, utf8)).toBe(TRANSCRIPT);
  });
});

describe('the next index write', () => {
  it('drops the agent row, keeps the transcript, and leaves every other row unchanged', async () => {
    await seedHealedIndex();
    const frozen: FrozenSessionIndexEntry = {
      filename: 'pending-new1.md',
      title: 'new chat',
      frozenAt: '2026-06-09T10:00:00.000Z',
      messageCount: 2,
      cone: 'cone',
    };

    await upsertSessionsIndexEntry(page(), frozen);

    expect(await indexAt()).toEqual([frozen, ...SESSIONS]);
    expect(await vfs.readFile(`/sessions/${AGENT_FILE}`, utf8)).toBe(TRANSCRIPT);
  });

  it('cleans a scoop sandbox index the same way', async () => {
    const dir = scoopSessionsDir('helper', 'jid-1');
    await seedHealedIndex(dir);

    const result = await snapshotLiveSession({
      vfs,
      cone: { folder: 'helper' },
      messages: [agentMessage('user', 'scoop work', 10)],
      trigger: 'threshold',
      sessionsDir: dir,
    });

    const after = await indexAt(`${dir}/index.json`);
    expect(after[0]).toMatchObject({ filename: result?.entry.filename, live: true });
    expect(after.slice(1)).toEqual(SESSIONS);
    expect(await vfs.readFile(`${dir}/${AGENT_FILE}`, utf8)).toBe(TRANSCRIPT);
  });
});

describe('every other index reader', () => {
  it('leaves the agent row out', async () => {
    await seedHealedIndex();

    // The writers' baseline, the presence oracle, and the shared reader
    // behind enrichment catch-up, search, transcript and profile export,
    // the cost command and `memory status`.
    expect(await readSessionsIndexForWrite(vfs)).toEqual(SESSIONS);
    expect(await readIndexForPresence(vfs)).toEqual(SESSIONS);
    expect(await readSessionsIndex(vfs)).toEqual(SESSIONS);
    expect(await findIndexedFrozenRow(page(), { filename: AGENT_FILE })).toEqual({
      kind: 'absent',
      entries: SESSIONS,
    });
    // The memory budget and the scheduled health check count sessions.
    expect(await readSessionCount(vfs)).toBe(SESSIONS.length);
    expect((await runMemoryHealthCheck(vfs)).sessions).toBe(SESSIONS.length);
  });

  it('never hands one to the pending catch-up', async () => {
    await vfs.mkdir('/sessions', { recursive: true });
    await vfs.writeFile(
      SESSIONS_INDEX_PATH,
      JSON.stringify([{ ...STALE_AGENT_ROW, pendingEnrichment: true, memoryPending: true }])
    );

    expect(await listPendingEnrichments(vfs)).toEqual([]);
  });
});

describe('frozenSessionRows', () => {
  it('drops only agent-transcript rows and passes malformed rows through', () => {
    const odd = [null, 7, { title: 'no filename' }, { filename: 42 }];
    expect(frozenSessionRows([...odd, STALE_AGENT_ROW, SESSIONS[0]])).toEqual([
      ...odd,
      SESSIONS[0],
    ]);
  });
});
