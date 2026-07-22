import { describe, expect, it } from 'vitest';
import type { SandboxSubstrate } from '../src/index.js';
import { listCones } from '../src/operations/list.js';
import { MemRegistry, makeFakeSubstrate } from './fixtures/index.js';

describe('listCones', () => {
  it('returns registry entries enriched with live state', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-1',
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      joinUrl: 'https://w/join/s-1',
      state: 'paused',
    });
    const substrate = makeFakeSubstrate({
      listResult: [{ sandboxId: 's-1', state: 'running', metadata: { name: 'mine' } }],
    });
    const result = await listCones({ substrate, registry });
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe('running');
    // Registry state flipped:
    expect(registry.entries[0]?.state).toBe('running');
  });

  it("marks registry entries missing from substrate as 'dead'", async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-stale',
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      joinUrl: 'https://w/join/s-stale',
      state: 'paused',
    });
    const substrate = makeFakeSubstrate({ listResult: [] });
    const result = await listCones({ substrate, registry });
    expect(result[0]?.state).toBe('dead');
    expect(registry.entries[0]?.state).toBe('dead');
  });

  it('rebuilds orphans (substrate sandboxes not in registry) into the registry', async () => {
    const registry = new MemRegistry();
    const substrate = makeFakeSubstrate({
      listResult: [{ sandboxId: 's-orphan', state: 'running', metadata: { name: 'orphan' } }],
    });
    const result = await listCones({ substrate, registry });
    expect(result.some((c) => c.sandboxId === 's-orphan')).toBe(true);
    expect(registry.entries.some((e) => e.sandboxId === 's-orphan')).toBe(true);
    // Check that recovered entry has reasonable defaults:
    const recovered = registry.entries.find((e) => e.sandboxId === 's-orphan');
    expect(recovered?.name).toBe('orphan');
    expect(recovered?.substrate).toBe('e2b');
    expect(recovered?.state).toBe('running');
  });

  it('filters by opts.metadata when provided', async () => {
    const registry = new MemRegistry();
    const substrate = makeFakeSubstrate({
      listResult: [
        {
          sandboxId: 's-mine',
          state: 'running',
          metadata: { userId: 'u1', name: 'mine' },
        },
        {
          sandboxId: 's-theirs',
          state: 'running',
          metadata: { userId: 'u2', name: 'theirs' },
        },
      ],
    });
    const result = await listCones({ substrate, registry }, { metadata: { userId: 'u1' } });
    expect(result.map((c) => c.sandboxId)).toEqual(['s-mine']);
  });

  it('does not overwrite dead state if already dead', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-already-dead',
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      joinUrl: 'https://w/join/s-already-dead',
      state: 'dead',
    });
    const substrate = makeFakeSubstrate({ listResult: [] });
    const result = await listCones({ substrate, registry });
    expect(result[0]?.state).toBe('dead');
    expect(registry.entries[0]?.state).toBe('dead');
  });

  it('does not update registry if state already matches', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-running',
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      joinUrl: 'https://w/join/s-running',
      state: 'running',
    });
    const substrate = makeFakeSubstrate({
      listResult: [{ sandboxId: 's-running', state: 'running', metadata: {} }],
    });
    const initialEntry = { ...registry.entries[0]! };
    await listCones({ substrate, registry });
    // State should remain unchanged (not re-written):
    expect(registry.entries[0]).toEqual(initialEntry);
  });

  it('recovers metadata fields from substrate during orphan recovery', async () => {
    const registry = new MemRegistry();
    const substrate = makeFakeSubstrate({
      listResult: [
        {
          sandboxId: 's-orphan-with-meta',
          state: 'running',
          metadata: {
            name: 'custom-name',
            createdAt: '2026-01-01T00:00:00Z',
            joinUrl: 'https://custom/join/url',
            trayId: 'tray-123',
            lastJoinUpdatedAt: '2026-01-02T00:00:00Z',
          },
        },
      ],
    });
    const result = await listCones({ substrate, registry });
    const recovered = result.find((c) => c.sandboxId === 's-orphan-with-meta');
    expect(recovered?.name).toBe('custom-name');
    expect(recovered?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(recovered?.joinUrl).toBe('https://custom/join/url');
    expect(recovered?.trayId).toBe('tray-123');
    expect(recovered?.lastJoinUpdatedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('falls back to reading /tmp/slicc-join.json when metadata lacks joinUrl', async () => {
    const registry = new MemRegistry();
    const substrate = makeFakeSubstrate({
      listResult: [
        {
          sandboxId: 's-orphan-no-metadata',
          state: 'running',
          metadata: { name: 'orphan-fallback' },
        },
      ],
      // The default handle will return joinUrl from /tmp/slicc-join.json
      handle: {
        sandboxId: 's-orphan-no-metadata',
        substrate: 'e2b' as const,
        pause: async () => {},
        kill: async () => {},
        getInfo: async () => ({
          sandboxId: 's-orphan-no-metadata',
          state: 'running' as const,
          metadata: {},
          createdAt: new Date().toISOString(),
        }),
        writeFile: async () => {},
        readFile: async (path: string) => {
          if (path === '/tmp/slicc-join.json') {
            return JSON.stringify({
              joinUrl: 'https://recovered/join/url',
              trayId: 'tray-recovered',
              updatedAt: '2026-05-27T00:00:00Z',
            });
          }
          throw new Error(`ENOENT ${path}`);
        },
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
    });
    const result = await listCones({ substrate, registry });
    const recovered = result.find((c) => c.sandboxId === 's-orphan-no-metadata');
    expect(recovered?.joinUrl).toBe('https://recovered/join/url');
    expect(recovered?.trayId).toBe('tray-recovered');
    expect(recovered?.lastJoinUpdatedAt).toBe('2026-05-27T00:00:00Z');
  });

  it('does not call substrate.connect for paused orphans (no auto-resume)', async () => {
    const registry = new MemRegistry();
    // connectError proves connect was NOT called — if it were called, listCones
    // would throw or swallow the error, but we want to prove the branch is skipped.
    const substrate = makeFakeSubstrate({
      listResult: [
        {
          sandboxId: 's-paused-orphan',
          state: 'paused',
          metadata: { name: 'paused-orphan' },
        },
      ],
      connectError: new Error('connect should not be called for paused orphans'),
    });
    const result = await listCones({ substrate, registry });
    const recovered = result.find((c) => c.sandboxId === 's-paused-orphan');
    // If connect had been called, the error would have been swallowed by the catch,
    // but we still expect recovery to succeed with empty joinUrl.
    expect(recovered?.joinUrl).toBe('');
    expect(recovered?.state).toBe('paused');
    // Verify the entry was added to registry
    expect(registry.entries.some((e) => e.sandboxId === 's-paused-orphan')).toBe(true);
  });

  it('calls substrate.connect only for running orphans, not paused', async () => {
    const registry = new MemRegistry();
    const connects: string[] = [];
    const fakeHandle = makeFakeSubstrate().connect('fake');
    const substrate: SandboxSubstrate = {
      id: 'e2b' as const,
      async create() {
        throw new Error('create should not be called');
      },
      async connect(sandboxId: string) {
        connects.push(sandboxId);
        return fakeHandle;
      },
      async list() {
        return [
          { sandboxId: 's-running', state: 'running' as const, metadata: { name: 'running' } },
          { sandboxId: 's-paused', state: 'paused' as const, metadata: { name: 'paused' } },
        ];
      },
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {
        // No-op for this test
      },
    };
    await listCones({ substrate, registry });
    // Only the running sandbox should trigger a connect call
    expect(connects).toEqual(['s-running']);
    // Both orphans should be recovered
    expect(registry.entries).toHaveLength(2);
    const paused = registry.entries.find((e) => e.sandboxId === 's-paused');
    expect(paused?.joinUrl).toBe(''); // No joinUrl recovery for paused
  });

  it('extends timeout on running cones during reconciliation', async () => {
    const registry = new MemRegistry();
    const timeoutCalls: Array<{ sandboxId: string; ttlMs: number }> = [];
    const substrate = makeFakeSubstrate({
      listResult: [
        { sandboxId: 's-running', state: 'running', metadata: { userId: 'u1' } },
        { sandboxId: 's-paused', state: 'paused', metadata: { userId: 'u1' } },
      ],
      timeoutCalls,
    });
    await listCones({ substrate, registry });
    const extended = timeoutCalls.map((c) => c.sandboxId);
    expect(extended).toContain('s-running');
    expect(extended).not.toContain('s-paused');
    expect(timeoutCalls[0]?.ttlMs).toBe(60 * 60 * 1000);
  });

  it('preserves reserved entries during reconciliation (not marked dead)', async () => {
    const registry = new MemRegistry();
    const now = new Date().toISOString();
    await registry.append({
      sandboxId: 'pending-abc',
      substrate: 'e2b',
      createdAt: now,
      lastSeen: now,
      joinUrl: '',
      state: 'reserved',
      reservedAt: now,
    });
    const substrate = makeFakeSubstrate({ listResult: [] }); // substrate knows nothing about it
    const result = await listCones({ substrate, registry });
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe('reserved');
    expect(result[0]?.sandboxId).toBe('pending-abc');
    // Should NOT have been removed from registry
    expect(registry.entries).toHaveLength(1);
  });

  it('preserves a resume reservation whose sandboxId is still live in substrate', async () => {
    // Regression: a resume reservation reuses the REAL sandboxId (unlike a start
    // reservation, which uses a synthetic 'pending-' id absent from the substrate).
    // reconcileRegistryEntry's 'reserved' branch must not leave that sandboxId in
    // liveById, or pass 2's orphan recovery re-appends it with the substrate's raw
    // state, silently clearing the in-flight reservation before a concurrent
    // duplicate resume's precheck can see it.
    const registry = new MemRegistry();
    const now = new Date().toISOString();
    await registry.append({
      sandboxId: 's-resume',
      substrate: 'e2b',
      name: 'a',
      createdAt: now,
      lastSeen: now,
      joinUrl: '',
      state: 'reserved',
      reservedAt: now,
      metadata: { userId: 'u1' },
    });
    const substrate = makeFakeSubstrate({
      listResult: [{ sandboxId: 's-resume', state: 'paused', metadata: { userId: 'u1' } }],
    });
    const result = await listCones({ substrate, registry }, { metadata: { userId: 'u1' } });
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe('reserved');
    // Only one registry entry — must not have been duplicated/re-appended.
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]?.state).toBe('reserved');
  });

  it('reclaims stale reserved entries (older than 10 min TTL)', async () => {
    const registry = new MemRegistry();
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString(); // 11 min ago
    await registry.append({
      sandboxId: 'pending-stale',
      substrate: 'e2b',
      createdAt: staleTime,
      lastSeen: staleTime,
      joinUrl: '',
      state: 'reserved',
      reservedAt: staleTime,
    });
    const substrate = makeFakeSubstrate({ listResult: [] });
    const result = await listCones({ substrate, registry });
    // Stale reservation should be reclaimed (not in result)
    expect(result).toHaveLength(0);
    // Should have been removed from registry
    expect(registry.entries).toHaveLength(0);
  });

  it('preserves fresh reserved entries (younger than 10 min TTL)', async () => {
    const registry = new MemRegistry();
    const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    await registry.append({
      sandboxId: 'pending-fresh',
      substrate: 'e2b',
      createdAt: freshTime,
      lastSeen: freshTime,
      joinUrl: '',
      state: 'reserved',
      reservedAt: freshTime,
    });
    const substrate = makeFakeSubstrate({ listResult: [] });
    const result = await listCones({ substrate, registry });
    // Fresh reservation should be preserved
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe('reserved');
    expect(registry.entries).toHaveLength(1);
  });
});
