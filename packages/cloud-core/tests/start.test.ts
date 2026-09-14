import { describe, expect, it } from 'vitest';
import type {
  CreateOpts,
  SandboxHandle,
  SandboxSubstrate,
  SandboxSummary,
  SubstrateId,
} from '../src/index.js';
import { reserveSlot, startCone } from '../src/operations/start.js';
import { MemRegistry, makeFakeHandle, makeFakeSubstrate } from './fixtures/index.js';

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
    async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {},
  };
}

describe('reserveSlot', () => {
  it('throws CAP_EXCEEDED when paused cap is at limit', async () => {
    const registry = new MemRegistry();

    for (let i = 0; i < 2; i++) {
      await registry.append({
        sandboxId: `s${i}`,
        substrate: 'e2b',
        createdAt: '',
        lastSeen: '',
        state: 'paused',
        joinUrl: 'https://w',
      });
    }
    const substrate = makeFakeSubstrate({
      listResult: [
        { sandboxId: 's0', state: 'paused', metadata: {} },
        { sandboxId: 's1', state: 'paused', metadata: {} },
      ],
    });
    await expect(
      reserveSlot(
        { substrate, registry },
        {
          metadata: {},
          sliccVersion: 'test',
          env: { CONE_CAP_RUNNING: '5', CONE_CAP_PAUSED: '2' },
        }
      )
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });
});

describe('startCone', () => {
  it('creates a sandbox, polls join.json, appends placeholder then updates registry, returns StartResult', async () => {
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
    const substrate = makeStartTestSubstrate({ joinJson: '{}' });
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

    expect(await registry.list()).toHaveLength(0);

    expect(await substrate.list()).toHaveLength(0);
  });

  it('includes stderr tail in error message when poll fails', async () => {
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
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {},
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
    const updatedAt = new Date().toISOString();
    let pollStarted = false;
    let entryPresentAtPollStart = false;

    const registry = new MemRegistry();

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
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {},
    };

    await startCone(
      { substrate, registry },
      {
        envContents: '',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
      }
    );

    expect(entryPresentAtPollStart).toBe(true);

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe('sbx-race');
    expect(entries[0]?.joinUrl).toBe('https://w/join/race');
  });

  it('rejects stale /tmp/slicc-join.json from template snapshot and waits for fresh one', async () => {
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
                return JSON.stringify({
                  joinUrl: 'https://w/join/stale',
                  trayId: 't-stale',
                  updatedAt: staleUpdatedAt,
                });
              } else {
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
      async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {},
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

    expect(result.joinUrl).toBe('https://w/join/fresh');
    expect(readCount).toBeGreaterThan(1);

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.trayId).toBe('t-fresh');
    expect(entries[0]?.lastJoinUpdatedAt).toBe(freshUpdatedAt);
    expect(entries[0]?.joinUrl).toBe('https://w/join/fresh');
  });

  it('reserveSlot appends a placeholder entry that counts toward cap', async () => {
    const substrate = makeFakeSubstrate({ listResult: [] });
    const registry = new MemRegistry();

    const { reservationId } = await reserveSlot(
      { substrate, registry },
      {
        userId: 'u1',
        name: 'reserved',
        metadata: { userId: 'u1' },
        sliccVersion: 'test',
        env: { CONE_CAP_RUNNING: '1', CONE_CAP_PAUSED: '5' },
      }
    );

    expect(reservationId).toMatch(/^pending-/);

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe(reservationId);
    expect(entries[0]?.name).toBe('reserved');
    expect(entries[0]?.state).toBe('reserved');
    expect(entries[0]?.joinUrl).toBe('');

    await expect(
      reserveSlot(
        { substrate, registry },
        {
          userId: 'u1',
          name: 'second',
          metadata: { userId: 'u1' },
          sliccVersion: 'test',
          env: { CONE_CAP_RUNNING: '1', CONE_CAP_PAUSED: '5' },
        }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'CAP_EXCEEDED' });
  });

  it('reserveSlot throws NAME_TAKEN when name conflicts with existing entry', async () => {
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
      reserveSlot(
        { substrate, registry },
        {
          userId: 'u1',
          name: 'existing',
          metadata: { userId: 'u1' },
          sliccVersion: 'test',
          env: { CONE_CAP_RUNNING: '5', CONE_CAP_PAUSED: '5' },
        }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'NAME_TAKEN' });
  });

  it('startCone with reservationId updates the placeholder entry', async () => {
    const updatedAt = new Date().toISOString();

    const substrate = makeStartTestSubstrate({
      joinJson: JSON.stringify({
        joinUrl: 'https://w/join/real',
        trayId: 't-real',
        updatedAt,
      }),
    });
    const registry = new MemRegistry();

    const reserveSubstrate = makeFakeSubstrate({ listResult: [] });
    const { reservationId } = await reserveSlot(
      { substrate: reserveSubstrate, registry },
      {
        userId: 'u1',
        name: 'reserved',
        metadata: { userId: 'u1' },
        sliccVersion: 'test',
        env: { CONE_CAP_RUNNING: '5', CONE_CAP_PAUSED: '5' },
      }
    );

    let entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe(reservationId);

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

    entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sandboxId).toBe('sbx-fake');
    expect(entries[0]?.name).toBe('reserved');
    expect(entries[0]?.joinUrl).toBe('https://w/join/real');
  });

  it('removes reservation when substrate.create fails', async () => {
    const registry = new MemRegistry();

    const reservationId = 'pending-test-uuid';
    await registry.append({
      sandboxId: reservationId,
      substrate: 'e2b',
      createdAt: '',
      lastSeen: '',
      state: 'reserved',
      joinUrl: '',
    });

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

    expect(registry.entries.find((e) => e.sandboxId === reservationId)).toBeUndefined();
    expect(registry.entries.find((e) => e.sandboxId === realSandboxId)).toBeUndefined();
    expect(killCalled).toBe(true);
  });
});
