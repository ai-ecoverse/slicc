import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { WritableVfsClient } from '../../src/kernel/writable-vfs-client.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import type { FrozenSessionIndexEntry } from '../../src/transcript/frozen-archive-format.js';
import { formatArchiveAsMarkdown } from '../../src/transcript/frozen-archive-writer.js';
import {
  deleteFrozenSession,
  findIndexedFrozenRow,
  removeCuratorByproducts,
} from '../../src/ui/frozen-session-delete.js';

let dbCounter = 0;
let vfs: VirtualFS;
const w = (): WritableVfsClient => vfs as unknown as WritableVfsClient;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `frozen-session-delete-${dbCounter++}`, wipe: true });
});

async function put(path: string, content: string): Promise<void> {
  await vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.writeFile(path, content);
}

const exists = (path: string): Promise<boolean> =>
  vfs.stat(path).then(
    () => true,
    () => false
  );

async function index(): Promise<FrozenSessionIndexEntry[]> {
  return JSON.parse((await vfs.readFile('/sessions/index.json', { encoding: 'utf-8' })) as string);
}

function row(
  filename: string,
  sessionId?: string,
  extra: Partial<FrozenSessionIndexEntry> = {}
): FrozenSessionIndexEntry {
  return {
    filename,
    title: filename,
    frozenAt: '2026-06-01T10:00:00.000Z',
    messageCount: 2,
    ...(sessionId ? { sessionId } : {}),
    ...extra,
  };
}

async function seedSession(
  entry: FrozenSessionIndexEntry,
  attachmentKey = entry.filename.slice(0, -3)
): Promise<string[]> {
  const attachmentPath = `/sessions/attachments/${attachmentKey}/0-shot.png`;
  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: 'fix the build',
      timestamp: 1,
      attachments: [
        {
          id: 'a1',
          name: 'shot.png',
          mimeType: 'image/png',
          size: 3,
          kind: 'file',
          path: attachmentPath,
        },
      ],
    },
    { id: 'a2', role: 'assistant', content: 'done', timestamp: 2 },
  ];
  const archive = `/sessions/${entry.filename}`;
  const owned = [
    archive,
    `/sessions/${entry.filename.slice(0, -3)}.jsonl`,
    attachmentPath,
    `/sessions/.curated/${entry.filename}`,
    `/sessions/.curation/${entry.filename}/status.json`,
  ];
  if (entry.sessionId) {
    owned.push(
      `/sessions/data/${entry.sessionId}/document.json`,
      `/sessions/data/.tmp-${entry.sessionId}/document.json`,
      `/sessions/.live-deltas/${entry.sessionId}-0-5.md`,
      `/sessions/.curated/${entry.sessionId}-0-5.md`,
      `/sessions/.curation/${entry.sessionId}-0-5.md/status.json`
    );
  }
  for (const path of owned.slice(1)) await put(path, 'x');
  await put(
    archive,
    formatArchiveAsMarkdown({
      id: 'session-cone',
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      attachmentsKey: attachmentKey,
      title: entry.title,
      frozenAt: entry.frozenAt,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      messages,
    })
  );
  return owned;
}

describe('deleteFrozenSession', () => {
  it('removes every file the session owns, then its row; a sibling is untouched', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    const b = row('2026-06-02T10-00-00-000Z-b.md', 'sid-b');

    const ownedA = await seedSession(a, 'pending-aaa111');
    const ownedB = await seedSession(b);
    await put('/sessions/index.json', JSON.stringify([b, a]));
    await put('/sessions/.search-index.json', '{}');

    expect(await deleteFrozenSession(w(), { filename: a.filename, sessionId: 'sid-a' })).toEqual({
      status: 'deleted',
    });

    for (const path of ownedA) expect(await exists(path), path).toBe(false);
    for (const dir of ['/sessions/attachments/pending-aaa111', '/sessions/data/sid-a']) {
      expect(await exists(dir), dir).toBe(false);
    }
    for (const path of ownedB) expect(await exists(path), path).toBe(true);
    expect((await index()).map((e) => e.filename)).toEqual([b.filename]);
    expect(await exists('/sessions/.search-index.json')).toBe(false);
  });

  it('refuses a live row and touches nothing', async () => {
    const live = row('live-cone-x1.md', 'sid-l', { live: true });
    const owned = await seedSession(live);
    await put('/sessions/index.json', JSON.stringify([live]));

    expect(await deleteFrozenSession(w(), { filename: live.filename })).toEqual({ status: 'live' });
    for (const path of owned) expect(await exists(path), path).toBe(true);
    expect(await index()).toHaveLength(1);
  });

  it('refuses a row whose filename escapes /sessions', async () => {
    await put('/shared/CLAUDE.md', 'precious');
    const evil = row('../shared/CLAUDE.md', 'sid-e');
    await put('/sessions/index.json', JSON.stringify([evil]));

    expect(await deleteFrozenSession(w(), { filename: evil.filename })).toEqual({
      status: 'unsafe',
    });
    expect(await exists('/shared/CLAUDE.md')).toBe(true);
    expect(await index()).toHaveLength(1);
  });

  it('reports not-found for an unknown key', async () => {
    await put('/sessions/index.json', JSON.stringify([row('a.md', 'sid-a')]));
    expect(await deleteFrozenSession(w(), { filename: 'gone.md' })).toEqual({
      status: 'not-found',
    });
  });

  it('follows an enrichment rename through the unique sessionId', async () => {
    const renamed = row('2026-06-01T10-00-00-000Z-real-title.md', 'sid-r');
    await seedSession(renamed);
    await put('/sessions/index.json', JSON.stringify([renamed]));

    expect(
      await deleteFrozenSession(w(), { filename: 'pending-r1.md', sessionId: 'sid-r' })
    ).toEqual({ status: 'deleted' });
    expect(await index()).toEqual([]);
    expect(await exists(`/sessions/${renamed.filename}`)).toBe(false);
  });

  it('never derives paths from a sessionId two rows share (#3807)', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'session-cone');
    const b = row('2026-06-02T10-00-00-000Z-b.md', 'session-cone');
    await seedSession(a);
    await put('/sessions/index.json', JSON.stringify([b, a]));

    expect(await deleteFrozenSession(w(), { filename: a.filename })).toEqual({ status: 'deleted' });
    expect(await exists(`/sessions/${a.filename}`)).toBe(false);
    expect(await exists('/sessions/data/session-cone/document.json')).toBe(true);
    expect(await exists('/sessions/.live-deltas/session-cone-0-5.md')).toBe(true);
    expect((await index()).map((e) => e.filename)).toEqual([b.filename]);
  });

  it('treats files already gone as done', async () => {
    const bare = row('2026-06-01T10-00-00-000Z-bare.md', 'sid-bare');
    await put('/sessions/index.json', JSON.stringify([bare]));
    expect(await deleteFrozenSession(w(), { filename: bare.filename })).toEqual({
      status: 'deleted',
    });
    expect(await index()).toEqual([]);
  });

  it('keeps the row when a removal fails, so a retry can finish the job', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    await seedSession(a);
    await put('/sessions/index.json', JSON.stringify([a]));
    const flaky = new Proxy(vfs, {
      get(target, prop) {
        if (prop === 'rm') {
          return async (path: string, options?: { recursive?: boolean }) => {
            if (path === `/sessions/${a.filename}`) {
              throw Object.assign(new Error('EIO: disk'), { code: 'EIO' });
            }
            return target.rm(path, options);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as WritableVfsClient;

    const failed = await deleteFrozenSession(flaky, { filename: a.filename });
    expect(failed.status).toBe('failed');
    expect(await index()).toHaveLength(1);

    expect(await deleteFrozenSession(w(), { filename: a.filename })).toEqual({ status: 'deleted' });
    expect(await index()).toEqual([]);
  });
});

describe('deleteFrozenSession — partial failure', () => {
  it('keeps the archive while an attachment dir resists, so the retry still finds it', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    await seedSession(a, 'pending-aaa111');
    await put('/sessions/index.json', JSON.stringify([a]));
    const flaky = new Proxy(vfs, {
      get(target, prop) {
        if (prop === 'rm') {
          return async (path: string, options?: { recursive?: boolean }) => {
            if (path === '/sessions/attachments/pending-aaa111') {
              throw Object.assign(new Error('EIO: disk'), { code: 'EIO' });
            }
            return target.rm(path, options);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as WritableVfsClient;

    expect((await deleteFrozenSession(flaky, { filename: a.filename })).status).toBe('failed');
    expect(await exists(`/sessions/${a.filename}`)).toBe(true);
    expect(await exists('/sessions/attachments/pending-aaa111/0-shot.png')).toBe(true);

    expect(await deleteFrozenSession(w(), { filename: a.filename })).toEqual({ status: 'deleted' });
    expect(await exists('/sessions/attachments/pending-aaa111')).toBe(false);
    expect(await exists(`/sessions/${a.filename}`)).toBe(false);
  });
});

describe('deleteFrozenSession — attachment dir ownership (#3807-adjacent)', () => {
  it("never deletes a sibling session's attachment dir just because a message points into it", async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    const b = row('2026-06-02T10-00-00-000Z-b.md', 'sid-b');
    const bAttachment = `/sessions/attachments/${b.filename.slice(0, -3)}/0-shot.png`;
    await put(bAttachment, 'b-owns-this');

    const aAttachmentsKey = a.filename.slice(0, -3);
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'reuse that screenshot',
        timestamp: 1,
        attachments: [
          {
            id: 'a1',
            name: 'shot.png',
            mimeType: 'image/png',
            size: 3,
            kind: 'file',
            path: bAttachment,
          },
        ],
      },
    ];
    await put(
      `/sessions/${a.filename}`,
      formatArchiveAsMarkdown({
        id: 'session-cone',
        sessionId: a.sessionId,
        attachmentsKey: aAttachmentsKey,
        title: a.title,
        frozenAt: a.frozenAt,
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages,
      })
    );
    await put('/sessions/index.json', JSON.stringify([b, a]));

    expect(await deleteFrozenSession(w(), { filename: a.filename, sessionId: 'sid-a' })).toEqual({
      status: 'deleted',
    });
    expect(await exists(bAttachment)).toBe(true);
  });

  it('a legacy archive without attachmentsKey deletes only its own current-base dir', async () => {
    const legacy = row('2026-06-01T10-00-00-000Z-legacy.md', 'sid-legacy');
    const draftDir = '/sessions/attachments/pending-zzz999';
    await put(`${draftDir}/0-shot.png`, 'draft-owned');
    const ownDir = `/sessions/attachments/${legacy.filename.slice(0, -3)}`;
    await put(`${ownDir}/0-shot.png`, 'own');

    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'reuse that screenshot',
        timestamp: 1,
        attachments: [
          {
            id: 'a1',
            name: 'shot.png',
            mimeType: 'image/png',
            size: 3,
            kind: 'file',
            path: `${draftDir}/0-shot.png`,
          },
        ],
      },
    ];
    await put(
      `/sessions/${legacy.filename}`,
      formatArchiveAsMarkdown({
        id: 'session-cone',
        sessionId: legacy.sessionId,
        title: legacy.title,
        frozenAt: legacy.frozenAt,
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages,
      })
    );
    await put('/sessions/index.json', JSON.stringify([legacy]));

    expect(await deleteFrozenSession(w(), { filename: legacy.filename })).toEqual({
      status: 'deleted',
    });
    expect(await exists(`${ownDir}/0-shot.png`)).toBe(false);
    expect(await exists(`${draftDir}/0-shot.png`)).toBe(true);
  });
});

describe('findIndexedFrozenRow', () => {
  it('present / absent from a well-formed index; unknown when it cannot say', async () => {
    const a = row('a.md', 'sid-a');
    expect(await findIndexedFrozenRow(w(), { filename: 'a.md' })).toEqual({ kind: 'unknown' });
    await put('/sessions/index.json', JSON.stringify([a]));
    expect(await findIndexedFrozenRow(w(), { filename: 'a.md' })).toEqual({
      kind: 'present',
      row: a,
    });
    expect(await findIndexedFrozenRow(w(), { filename: 'b.md' })).toEqual({
      kind: 'absent',
      entries: [a],
    });
    await put('/sessions/index.json', '[{"filename": trunc');
    expect(await findIndexedFrozenRow(w(), { filename: 'a.md' })).toEqual({ kind: 'unknown' });
  });
});

describe('removeCuratorByproducts', () => {
  it('sweeps deltas, receipts and per-pass state but never the archive', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    await seedSession(a);

    expect(await removeCuratorByproducts(w(), a, [])).toEqual([]);
    expect(await exists(`/sessions/${a.filename}`)).toBe(true);
    for (const path of [
      '/sessions/.live-deltas/sid-a-0-5.md',
      '/sessions/.curated/sid-a-0-5.md',
      '/sessions/.curation/sid-a-0-5.md',
      `/sessions/.curated/${a.filename}`,
      `/sessions/.curation/${a.filename}`,
    ]) {
      expect(await exists(path), path).toBe(false);
    }
  });

  it("finds a legacy row's deltas under its archive base", async () => {
    const legacy = row('2026-06-01T10-00-00-000Z-old.md');
    await put('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-0-5.md', 'x');
    await put('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-x-0-5.md', 'other session');

    expect(await removeCuratorByproducts(w(), legacy, [])).toEqual([]);
    expect(await exists('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-0-5.md')).toBe(false);
    expect(await exists('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-x-0-5.md')).toBe(true);
  });
});
