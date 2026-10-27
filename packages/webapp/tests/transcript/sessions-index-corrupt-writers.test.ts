/**
 * #4151: a write to a corrupt `/sessions/index.json` must not orphan every
 * other frozen session. Every whole-index writer takes its baseline from
 * `readSessionsIndexForWrite`, which rebuilds a present-but-unparsable index
 * from the `/sessions/*.md` archives instead of reading it as `[]`. Before
 * the fix the writer's own row replaced the file, the index parsed again,
 * and the rail's archive rebuild never ran.
 *
 * Runs over a real VirtualFS: the worker realm writes through it directly,
 * the page realm through an RPC client to the same store.
 */
import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../src/core/types.js';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { WritableVfsClient } from '../../src/kernel/writable-vfs-client.js';
import { stampCurationOutcome } from '../../src/scoops/live-session-curation.js';
import { scoopSessionsDir, snapshotLiveSession } from '../../src/scoops/live-session-snapshot.js';
import { mergeFoldedCostIntoLatestFrozen } from '../../src/scoops/merge-folded-cost-into-frozen.js';
import {
  type FrozenSessionIndexEntry,
  SESSIONS_INDEX_PATH,
} from '../../src/transcript/frozen-archive-format.js';
import {
  type ArchiveVfs,
  formatArchiveAsMarkdown,
  readSessionsIndexForWrite,
  readSessionsIndexState,
  rebuildSessionsIndexFromArchives,
  upsertSessionsIndexEntry,
} from '../../src/transcript/frozen-archive-writer.js';
import { deleteFrozenSession } from '../../src/ui/frozen-session-delete.js';
import { markSnapshotUnavailable } from '../../src/ui/session-freezer.js';

let dbCounter = 0;
let vfs: VirtualFS;
const page = (): WritableVfsClient => vfs as unknown as WritableVfsClient;

/** The store with its reads swapped out (fault injection). */
function withReads(reads: Partial<Pick<ArchiveVfs, 'readFile' | 'readDir'>>): ArchiveVfs {
  return {
    readFile: reads.readFile ?? ((path, options) => vfs.readFile(path, options)),
    readDir: reads.readDir ?? ((path) => vfs.readDir(path)),
    writeFile: (path, content) => vfs.writeFile(path, content),
    mkdir: async (path, options) => {
      await vfs.mkdir(path, options);
    },
    rm: (path, options) => vfs.rm(path, options),
    flush: () => vfs.flush(),
  };
}

const utf8 = { encoding: 'utf-8' } as const;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `sessions-index-corrupt-${dbCounter++}`, wipe: true });
});

/** The three finished sessions every case starts from, oldest first. */
const SESSIONS: FrozenSessionIndexEntry[] = ['a', 'b', 'c'].map((key, i) => ({
  filename: `2026-06-0${i + 1}T10-00-00-000Z-${key}.md`,
  sessionId: `sid-${key}`,
  title: `Session ${key}`,
  frozenAt: `2026-06-0${i + 1}T10:00:00.000Z`,
  messageCount: 2,
  cone: 'cone',
}));
const FILENAMES = SESSIONS.map((s) => s.filename);

async function writeArchive(entry: FrozenSessionIndexEntry, dir = '/sessions'): Promise<void> {
  await vfs.mkdir(dir, { recursive: true });
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

/** N archives on disk under an index cut off mid-write (a reload killed the worker). */
async function seedCorrupt(dir = '/sessions'): Promise<string> {
  for (const entry of SESSIONS) await writeArchive(entry, dir);
  const full = JSON.stringify(SESSIONS, null, 2);
  const truncated = full.slice(0, Math.floor(full.length / 2));
  await vfs.writeFile(`${dir}/index.json`, truncated);
  return truncated;
}

async function indexAt(path = SESSIONS_INDEX_PATH): Promise<FrozenSessionIndexEntry[]> {
  return JSON.parse((await vfs.readFile(path, utf8)) as string);
}

const names = (entries: readonly FrozenSessionIndexEntry[]): string[] =>
  entries.map((e) => e.filename).sort();

const agent = (role: 'user' | 'assistant', text: string, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }) as AgentMessage;

function foldedTurn(cost: number): AssistantMessage {
  return {
    role: 'assistant',
    model: 'claude-opus-4-6',
    timestamp: 1,
    usage: {
      input: 50,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  } as AssistantMessage;
}

describe('a corrupt sessions index survives one write from every writer', () => {
  it('upsert (a freeze) keeps every archived session listed', async () => {
    await seedCorrupt();
    const frozen: FrozenSessionIndexEntry = {
      filename: 'pending-new1.md',
      title: 'new chat',
      frozenAt: '2026-06-09T10:00:00.000Z',
      messageCount: 2,
      cone: 'cone',
    };
    await writeArchive(frozen);

    await upsertSessionsIndexEntry(page(), frozen);

    const after = await indexAt();
    expect(after[0]).toEqual(frozen);
    expect(names(after)).toEqual([...FILENAMES, frozen.filename].sort());
    expect(after.filter((e) => e.filename === frozen.filename)).toHaveLength(1);
  });

  it('a live snapshot (worker-realm compaction) keeps every archived session listed', async () => {
    await seedCorrupt();

    const result = await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone' },
      messages: [agent('user', 'still going', 10), agent('assistant', 'on it', 20)],
      trigger: 'threshold',
    });

    const after = await indexAt();
    expect(result).not.toBeNull();
    expect(after[0]).toMatchObject({ filename: result?.entry.filename, live: true });
    expect(names(after)).toEqual([...FILENAMES, result!.entry.filename].sort());
    expect((await readSessionsIndexState(vfs)).kind).toBe('ok');
  });

  it('a scoop snapshot rebuilds its own sandbox index, not the cone one', async () => {
    const dir = scoopSessionsDir('helper', 'jid-1');
    await seedCorrupt(dir);

    const result = await snapshotLiveSession({
      vfs,
      cone: { folder: 'helper' },
      messages: [agent('user', 'scoop work', 10)],
      trigger: 'threshold',
      sessionsDir: dir,
    });

    expect(names(await indexAt(`${dir}/index.json`))).toEqual(
      [...FILENAMES, result!.entry.filename].sort()
    );
  });

  it('a delete removes its session and keeps the others listed', async () => {
    await seedCorrupt();
    const [a, b, c] = SESSIONS;

    expect(await deleteFrozenSession(page(), { filename: b.filename })).toEqual({
      status: 'deleted',
    });

    expect(names(await indexAt())).toEqual([a.filename, c.filename].sort());
    await expect(vfs.stat(`/sessions/${b.filename}`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a folded-cost merge lands on the newest row and keeps the others listed', async () => {
    await seedCorrupt();

    expect(await mergeFoldedCostIntoLatestFrozen(vfs, { folder: 'cone' }, [foldedTurn(0.5)])).toBe(
      true
    );

    const after = await indexAt();
    expect(names(after)).toEqual([...FILENAMES].sort());
    const newest = after.find((e) => e.filename === SESSIONS[2].filename);
    expect(newest?.cost?.total).toBe(0.5);
  });

  it('ledger stamps land on the rebuilt row instead of no-opping', async () => {
    await seedCorrupt();
    const [a, b] = SESSIONS;

    await markSnapshotUnavailable(page(), a.filename);
    expect((await indexAt()).find((e) => e.filename === a.filename)).toMatchObject({
      completeSnapshotUnavailable: true,
    });

    await vfs.writeFile(SESSIONS_INDEX_PATH, '{"not": "an array"}');
    await stampCurationOutcome(vfs, b.filename, { ok: false, reason: 'timed out' });
    const after = await indexAt();
    expect(names(after)).toEqual([...FILENAMES].sort());
    expect(after.find((e) => e.filename === b.filename)?.memoryFailed).toBe('timed out');
  });
});

describe('what a writer heals a corrupt index into', () => {
  /** A curator run's transcript, written beside the frozen chats (agent-bridge). */
  const AGENT_TRANSCRIPT = '/sessions/agent-memory-curator-2026-06-04T10-00-00-000Z.md';

  it('leaves agent transcripts out: they share /sessions but are not sessions', async () => {
    await seedCorrupt();
    await vfs.writeFile(AGENT_TRANSCRIPT, '# Agent session: memory-curator\n\n- exit code: 0\n');

    const result = await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone' },
      messages: [agent('user', 'still going', 10)],
      trigger: 'threshold',
    });

    // Listed, it would read as a 0-turn session from 1970 that a rail
    // delete would remove.
    expect(names(await indexAt())).toEqual([...FILENAMES, result!.entry.filename].sort());
    expect(await vfs.readFile(AGENT_TRANSCRIPT, utf8)).toContain('memory-curator');
  });

  it('reads each archive once per snapshot round, not once per index read', async () => {
    await seedCorrupt();
    const reads = new Map<string, number>();
    const counting = withReads({
      readFile: (path, options) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return vfs.readFile(path, options);
      },
    });

    await snapshotLiveSession({
      vfs: counting,
      cone: { folder: 'cone' },
      messages: [agent('user', 'still going', 10)],
      trigger: 'threshold',
    });

    for (const filename of FILENAMES) expect(reads.get(`/sessions/${filename}`), filename).toBe(1);
    expect(names(await indexAt())).toHaveLength(FILENAMES.length + 1);
  });

  it('does not publish an unreadable live archive as a draft beside the new snapshot', async () => {
    await seedCorrupt();
    const stale = '/sessions/live-cone-old1.md';
    await vfs.writeFile(
      stale,
      formatArchiveAsMarkdown({
        id: 'session-cone',
        sessionId: 'sid-live',
        title: 'still going',
        frozenAt: '2026-06-05T10:00:00.000Z',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [{ id: 'u1', role: 'user', content: 'still going', timestamp: 1 }],
        cone: 'cone',
        live: true,
        liveThrough: 1,
      })
    );
    const flaky = withReads({
      readFile: async (path, options) => {
        if (path === stale) throw new FsError('EIO', 'bad block', path);
        return vfs.readFile(path, options);
      },
    });

    const result = await snapshotLiveSession({
      vfs: flaky,
      cone: { folder: 'cone' },
      messages: [agent('user', 'still going', 10), agent('assistant', 'on it', 20)],
      trigger: 'threshold',
    });

    const after = await indexAt();
    expect(names(after)).toEqual(
      [...FILENAMES, 'live-cone-old1.md', result!.entry.filename].sort()
    );
    // Still listed (its bytes are intact), but nothing enrichment may title
    // or a later compaction may resume into.
    expect(after.find((e) => e.filename === 'live-cone-old1.md')).toEqual({
      filename: 'live-cone-old1.md',
      title: 'live-cone-old1.md',
      frozenAt: new Date(0).toISOString(),
      messageCount: 0,
    });
    expect(after.filter((e) => e.live).map((e) => e.filename)).toEqual([result!.entry.filename]);
  });
});

describe('readSessionsIndexForWrite outside the corrupt case', () => {
  it('reads a missing index as empty: the first freeze writes one row', async () => {
    for (const entry of SESSIONS) await writeArchive(entry);
    expect(await readSessionsIndexForWrite(vfs)).toEqual([]);
    await upsertSessionsIndexEntry(page(), SESSIONS[0]);
    expect(await indexAt()).toEqual([SESSIONS[0]]);
  });

  it('takes a valid index verbatim, never the archives', async () => {
    for (const entry of SESSIONS) await writeArchive(entry);
    const only: FrozenSessionIndexEntry = { ...SESSIONS[0], icon: 'wrench' };
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify([only]));

    await upsertSessionsIndexEntry(page(), SESSIONS[1]);

    expect(await indexAt()).toEqual([SESSIONS[1], only]);
  });

  it('propagates a non-ENOENT index read fault and leaves the file alone', async () => {
    const corrupt = await seedCorrupt();
    const faulty = withReads({
      readFile: async (path) => {
        if (path === SESSIONS_INDEX_PATH) throw new FsError('EIO', 'disk on fire', path);
        return vfs.readFile(path, utf8);
      },
    });

    await expect(upsertSessionsIndexEntry(faulty, SESSIONS[0])).rejects.toThrow('disk on fire');
    expect(await vfs.readFile(SESSIONS_INDEX_PATH, utf8)).toBe(corrupt);
  });

  it('refuses to replace a corrupt index whose archives cannot be listed', async () => {
    const corrupt = await seedCorrupt();
    const unlistable = withReads({
      readDir: async (path) => {
        throw new FsError('EIO', 'listing failed', path);
      },
    });

    await expect(upsertSessionsIndexEntry(unlistable, SESSIONS[0])).rejects.toThrow(
      'listing failed'
    );
    // Still corrupt, so the rail's recovery (keyed on `corrupt`) still runs
    // and still finds every archive.
    expect(await vfs.readFile(SESSIONS_INDEX_PATH, utf8)).toBe(corrupt);
    expect((await readSessionsIndexState(vfs)).kind).toBe('corrupt');
    expect(names(await rebuildSessionsIndexFromArchives(vfs))).toEqual([...FILENAMES].sort());
  });
});

describe('rebuildSessionsIndexFromArchives', () => {
  it('keeps an unreadable archive as a placeholder row rather than orphaning it', async () => {
    await seedCorrupt();
    const [a, b] = SESSIONS;
    const flaky = withReads({
      readFile: async (path) => {
        if (path === `/sessions/${a.filename}`) throw new FsError('EIO', 'bad block', path);
        return vfs.readFile(path, utf8);
      },
    });

    const rebuilt = await rebuildSessionsIndexFromArchives(flaky);

    expect(names(rebuilt)).toEqual([...FILENAMES].sort());
    expect(rebuilt.find((e) => e.filename === a.filename)).toMatchObject({
      title: a.filename,
      messageCount: 0,
    });
    expect(rebuilt.find((e) => e.filename === b.filename)).toMatchObject({
      title: b.title,
      sessionId: b.sessionId,
    });
  });

  it('skips an archive that vanished mid-scan and lists nothing for a missing dir', async () => {
    expect(await rebuildSessionsIndexFromArchives(vfs, '/scoops/none/sessions/x')).toEqual([]);
    await seedCorrupt();
    const racing = withReads({
      readFile: async (path) => {
        if (path === `/sessions/${SESSIONS[0].filename}`) throw new FsError('ENOENT', 'gone', path);
        return vfs.readFile(path, utf8);
      },
    });

    expect(names(await rebuildSessionsIndexFromArchives(racing))).toEqual(
      [SESSIONS[1].filename, SESSIONS[2].filename].sort()
    );
  });
});

describe('one index write path', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const WRITER = join('transcript', 'frozen-archive-writer.ts');
  const INDEX_WRITE =
    /writeFile\(\s*(?:SESSIONS_INDEX_PATH\b|sessionsIndexPathFor\(|['"`]\/sessions\/index\.json|`[^`]*\/index\.json`)/;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('only writeSessionsIndexUnlocked writes a sessions index', () => {
    const files = sources(srcRoot);
    const writers = files.filter((file) => INDEX_WRITE.test(readFileSync(file, 'utf8')));
    // A new writer goes through writeSessionsIndexUnlocked with a baseline
    // from readSessionsIndexForWrite, or it reintroduces #4151.
    expect(writers.map((file) => relative(srcRoot, file))).toEqual([WRITER]);
  });
});
