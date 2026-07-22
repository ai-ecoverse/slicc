import { describe, expect, it } from 'vitest';
import type {
  CreateOpts,
  SandboxHandle,
  SandboxSubstrate,
  SandboxSummary,
  SubstrateId,
} from '../src/index.js';
import { reserveConeStart, startCone } from '../src/operations/start.js';
import { MemRegistry, makeFakeHandle, makeFakeSubstrate } from './fixtures/index.js';

// Specialized for startCone: handle stores files per-create, tracks kill state for list result.
function makeStartTestSubstrate(opts: { joinJson: string }): SandboxSubstrate {
  const files = new Map<string, string>();
  let killed = false;

  return {
    id: 'e2b' as SubstrateId,
    async create(_opts: CreateOpts): Promise<SandboxHandle> {
      const sandboxId = 'sbx-fake';
      files.set('/tmp/slicc-join.json', opts.joinJson);

      const handle = makeFakeHandle({ sandboxId });
      return {
        sandboxId: handle.sandboxId,
        substrate: handle.substrate,
        pause: handle.pause,
        kill: async () => {
          killed = true;
        },
        getInfo: handle.getInfo,
        writeFile: handle.writeFile,
        readFile: async (path: string) => {
          const content = files.get(path);
          if (!content) throw new Error(`ENOENT ${path}`);
          return content;
        },
        run: handle.run,
      } as SandboxHandle;
    },
    async connect() {
      throw new Error('not used in startCone tests');
    },
    async list(_opts?: import('../src/substrate.js').ListOpts): Promise<SandboxSummary[]> {
      if (killed) return [];
      return [
        {
          sandboxId: 'sbx-fake',
          state: 'running',
          metadata: {},
        },
      ];
    },
    async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {
      // No-op for tests.
    },
  };
}

describe('reserveConeStart', () => {
  it('allows a reservation when running and paused cones already exist', async () => {
    const registry = new MemRegistry();
    const existing = [
      {
        sandboxId: 'running-1',
        substrate: 'e2b' as const,
        createdAt: '',
        lastSeen: '',
        state: 'running' as const,
        joinUrl: 'https://w/join/running-1',
      },
      {
        sandboxId: 'paused-1',
        substrate: 'e2b' as const,
        createdAt: '',
        lastSeen: '',
        state: 'paused' as const,
        joinUrl: 'https://w/join/paused-1',
      },
    ];
    for (const entry of existing) await registry.append(entry);

    const result = await reserveConeStart(
      { substrate: makeFakeSubstrate({ listResult: [] }), registry },
      {
        name: 'next-lab',
        metadata: { userId: 'u1' },
        reconciledCones: existing,
      }
    );

    expect(result.reservationId).toMatch(/^pending-/);
    expect(await registry.list()).toContainEqual(
      expect.objectContaining({
        sandboxId: result.reservationId,
        name: 'next-lab',
        state: 'reserved',
      })
    );
  });
});

describe('startCone', () => {
  it('creates a sandbox, polls join.json, appends placeholder then updates registry, returns StartResult', async () => {
    // Use a recent timestamp that will pass the minUpdatedAt check (5s skew margin)
    const updatedAt = new Date().toISOString();
    const substrate = makeStartTestSubstrate({
      joinJson: JSON.stringify({
        joinUrl: 'https://w/join/x',
        trayId: 't-1',
        updatedAt,
      }),
    });
    const registry = new MemRegistry();
    const result = await startCone(
      { substrate, registry },
      {
        envContents: 'ANTHROPIC_API_KEY=sk-x\nE2B_API_KEY=should-be-stripped',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
        name: 'smoke',
      }
    );
    expect(result.joinUrl).toBe('https://w/join/x');
    expect(result.name).toBe('smoke');
    expect(result.sandboxId).toBe('sbx-fake');

    // After completion, should have exactly one entry with the full data (placeholder updated)
    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('smoke');
    expect(entries[0]?.state).toBe('running');
    expect(entries[0]?.lastJoinUpdatedAt).toBe(updatedAt);
    expect(entries[0]?.trayId).toBe('t-1');
    expect(entries[0]?.substrate).toBe('e2b');
    expect(entries[0]?.joinUrl).toBe('https://w/join/x');
  });

  it('throws SANDBOX_NOT_READY when pollCloudStatus times out and cleans up placeholder', async () => {
    const substrate = makeStartTestSubstrate({ joinJson: '{}' }); // no joinUrl → poll never returns
    const registry = new MemRegistry();
    await expect(
      startCone(
        { substrate, registry },
        {
          envContents: '',
          workerBaseUrl: 'https://w',
          sliccVersion: 'test',
          pollTimeoutMs: 200,
          pollIntervalMs: 50,
        }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'SANDBOX_NOT_READY' });
    // Registry should have no entries (placeholder was removed during cleanup).
    expect(await registry.list()).toHaveLength(0);
    // Substrate should have no sandboxes (killed during cleanup).
    expect(await substrate.list()).toHaveLength(0);
  });

  it('includes stderr tail in error message when poll fails', async () => {
    // Create a substrate that seeds stderr but no join.json
    const files = new Map<string, string>();
    files.set(
      '/tmp/slicc-stderr.log',
      'Error: Failed to launch\n  cause: missing deps\nStack trace...'
    );

    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(_opts: CreateOpts): Promise<SandboxHandle> {
        const handle = makeFakeHandle({ sandboxId: 'sbx-err' });
        return {
          sandboxId: handle.sandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: handle.kill,
          getInfo: handle.getInfo,
          writeFile: handle.writeFile,
          readFile: async (path: string) => {
            const content = files.get(path);
            if (!content) throw new Error(`ENOENT ${path}`);
            return content;
          },
          run: handle.run,
        } as SandboxHandle;
      },
      async connect() {
        throw new Error('not used');
      },
      async list(_opts?: import('../src/substrate.js').ListOpts): Promise<SandboxSummary[]> {
        return [];
      },
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {
        // No-op for tests.
      },
    };

    const registry = new MemRegistry();
    await expect(
      startCone(
        { substrate, registry },
        {
          envContents: '',
          workerBaseUrl: 'https://w',
          sliccVersion: 'test',
          pollTimeoutMs: 200,
          pollIntervalMs: 50,
        }
      )
    ).rejects.toThrow(/missing deps/);
  });

  it('appends placeholder entry to registry BEFORE pollCloudStatus runs', async () => {
    // This test protects against the orphan-recovery race: concurrent /list-cones
    // calls should see the new sandbox in the registry (pass 1) during the slow
    // poll window, NOT go through orphan recovery (pass 2).
    const updatedAt = new Date().toISOString();
    let pollStarted = false;
    let entryPresentAtPollStart = false;

    const registry = new MemRegistry();

    // Create a custom substrate that captures the registry state when readFile
    // is first called (which happens inside pollCloudStatus).
    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(_opts: CreateOpts): Promise<SandboxHandle> {
        const handle = makeFakeHandle({ sandboxId: 'sbx-race' });
        return {
          sandboxId: handle.sandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: handle.kill,
          getInfo: handle.getInfo,
          writeFile: handle.writeFile,
          readFile: async (path: string) => {
            if (path === '/tmp/slicc-join.json' && !pollStarted) {
              pollStarted = true;
              // Check if the registry already has an entry for this sandbox
              const entries = await registry.list();
              entryPresentAtPollStart = entries.some((e) => e.sandboxId === 'sbx-race');
            }
            if (path === '/tmp/slicc-join.json') {
              return JSON.stringify({
                joinUrl: 'https://w/join/race',
                trayId: 't-race',
                updatedAt,
              });
            }
            throw new Error(`ENOENT ${path}`);
          },
          run: handle.run,
        } as SandboxHandle;
      },
      async connect() {
        throw new Error('not used');
      },
      async list(_opts?: import('../src/substrate.js').ListOpts): Promise<SandboxSummary[]> {
        return [];
      },
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {
        // No-op for tests.
      },
    };

    await startCone(
      { substrate, registry },
      {
        envContents: '',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
      }
    );

    // The placeholder should have been present in the registry BEFORE pollCloudStatus
    // started reading the file.
    expect(entryPresentAtPollStart).toBe(true);

    // After completion, verify the entry was updated with the real joinUrl
    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe('sbx-race');
    expect(entries[0]?.joinUrl).toBe('https://w/join/race');
  });

  it('rejects stale /tmp/slicc-join.json from template snapshot and waits for fresh one', async () => {
    // Simulate the template-baked stale file → fresh file transition.
    // First read returns stale (updatedAt 1 hour ago), second returns fresh (updatedAt now).
    const staleUpdatedAt = new Date(Date.now() - 3600_000).toISOString();
    const freshUpdatedAt = new Date().toISOString();
    const files = new Map<string, string>();
    let readCount = 0;

    files.set(
      '/tmp/slicc-join.json',
      JSON.stringify({
        joinUrl: 'https://w/join/stale',
        trayId: 't-stale',
        updatedAt: staleUpdatedAt,
      })
    );

    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(_opts: CreateOpts): Promise<SandboxHandle> {
        const handle = makeFakeHandle({ sandboxId: 'sbx-stale' });
        return {
          sandboxId: handle.sandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: handle.kill,
          getInfo: handle.getInfo,
          writeFile: handle.writeFile,
          readFile: async (path: string) => {
            if (path === '/tmp/slicc-join.json') {
              readCount++;
              if (readCount === 1) {
                // First read: stale template-baked file
                return JSON.stringify({
                  joinUrl: 'https://w/join/stale',
                  trayId: 't-stale',
                  updatedAt: staleUpdatedAt,
                });
              } else {
                // Second+ read: fresh file written by node-server
                return JSON.stringify({
                  joinUrl: 'https://w/join/fresh',
                  trayId: 't-fresh',
                  updatedAt: freshUpdatedAt,
                });
              }
            }
            const content = files.get(path);
            if (!content) throw new Error(`ENOENT ${path}`);
            return content;
          },
          run: handle.run,
        } as SandboxHandle;
      },
      async connect() {
        throw new Error('not used');
      },
      async list(_opts?: import('../src/substrate.js').ListOpts): Promise<SandboxSummary[]> {
        return [];
      },
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {
        // No-op for tests.
      },
    };

    const registry = new MemRegistry();
    const result = await startCone(
      { substrate, registry },
      {
        envContents: '',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
        pollTimeoutMs: 2000,
        pollIntervalMs: 50,
      }
    );

    // Should have waited past the stale read and returned the fresh one
    expect(result.joinUrl).toBe('https://w/join/fresh');
    expect(readCount).toBeGreaterThan(1); // Proves the stale read was rejected

    // After update, should have exactly one entry with the fresh data
    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.trayId).toBe('t-fresh');
    expect(entries[0]?.lastJoinUpdatedAt).toBe(freshUpdatedAt);
    expect(entries[0]?.joinUrl).toBe('https://w/join/fresh');
  });

  it('reserveConeStart appends a placeholder entry', async () => {
    // Use makeFakeSubstrate with empty listResult so reserveConeStart doesn't see
    // phantom sandboxes from the substrate
    const substrate = makeFakeSubstrate({ listResult: [] });
    const registry = new MemRegistry();

    const { reservationId } = await reserveConeStart(
      { substrate, registry },
      {
        userId: 'u1',
        name: 'reserved',
        metadata: { userId: 'u1' },
      }
    );

    expect(reservationId).toMatch(/^pending-/);

    // Verify the placeholder was appended
    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe(reservationId);
    expect(entries[0]?.name).toBe('reserved');
    expect(entries[0]?.state).toBe('reserved');
    expect(entries[0]?.joinUrl).toBe('');

    // A second reservation is allowed regardless of existing count.
    const second = await reserveConeStart(
      { substrate, registry },
      {
        userId: 'u1',
        name: 'second',
        metadata: { userId: 'u1' },
        reconciledCones: await registry.list(),
      }
    );
    expect(second.reservationId).toMatch(/^pending-/);
    expect(await registry.list()).toHaveLength(2);
  });

  it('reserveConeStart throws NAME_TAKEN when name conflicts with existing entry', async () => {
    // Pre-populate substrate with the existing sandbox so listCones sees it as live
    const substrate = makeFakeSubstrate({
      listResult: [
        {
          sandboxId: 'sbx-existing',
          name: 'existing',
          state: 'running',
          metadata: { userId: 'u1' },
        },
      ],
    });
    const registry = new MemRegistry();

    // Pre-populate with an existing entry
    await registry.append({
      substrate: 'e2b',
      sandboxId: 'sbx-existing',
      name: 'existing',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://w/join/existing',
      metadata: { userId: 'u1' },
    });

    await expect(
      reserveConeStart(
        { substrate, registry },
        {
          userId: 'u1',
          name: 'existing',
          metadata: { userId: 'u1' },
        }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'NAME_TAKEN' });
  });

  it('startCone with reservationId updates the placeholder entry', async () => {
    const updatedAt = new Date().toISOString();
    // For startCone we can use makeStartTestSubstrate since we're actually creating
    const substrate = makeStartTestSubstrate({
      joinJson: JSON.stringify({
        joinUrl: 'https://w/join/real',
        trayId: 't-real',
        updatedAt,
      }),
    });
    const registry = new MemRegistry();

    // First reserve a slot — use a clean substrate for this phase
    const reserveSubstrate = makeFakeSubstrate({ listResult: [] });
    const { reservationId } = await reserveConeStart(
      { substrate: reserveSubstrate, registry },
      {
        userId: 'u1',
        name: 'reserved',
        metadata: { userId: 'u1' },
      }
    );

    // Verify placeholder exists
    let entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe(reservationId);

    // Now call startCone with the reservation (use the real substrate for create)
    const result = await startCone(
      { substrate, registry },
      {
        reservationId,
        envContents: '',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
        name: 'reserved',
        metadata: { userId: 'u1' },
      }
    );

    expect(result.sandboxId).toBe('sbx-fake');
    expect(result.joinUrl).toBe('https://w/join/real');

    // Verify the placeholder was replaced with the real entry
    entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe('sbx-fake');
    expect(entries[0]?.name).toBe('reserved');
    expect(entries[0]?.joinUrl).toBe('https://w/join/real');
  });

  it('removes reservation when substrate.create fails', async () => {
    const registry = new MemRegistry();
    // Seed a reservation in the registry (as if reserveConeStart was called):
    const reservationId = 'pending-test-uuid';
    await registry.append({
      sandboxId: reservationId,
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      state: 'reserved',
      joinUrl: '',
    });
    // Substrate that fails on create
    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(): Promise<SandboxHandle> {
        throw new Error('e2b boom');
      },
      async connect() {
        throw new Error('not used');
      },
      async list() {
        return [];
      },
      async extendTimeout() {},
    };
    await expect(
      startCone(
        { substrate, registry },
        {
          reservationId,
          envContents: '',
          workerBaseUrl: 'https://w',
          sliccVersion: 'test',
        }
      )
    ).rejects.toThrow('e2b boom');
    expect(registry.entries.find((e) => e.sandboxId === reservationId)).toBeUndefined();
  });

  it('removes real entry when pollCloudStatus fails after sandbox swap', async () => {
    const registry = new MemRegistry();
    const reservationId = 'pending-test-uuid-2';
    await registry.append({
      sandboxId: reservationId,
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      state: 'reserved',
      joinUrl: '',
    });

    let killCalled = false;
    const realSandboxId = 'sbx-created';

    // Substrate creates successfully but readFile never returns joinUrl (poll fails)
    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(): Promise<SandboxHandle> {
        const handle = makeFakeHandle({ sandboxId: realSandboxId });
        return {
          sandboxId: realSandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: async () => {
            killCalled = true;
          },
          getInfo: handle.getInfo,
          writeFile: handle.writeFile,
          readFile: async (path: string) => {
            if (path === '/tmp/slicc-join.json') {
              // Return stale data that fails minUpdatedAt check
              return JSON.stringify({
                joinUrl: 'https://w/join/stale',
                trayId: 't-stale',
                updatedAt: '2020-01-01T00:00:00.000Z',
              });
            }
            if (path === '/tmp/slicc-stderr.log') return 'no logs';
            throw new Error(`ENOENT ${path}`);
          },
          run: handle.run,
        };
      },
      async connect() {
        throw new Error('not used');
      },
      async list() {
        return [];
      },
      async extendTimeout() {},
    };

    await expect(
      startCone(
        { substrate, registry },
        {
          reservationId,
          envContents: '',
          workerBaseUrl: 'https://w',
          sliccVersion: 'test',
          pollTimeoutMs: 200,
          pollIntervalMs: 50,
        }
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_READY' });

    // Assert: reservation was removed, real entry was removed, sandbox was killed
    expect(registry.entries.find((e) => e.sandboxId === reservationId)).toBeUndefined();
    expect(registry.entries.find((e) => e.sandboxId === realSandboxId)).toBeUndefined();
    expect(killCalled).toBe(true);
  });
});
