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

const mockIsFeatureEnabled = vi.fn();
vi.mock('../../src/core/feature-flags.js', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock('../../src/scoops/llm-session-id.js', () => ({ getDailyAdobeUuid: () => 'uuid-x' }));

const mockInit = vi.fn(async () => {});
vi.mock('../../src/scoops/chat-session-store.js', () => ({
  SessionStore: class {
    init = mockInit;
  },
}));

const mockFreezeConeSession = vi.fn();
const mockCurateFrozenSessionMemories = vi.fn();
const mockEnrichPendingSession = vi.fn();
const mockProcessPendingSessions = vi.fn();
const mockMarkSnapshotUnavailable = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock('../../src/ui/session-freezer.js', () => ({
  freezeConeSession: (...a: unknown[]) => mockFreezeConeSession(...a),
  curateFrozenSessionMemories: (...a: unknown[]) => mockCurateFrozenSessionMemories(...a),
  enrichPendingSession: (...a: unknown[]) => mockEnrichPendingSession(...a),
  processPendingSessions: (...a: unknown[]) => mockProcessPendingSessions(...a),
  markSnapshotUnavailable: (...a: unknown[]) => mockMarkSnapshotUnavailable(...a),
}));

const mockPickLucideIcon = vi.fn(async () => 'wrench');
vi.mock('../../src/providers/quick-llm.js', () => ({ pickLucideIcon: mockPickLucideIcon }));

import {
  resetNewSessionTmp,
  runNewSessionArchiveOnly,
  runNewSessionFreeze,
  runNewSessionFreezeQuick,
  runPendingSessionCatchup,
  schedulePendingSessionCatchup,
} from '../../src/ui/new-session.js';

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

beforeEach(() => {
  mockIsFeatureEnabled.mockReset().mockReturnValue(false);
  mockProcessPendingSessions.mockReset().mockResolvedValue({ attempted: 0, completed: 0 });
});

describe('pending session boot catch-up', () => {
  it('uses the flag-off legacy path with current provider credentials', async () => {
    const vfs = {} as never;
    mockGetApiKey.mockReturnValue('k');
    mockResolveCurrentModel.mockReturnValue(fakeModel);
    const onComplete = vi.fn();

    await runPendingSessionCatchup({ openVfs: async () => vfs, onComplete });

    expect(mockProcessPendingSessions).toHaveBeenCalledWith({
      vfs,
      model: fakeModel,
      apiKey: 'k',
      headers: undefined,
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('runs only after the idle callback and never surfaces catch-up failures', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockProcessPendingSessions.mockRejectedValue(new Error('index write failed'));
    const openVfs = vi.fn(async () => ({}) as never);
    const scheduled: Array<() => void> = [];

    expect(() =>
      schedulePendingSessionCatchup({
        openVfs,
        schedule: (callback) => scheduled.push(callback),
      })
    ).not.toThrow();
    expect(openVfs).not.toHaveBeenCalled();

    scheduled[0]();
    await flush();
    expect(openVfs).toHaveBeenCalledOnce();
    expect(mockProcessPendingSessions).toHaveBeenCalledOnce();
  });
});

describe('runNewSessionFreeze — write-first + race', () => {
  beforeEach(() => {
    mockGetApiKey.mockReset().mockReturnValue('k');
    mockResolveCurrentModel.mockReset().mockReturnValue(fakeModel);
    mockInit.mockReset().mockResolvedValue(undefined);
    mockFreezeConeSession.mockReset().mockResolvedValue(pending);
    mockCurateFrozenSessionMemories.mockReset();
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

  it('flag on takes a quick no-LLM snapshot and returns before any background work', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    const spawn = vi.fn(async () => ({ finalText: 'done', exitCode: 0 }));
    const frozen = { ...pending, memoryPending: true as const };
    mockFreezeConeSession.mockResolvedValue(frozen);
    const deferredEnrich = deferred<FrozenSessionIndexEntry | null>();
    mockEnrichPendingSession.mockReturnValue(deferredEnrich.promise);
    mockCurateFrozenSessionMemories.mockResolvedValue({ ...enriched, memoryPending: undefined });

    const result = await runNewSessionFreeze({
      vfs: {} as never,
      agenticMemorySpawn: spawn,
    });

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('agentic-memory');
    expect(mockFreezeConeSession).toHaveBeenCalledOnce();
    const freezeOptions = mockFreezeConeSession.mock.calls[0][0];
    // Quick snapshot — no model/key handed to the freeze, no LLM inside it.
    expect(freezeOptions).toMatchObject({ mode: 'quick' });
    expect(freezeOptions.model).toBeUndefined();
    await freezeOptions.agenticMemorySpawn({} as never);
    expect(spawn).toHaveBeenCalledOnce();
    // The freeze resolved while enrichment is still pending: the caller may
    // clear the chat now, with both markers intact on the returned entry.
    expect(result?.filename).toBe('pending-abc.md');
    expect(result?.memoryPending).toBe(true);
    expect(mockCurateFrozenSessionMemories).not.toHaveBeenCalled();
    deferredEnrich.resolve(null);
  });

  it('agentic background pass: title enrichment (memory skipped) then curator, rail refreshed after each', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    const frozen = { ...pending, memoryPending: true as const };
    mockFreezeConeSession.mockResolvedValue(frozen);
    const deferredEnrich = deferred<FrozenSessionIndexEntry | null>();
    mockEnrichPendingSession.mockReturnValue(deferredEnrich.promise);
    const deferredCurator = deferred<FrozenSessionIndexEntry | null>();
    mockCurateFrozenSessionMemories.mockReturnValue(deferredCurator.promise);
    const onBackgroundEnriched = vi.fn();

    await runNewSessionFreeze({
      vfs: {} as never,
      agenticMemorySpawn: vi.fn(),
      onBackgroundEnriched,
    });
    await flush();

    // Title/icon enrichment runs first, with memory extraction skipped — the
    // curator owns memory in agentic mode.
    expect(mockEnrichPendingSession).toHaveBeenCalledOnce();
    const enrichOpts = mockEnrichPendingSession.mock.calls[0][2] as {
      skipMemory?: boolean;
      pickIcon?: unknown;
    };
    expect(enrichOpts.skipMemory).toBe(true);
    expect(typeof enrichOpts.pickIcon).toBe('function');
    // The curator waits for the rename so it mines the canonical filename.
    expect(mockCurateFrozenSessionMemories).not.toHaveBeenCalled();

    const renamed = { ...enriched, memoryPending: true as const };
    deferredEnrich.resolve(renamed);
    await flush();
    expect(onBackgroundEnriched).toHaveBeenCalledWith(renamed);
    expect(mockCurateFrozenSessionMemories).toHaveBeenCalledOnce();
    const curatedTarget = mockCurateFrozenSessionMemories.mock.calls[0][1] as FrozenSession;
    expect(curatedTarget.filename).toBe(enriched.filename);

    const curated = { ...enriched };
    deferredCurator.resolve(curated);
    await flush();
    expect(onBackgroundEnriched).toHaveBeenCalledTimes(2);
    expect(onBackgroundEnriched).toHaveBeenLastCalledWith(curated);
  });

  it('agentic background pass survives a failed title enrichment and still curates the draft', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    const frozen = { ...pending, memoryPending: true as const };
    mockFreezeConeSession.mockResolvedValue(frozen);
    mockEnrichPendingSession.mockRejectedValue(new Error('provider 502'));
    const deferredCurator = deferred<FrozenSessionIndexEntry | null>();
    mockCurateFrozenSessionMemories.mockReturnValue(deferredCurator.promise);
    const onBackgroundEnriched = vi.fn();

    const result = await runNewSessionFreeze({
      vfs: {} as never,
      agenticMemorySpawn: vi.fn(),
      onBackgroundEnriched,
    });
    await flush();

    expect(result?.filename).toBe('pending-abc.md');
    // Enrichment failed → curator still runs, against the pending draft name.
    expect(mockCurateFrozenSessionMemories).toHaveBeenCalledOnce();
    const curatedTarget = mockCurateFrozenSessionMemories.mock.calls[0][1] as FrozenSession;
    expect(curatedTarget.filename).toBe('pending-abc.md');
    deferredCurator.resolve(null);
    await flush();
    // Rail still notified (with null) so the pending badge can refresh.
    expect(onBackgroundEnriched).toHaveBeenCalledWith(null);
  });

  it('flag on without an agent bridge keeps the legacy quick enrichment flow', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockEnrichPendingSession.mockResolvedValue(enriched);

    await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 10_000 });

    expect(mockFreezeConeSession.mock.calls[0][0].mode).toBe('quick');
    expect(mockEnrichPendingSession).toHaveBeenCalledOnce();
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

describe('runNewSessionFreeze — captureCompleteSnapshot hook', () => {
  beforeEach(() => {
    mockGetApiKey.mockReset().mockReturnValue('k');
    mockResolveCurrentModel.mockReset().mockReturnValue(fakeModel);
    mockInit.mockReset().mockResolvedValue(undefined);
    mockFreezeConeSession.mockReset().mockResolvedValue(pending);
    mockEnrichPendingSession.mockReset().mockResolvedValue(null);
    mockPickLucideIcon.mockClear();
  });

  it('calls captureCompleteSnapshot with the frozen session after Markdown write', async () => {
    const captureCompleteSnapshot = vi.fn(async (_frozen: FrozenSession) => {});
    const result = await runNewSessionFreeze({
      vfs: {} as never,
      enrichmentRaceMs: 10,
      captureCompleteSnapshot,
    });
    expect(captureCompleteSnapshot).toHaveBeenCalledOnce();
    // Verify it was called with the pending frozen entry.
    expect(captureCompleteSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ filename: pending.filename })
    );
    // Session still returned regardless
    expect(result).not.toBeNull();
  });

  it('does not call captureCompleteSnapshot when nothing was archived', async () => {
    mockFreezeConeSession.mockResolvedValue(null);
    const captureCompleteSnapshot = vi.fn(async () => {});
    const result = await runNewSessionFreeze({
      vfs: {} as never,
      enrichmentRaceMs: 10,
      captureCompleteSnapshot,
    });
    expect(result).toBeNull();
    expect(captureCompleteSnapshot).not.toHaveBeenCalled();
  });

  it('regression: captureCompleteSnapshot failure does not block New Session', async () => {
    const captureCompleteSnapshot = vi.fn(async () => {
      throw new Error('snapshot pipeline failed');
    });
    // Should not throw — New Session always proceeds
    await expect(
      runNewSessionFreeze({
        vfs: {} as never,
        enrichmentRaceMs: 10,
        captureCompleteSnapshot,
      })
    ).resolves.not.toThrow();
    expect(captureCompleteSnapshot).toHaveBeenCalledOnce();
  });

  it('returns frozen session even when captureCompleteSnapshot fails', async () => {
    mockEnrichPendingSession.mockResolvedValue(null);
    const captureCompleteSnapshot = vi.fn(async () => {
      const err = new Error('pipeline fail') as Error & { code: string };
      err.code = 'redaction-unavailable';
      throw err;
    });
    const result = await runNewSessionFreeze({
      vfs: {} as never,
      enrichmentRaceMs: 10,
      captureCompleteSnapshot,
    });
    // The Markdown archive entry is still returned
    expect(result).not.toBeNull();
    expect(result?.filename).toBe(pending.filename);
  });

  it('sets completeSnapshotUnavailable on the frozen session when hook fails', async () => {
    mockEnrichPendingSession.mockResolvedValue(null);
    const captureCompleteSnapshot = vi.fn(async () => {
      throw new Error('snapshot failed');
    });
    const result = await runNewSessionFreeze({
      vfs: {} as never,
      enrichmentRaceMs: 10,
      captureCompleteSnapshot,
    });
    expect(result?.completeSnapshotUnavailable).toBe(true);
  });

  it('captureCompleteSnapshot is called before enrichment starts', async () => {
    const callOrder: string[] = [];
    const captureCompleteSnapshot = vi.fn(async () => {
      callOrder.push('snapshot');
    });
    mockEnrichPendingSession.mockImplementation(async () => {
      callOrder.push('enrich');
      return null;
    });
    await runNewSessionFreeze({
      vfs: {} as never,
      enrichmentRaceMs: 10,
      captureCompleteSnapshot,
    });
    // snapshot hook runs synchronously before enrichment (which starts as a promise)
    expect(callOrder[0]).toBe('snapshot');
  });
});

describe('runNewSessionFreezeQuick — captureCompleteSnapshot hook', () => {
  beforeEach(() => {
    mockGetApiKey.mockReset();
    mockResolveCurrentModel.mockReset();
    mockInit.mockReset().mockResolvedValue(undefined);
    // Return a fresh object each time so one test's mutation does not bleed into the next.
    // Cannot spread `pending` here: the runNewSessionFreeze suite mutates it in-place.
    mockFreezeConeSession.mockReset().mockImplementation(async () => ({
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
    }));
    mockEnrichPendingSession.mockReset();
    mockMarkSnapshotUnavailable.mockReset().mockResolvedValue(undefined);
  });

  it('invokes captureCompleteSnapshot with immutable metadata from the frozen session', async () => {
    const captureCompleteSnapshot = vi.fn(async (_frozen: FrozenSession) => {});
    const result = await runNewSessionFreezeQuick({
      vfs: {} as never,
      captureCompleteSnapshot,
    });
    expect(captureCompleteSnapshot).toHaveBeenCalledOnce();
    // Verify metadata fields come from the frozen session
    expect(captureCompleteSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: pending.filename,
        frozenAt: pending.frozenAt,
      })
    );
    expect(result).not.toBeNull();
  });

  it('runNewSessionArchiveOnly is the quick freeze with memory skipped for good (#2272)', async () => {
    const captureCompleteSnapshot = vi.fn(async (_frozen: FrozenSession) => {});
    const result = await runNewSessionArchiveOnly({
      vfs: {} as never,
      cone: { folder: 'cone-research', label: 'Research' },
      captureCompleteSnapshot,
    });
    expect(result).not.toBeNull();
    expect(mockFreezeConeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'quick',
        memory: 'skip',
        cone: { folder: 'cone-research', label: 'Research' },
      })
    );
    expect(captureCompleteSnapshot).toHaveBeenCalledOnce();
    // The plain quick path never asks for that.
    mockFreezeConeSession.mockClear();
    await runNewSessionFreezeQuick({ vfs: {} as never });
    expect(mockFreezeConeSession.mock.calls[0][0]).not.toHaveProperty('memory');
  });

  it('does not invoke captureCompleteSnapshot when nothing was archived', async () => {
    mockFreezeConeSession.mockResolvedValue(null);
    const captureCompleteSnapshot = vi.fn(async () => {});
    const result = await runNewSessionFreezeQuick({
      vfs: {} as never,
      captureCompleteSnapshot,
    });
    expect(result).toBeNull();
    expect(captureCompleteSnapshot).not.toHaveBeenCalled();
  });

  it('still returns frozen session when captureCompleteSnapshot throws (non-blocking)', async () => {
    const captureCompleteSnapshot = vi.fn(async () => {
      throw new Error('snapshot pipeline failed');
    });
    const result = await runNewSessionFreezeQuick({
      vfs: {} as never,
      captureCompleteSnapshot,
    });
    expect(result).not.toBeNull();
    expect(result?.filename).toBe(pending.filename);
  });

  it('sets completeSnapshotUnavailable when captureCompleteSnapshot fails', async () => {
    const captureCompleteSnapshot = vi.fn(async () => {
      throw new Error('snapshot failed');
    });
    const result = await runNewSessionFreezeQuick({
      vfs: {} as never,
      captureCompleteSnapshot,
    });
    expect(result?.completeSnapshotUnavailable).toBe(true);
  });

  it('calls markSnapshotUnavailable best-effort when captureCompleteSnapshot fails', async () => {
    const captureCompleteSnapshot = vi.fn(async () => {
      throw new Error('snapshot failed');
    });
    await runNewSessionFreezeQuick({ vfs: {} as never, captureCompleteSnapshot });
    expect(mockMarkSnapshotUnavailable).toHaveBeenCalledOnce();
  });

  it('does not propagate markSnapshotUnavailable failure', async () => {
    mockMarkSnapshotUnavailable.mockRejectedValue(new Error('index write failed'));
    const captureCompleteSnapshot = vi.fn(async () => {
      throw new Error('snapshot failed');
    });
    // Should resolve without throwing despite both hook and markSnapshotUnavailable failing
    await expect(
      runNewSessionFreezeQuick({ vfs: {} as never, captureCompleteSnapshot })
    ).resolves.not.toThrow();
  });

  it('returns frozen session without completeSnapshotUnavailable when hook succeeds', async () => {
    const captureCompleteSnapshot = vi.fn(async () => {});
    const result = await runNewSessionFreezeQuick({
      vfs: {} as never,
      captureCompleteSnapshot,
    });
    expect(result?.completeSnapshotUnavailable).toBeUndefined();
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

    await resetNewSessionTmp(vfs, '/tmp');

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

    await resetNewSessionTmp(vfs, '/tmp');

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

    await resetNewSessionTmp(vfs, '/tmp');

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

    await resetNewSessionTmp(vfs, '/tmp');

    expect(await vfs.readTextFile('/tmp/keep.txt')).toBe('preserve');
  });

  it.each(['s3', 'da'] as const)(
    'preserves %s mount contents while removing ordinary scratch entries',
    async (kind) => {
      const vfs = await createVfs();
      const { backend, remove } = createRemoteMountBackend(kind);
      await vfs.mount(`/tmp/${kind}`, backend);
      await vfs.writeFile('/tmp/scratch.txt', 'discard');

      await resetNewSessionTmp(vfs, '/tmp');

      expect((await vfs.readDir('/tmp')).map(({ name }) => name)).toEqual([kind]);
      expect(await vfs.readTextFile(`/tmp/${kind}/keep.txt`)).toBe('preserve');
      expect(remove).not.toHaveBeenCalled();
    }
  );

  it('never traverses a cone subtree that sits INSIDE a mount (Codex P1 on #2574)', async () => {
    // The sweep root moved from `/tmp` down to `/tmp/<cone>`, so a mount at
    // `/tmp` stopped being the sweep root that halted it and became an
    // ANCESTOR the filter dropped. Walking through it deletes the user's real
    // Local/S3/DA files.
    const vfs = await createVfs();
    await vfs.mount(
      '/tmp',
      LocalMountBackend.fromHandle(createDirectoryHandle({ cone: { 'keep.txt': 'preserve' } }), {
        mountId: 'new-session-ancestor',
      })
    );

    await resetNewSessionTmp(vfs, '/tmp/cone');

    expect(await vfs.readTextFile('/tmp/cone/keep.txt')).toBe('preserve');
  });

  it('does not conjure a directory inside a mount when the cone subtree is absent', async () => {
    // The other half of the same bug: with nothing at `/tmp/<cone>` the sweep
    // falls through to `mkdir(tmpDir, { recursive: true })`, which would
    // create a directory in the user's mounted external storage.
    const vfs = await createVfs();
    const remote = createRemoteMountBackend('s3');
    await vfs.mount('/tmp', remote.backend);

    await resetNewSessionTmp(vfs, '/tmp/cone');

    expect(remote.remove).not.toHaveBeenCalled();
    expect(remote.backend.mkdir).not.toHaveBeenCalled();
  });

  it('wipes only the named cone subtree, leaving a sibling cone untouched', async () => {
    // The incident this scoping exists for: "New chat" on one cone deleted a
    // SIBLING cone's live working directory out from under it (#2566, #2568).
    const vfs = await createVfs();
    await vfs.mkdir('/tmp/cone/work', { recursive: true });
    await vfs.writeFile('/tmp/cone/work/scratch.txt', 'discard');
    await vfs.mkdir('/tmp/cone-adobe/rv/node_modules', { recursive: true });
    await vfs.writeFile('/tmp/cone-adobe/rv/node_modules/pkg.json', 'preserve');

    await resetNewSessionTmp(vfs, '/tmp/cone');

    expect(await vfs.readDir('/tmp/cone')).toEqual([]);
    expect(await vfs.readTextFile('/tmp/cone-adobe/rv/node_modules/pkg.json')).toBe('preserve');
  });

  it('a cone sweep still takes its own scoops with it', async () => {
    // A scoop's scratch nests INSIDE its cone's, so "New chat" disposes of
    // everything the cone owns without reaching outside it.
    const vfs = await createVfs();
    await vfs.mkdir('/tmp/cone-adobe/review', { recursive: true });
    await vfs.writeFile('/tmp/cone-adobe/review/notes.md', 'discard');
    await vfs.mkdir('/tmp/cone', { recursive: true });
    await vfs.writeFile('/tmp/cone/keep.txt', 'preserve');

    await resetNewSessionTmp(vfs, '/tmp/cone-adobe');

    expect(await vfs.readDir('/tmp/cone-adobe')).toEqual([]);
    expect(await vfs.readTextFile('/tmp/cone/keep.txt')).toBe('preserve');
  });

  it('does not treat a name-prefixed sibling as part of the subtree', async () => {
    // `/tmp/cone` is a string prefix of `/tmp/cone-adobe`. Without the
    // separator this sweep would eat the other cone's tree.
    const vfs = await createVfs();
    await vfs.mkdir('/tmp/cone', { recursive: true });
    await vfs.writeFile('/tmp/cone/gone.txt', 'discard');
    await vfs.mkdir('/tmp/cone-adobe', { recursive: true });
    await vfs.writeFile('/tmp/cone-adobe/kept.txt', 'preserve');

    await resetNewSessionTmp(vfs, '/tmp/cone');

    expect(await vfs.readTextFile('/tmp/cone-adobe/kept.txt')).toBe('preserve');
  });

  it('recreates an absent cone subtree without touching the shared root', async () => {
    const vfs = await createVfs();
    await vfs.mkdir('/tmp/cone-adobe', { recursive: true });
    await vfs.writeFile('/tmp/cone-adobe/keep.txt', 'preserve');

    await resetNewSessionTmp(vfs, '/tmp/cone');

    expect(await vfs.readDir('/tmp/cone')).toEqual([]);
    expect(await vfs.readTextFile('/tmp/cone-adobe/keep.txt')).toBe('preserve');
  });

  it('recreates an absent /tmp directory', async () => {
    const vfs = await createVfs();
    if (await vfs.exists('/tmp')) await vfs.rm('/tmp', { recursive: true });

    await resetNewSessionTmp(vfs, '/tmp');

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

    await resetNewSessionTmp(vfs, '/tmp');

    expect(vfs.rm).not.toHaveBeenCalled();
    expect(vfs.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
  });

  it('keeps sweeping when a concurrent writer unlinks an entry first', async () => {
    // `/tmp` is shared scratch: a sibling cone can delete an entry between our
    // `readDir` and our `rm`. That ENOENT is the goal state, not a failure.
    const vfs = {
      listMountPoints: vi.fn(() => []),
      readDir: vi.fn(async () => [
        { name: 'raced.json', type: 'file' as const },
        { name: 'survivor.txt', type: 'file' as const },
      ]),
      rm: vi.fn(async (path: string) => {
        if (path === '/tmp/raced.json') throw new FsError('ENOENT', 'no such file', path);
      }),
      mkdir: vi.fn(async () => undefined),
    };

    await expect(resetNewSessionTmp(vfs, '/tmp')).resolves.toBeUndefined();

    expect(vfs.rm).toHaveBeenCalledWith('/tmp/survivor.txt');
    expect(vfs.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
  });

  it('skips a directory that vanishes between listing and traversal', async () => {
    const vfs = {
      listMountPoints: vi.fn(() => []),
      readDir: vi.fn(async (path: string) => {
        if (path === '/tmp')
          return [
            { name: 'gone', type: 'directory' as const },
            { name: 'survivor.txt', type: 'file' as const },
          ];
        throw new FsError('ENOENT', 'no such file or directory', path);
      }),
      rm: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
    };

    await expect(resetNewSessionTmp(vfs, '/tmp')).resolves.toBeUndefined();

    expect(vfs.rm).toHaveBeenCalledWith('/tmp/survivor.txt');
    expect(vfs.rm).not.toHaveBeenCalledWith('/tmp/gone');
    expect(vfs.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
  });

  it('propagates a non-ENOENT failure raised while listing a subdirectory', async () => {
    const vfs = {
      listMountPoints: vi.fn(() => []),
      readDir: vi.fn(async (path: string) => {
        if (path === '/tmp') return [{ name: 'broken', type: 'directory' as const }];
        throw new FsError('EIO', 'failed', path);
      }),
      rm: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
    };

    await expect(resetNewSessionTmp(vfs, '/tmp')).rejects.toMatchObject({ code: 'EIO' });
    expect(vfs.mkdir).not.toHaveBeenCalled();
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

    await expect(resetNewSessionTmp(vfs, '/tmp')).rejects.toMatchObject({ code: 'EIO' });
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

    await expect(resetNewSessionTmp(vfs, '/tmp')).rejects.toMatchObject({ code: 'EIO' });
    expect(vfs.readDir).not.toHaveBeenCalled();
    expect(vfs.rm).not.toHaveBeenCalled();
  });
});
