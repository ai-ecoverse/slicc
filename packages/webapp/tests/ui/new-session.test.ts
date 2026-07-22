import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MountBackend, MountKind } from '../../src/fs/mount/backend.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { FrozenSession, FrozenSessionIndexEntry } from '../../src/ui/session-freezer.js';
import { createDirectoryHandle } from '../fs/fsa-test-helpers.js';

const mockGetApiKey = vi.fn();
const mockResolveCurrentModel = vi.fn();
vi.mock('../../src/ui/provider-settings.js', () => ({
  getApiKey: () => mockGetApiKey(),
  resolveCurrentModel: () => mockResolveCurrentModel(),
}));

vi.mock('../../src/scoops/llm-session-id.js', () => ({ getDailyAdobeUuid: () => 'uuid-x' }));

const mockInit = vi.fn(async () => {});
vi.mock('../../src/ui/session-store.js', () => ({
  SessionStore: class {
    init = mockInit;
  },
}));

const mockFreezeConeSession = vi.fn();
const mockEnrichPendingSession = vi.fn();
vi.mock('../../src/ui/session-freezer.js', () => ({
  freezeConeSession: (...a: unknown[]) => mockFreezeConeSession(...a),
  enrichPendingSession: (...a: unknown[]) => mockEnrichPendingSession(...a),
}));

const mockPickLucideIcon = vi.fn(async () => 'wrench');
vi.mock('../../src/providers/quick-llm.js', () => ({ pickLucideIcon: mockPickLucideIcon }));

import { resetNewSessionTmp, runNewSessionFreeze } from '../../src/ui/new-session.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function createRemoteMountBackend(kind: Extract<MountKind, 's3' | 'da'>): {
  backend: MountBackend;
  remove: ReturnType<typeof vi.fn>;
} {
  const remove = vi.fn(async () => undefined);
  const keep = new TextEncoder().encode('preserve');
  return {
    backend: {
      kind,
      source: kind === 's3' ? 's3://bucket/prefix' : 'da://org/repo',
      profile: 'default',
      mountId: `new-session-${kind}`,
      readDir: vi.fn(async () => [{ name: 'keep.txt', kind: 'file' as const }]),
      readFile: vi.fn(async () => keep),
      writeFile: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ kind: 'file' as const, size: keep.length, mtime: 0 })),
      mkdir: vi.fn(async () => undefined),
      remove,
      refresh: vi.fn(async () => ({
        added: [],
        removed: [],
        changed: [],
        unchanged: 1,
        errors: [],
      })),
      describe: () => ({ displayName: kind }),
      close: vi.fn(async () => undefined),
    },
    remove,
  };
}

const fakeModel = { id: 'm', provider: 'anthropic' };
const pending: FrozenSession = {
  filename: 'pending-abc.md',
  title: 'heuristic title',
  frozenAt: '2026-06-16T00-00-00-000Z',
  messageCount: 4,
  pendingEnrichment: true,
  archive: {
    id: 's',
    title: 'heuristic title',
    frozenAt: '',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 4,
    messages: [],
  },
};
const enriched: FrozenSessionIndexEntry = {
  filename: '2026-06-16T00-00-00-000Z-real-slug.md',
  title: 'Real Slug',
  frozenAt: '2026-06-16T00-00-00-000Z',
  messageCount: 4,
  icon: 'wrench',
};

describe('runNewSessionFreeze — write-first + race', () => {
  beforeEach(() => {
    mockGetApiKey.mockReset().mockReturnValue('k');
    mockResolveCurrentModel.mockReset().mockReturnValue(fakeModel);
    mockInit.mockReset().mockResolvedValue(undefined);
    mockFreezeConeSession.mockReset().mockResolvedValue(pending);
    mockEnrichPendingSession.mockReset();
    mockPickLucideIcon.mockClear();
  });

  it('writes a durable quick archive BEFORE any LLM enrichment call', async () => {
    mockEnrichPendingSession.mockRejectedValue(new Error('provider 502'));
    const result = await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 20 });
    // Quick (write-first) freeze ran, and ran before enrichment.
    expect(mockFreezeConeSession).toHaveBeenCalledTimes(1);
    expect(mockFreezeConeSession.mock.calls[0][0].mode).toBe('quick');
    expect(mockFreezeConeSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnrichPendingSession.mock.invocationCallOrder[0]
    );
    // A hung/failing provider never loses the archive — the pending entry is returned.
    expect(result).not.toBeNull();
  });

  it('timer wins → returns pending entry, enrichment finishes in the background', async () => {
    const d = deferred<FrozenSessionIndexEntry | null>();
    mockEnrichPendingSession.mockReturnValue(d.promise);
    const onBackgroundEnriched = vi.fn();
    const result = await runNewSessionFreeze({
      vfs: {} as never,
      enrichmentRaceMs: 10,
      onBackgroundEnriched,
    });
    // Chat may clear now: still the pending entry, enrichment not yet applied.
    expect(result?.filename).toBe('pending-abc.md');
    expect(result?.pendingEnrichment).toBe(true);
    expect(onBackgroundEnriched).not.toHaveBeenCalled();
    // Background enrichment lands the rename + icon after the race window.
    d.resolve(enriched);
    await flush();
    expect(onBackgroundEnriched).toHaveBeenCalledWith(enriched);
  });

  it('LLM wins (fast) → fully-enriched entry synchronously, no pending leftovers', async () => {
    mockEnrichPendingSession.mockResolvedValue(enriched);
    const result = await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 10_000 });
    expect(result?.filename).toBe(enriched.filename);
    expect(result?.title).toBe('Real Slug');
    expect(result?.icon).toBe('wrench');
    expect(result?.pendingEnrichment).toBeUndefined();
    // The save path supplies an icon picker so the healthy archive lands an icon.
    const enrichOpts = mockEnrichPendingSession.mock.calls[0][2] as {
      pickIcon: (o: { subject: string }) => Promise<string | null>;
    };
    expect(typeof enrichOpts.pickIcon).toBe('function');
    await expect(enrichOpts.pickIcon({ subject: 's' })).resolves.toBe('wrench');
  });

  it('reports timer-driven progress: starts at 0, clears with null', async () => {
    mockEnrichPendingSession.mockResolvedValue(enriched);
    const onProgress = vi.fn();
    await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 50, onProgress });
    expect(onProgress.mock.calls[0][0]).toBe(0);
    expect(onProgress.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('no credentials → returns pending entry, skips enrichment entirely', async () => {
    mockGetApiKey.mockReturnValue(null);
    const result = await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 10 });
    expect(result?.filename).toBe('pending-abc.md');
    expect(mockEnrichPendingSession).not.toHaveBeenCalled();
  });

  it('returns null when nothing was archived (short session / write failure)', async () => {
    mockFreezeConeSession.mockResolvedValue(null);
    const result = await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 10 });
    expect(result).toBeNull();
    expect(mockEnrichPendingSession).not.toHaveBeenCalled();
  });
});

describe('resetNewSessionTmp', () => {
  let dbCounter = 0;

  async function createVfs(): Promise<VirtualFS> {
    return VirtualFS.create({ dbName: `new-session-tmp-${dbCounter++}`, wipe: true });
  }

  it('recursively removes nested and hidden entries without touching other roots', async () => {
    const vfs = await createVfs();
    await vfs.mkdir('/tmp/nested', { recursive: true });
    await vfs.writeFile('/tmp/nested/.hidden', 'discard');
    await vfs.writeFile('/tmp/top.txt', 'discard');
    const preserved = ['/sessions', '/workspace', '/shared', '/scoops', '/home', '/mnt'];
    for (const root of preserved) {
      await vfs.mkdir(root, { recursive: true });
      await vfs.writeFile(`${root}/keep.txt`, 'preserve');
    }

    await resetNewSessionTmp(vfs);

    expect(await vfs.readDir('/tmp')).toEqual([]);
    for (const root of preserved) {
      expect(await vfs.readTextFile(`${root}/keep.txt`)).toBe('preserve');
    }
  });

  it('removes directory symlinks without traversing their targets', async () => {
    const vfs = await createVfs();
    await vfs.mkdir('/workspace/project', { recursive: true });
    await vfs.writeFile('/workspace/project/keep.txt', 'preserve');
    await vfs.symlink('/workspace/project', '/tmp/link');

    await resetNewSessionTmp(vfs);

    expect(await vfs.readDir('/tmp')).toEqual([]);
    await expect(vfs.lstat('/tmp/link')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await vfs.readTextFile('/workspace/project/keep.txt')).toBe('preserve');
  });

  it('preserves a local mount and its ancestors while removing ordinary siblings', async () => {
    const vfs = await createVfs();
    await vfs.mount(
      '/tmp/job/mounted',
      LocalMountBackend.fromHandle(createDirectoryHandle({ 'keep.txt': 'preserve' }), {
        mountId: 'new-session-local',
      })
    );
    await vfs.writeFile('/tmp/job/scratch.txt', 'discard');
    await vfs.writeFile('/tmp/top.txt', 'discard');

    await resetNewSessionTmp(vfs);

    expect((await vfs.readDir('/tmp')).map(({ name }) => name)).toEqual(['job']);
    expect((await vfs.readDir('/tmp/job')).map(({ name }) => name)).toEqual(['mounted']);
    expect(await vfs.readTextFile('/tmp/job/mounted/keep.txt')).toBe('preserve');
  });

  it('does not traverse when /tmp itself is a mount root', async () => {
    const vfs = await createVfs();
    await vfs.mount(
      '/tmp',
      LocalMountBackend.fromHandle(createDirectoryHandle({ 'keep.txt': 'preserve' }), {
        mountId: 'new-session-tmp-root',
      })
    );

    await resetNewSessionTmp(vfs);

    expect(await vfs.readTextFile('/tmp/keep.txt')).toBe('preserve');
  });

  it.each(['s3', 'da'] as const)(
    'preserves %s mount contents while removing ordinary scratch entries',
    async (kind) => {
      const vfs = await createVfs();
      const { backend, remove } = createRemoteMountBackend(kind);
      await vfs.mount(`/tmp/${kind}`, backend);
      await vfs.writeFile('/tmp/scratch.txt', 'discard');

      await resetNewSessionTmp(vfs);

      expect((await vfs.readDir('/tmp')).map(({ name }) => name)).toEqual([kind]);
      expect(await vfs.readTextFile(`/tmp/${kind}/keep.txt`)).toBe('preserve');
      expect(remove).not.toHaveBeenCalled();
    }
  );

  it('recreates an absent /tmp directory', async () => {
    const vfs = await createVfs();
    if (await vfs.exists('/tmp')) await vfs.rm('/tmp', { recursive: true });

    await resetNewSessionTmp(vfs);

    expect(await vfs.readDir('/tmp')).toEqual([]);
  });

  it('tolerates ENOENT when listing an absent /tmp before recreating it', async () => {
    const vfs = {
      listMountPoints: vi.fn(() => []),
      readDir: vi.fn(async () => {
        throw new FsError('ENOENT', 'missing', '/tmp');
      }),
      rm: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
    };

    await resetNewSessionTmp(vfs);

    expect(vfs.rm).not.toHaveBeenCalled();
    expect(vfs.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
  });

  it('propagates unexpected removal errors without attempting recreation', async () => {
    const vfs = {
      listMountPoints: vi.fn(() => []),
      readDir: vi.fn(async () => [{ name: 'file.txt', type: 'file' as const }]),
      rm: vi.fn(async () => {
        throw new FsError('EIO', 'failed', '/tmp/file.txt');
      }),
      mkdir: vi.fn(async () => undefined),
    };

    await expect(resetNewSessionTmp(vfs)).rejects.toMatchObject({ code: 'EIO' });
    expect(vfs.mkdir).not.toHaveBeenCalled();
  });

  it('fails before traversing /tmp when the mount registry cannot be read', async () => {
    const vfs = {
      listMountPoints: vi.fn(async () => {
        throw new FsError('EIO', 'mount registry unavailable');
      }),
      readDir: vi.fn(async () => []),
      rm: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
    };

    await expect(resetNewSessionTmp(vfs)).rejects.toMatchObject({ code: 'EIO' });
    expect(vfs.readDir).not.toHaveBeenCalled();
    expect(vfs.rm).not.toHaveBeenCalled();
  });
});
