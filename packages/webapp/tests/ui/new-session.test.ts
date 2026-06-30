import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrozenSession, FrozenSessionIndexEntry } from '../../src/ui/session-freezer.js';

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

import { runNewSessionFreeze } from '../../src/ui/new-session.js';

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
