import { describe, it, expect } from 'vitest';
import { resumeCone } from '../src/operations/resume.js';
import type {
  ConeEntry,
  Registry,
  SandboxSubstrate,
  SandboxHandle,
  RunResult,
  SubstrateId,
  CreateOpts,
} from '../src/index.js';

class MemRegistry implements Registry {
  entries: ConeEntry[] = [];
  async list() {
    return [...this.entries];
  }
  async findByNameOrId(q: string) {
    return this.entries.find((e) => e.sandboxId === q || e.name === q) ?? null;
  }
  async append(e: ConeEntry) {
    const i = this.entries.findIndex((x) => x.sandboxId === e.sandboxId);
    if (i >= 0) this.entries[i] = { ...this.entries[i]!, ...e };
    else this.entries.push(e);
  }
  async update(id: string, patch: Partial<ConeEntry>) {
    const i = this.entries.findIndex((e) => e.sandboxId === id);
    if (i < 0) throw new Error(`entry not found: ${id}`);
    this.entries[i] = { ...this.entries[i]!, ...patch };
  }
  async remove(id: string) {
    this.entries = this.entries.filter((e) => e.sandboxId !== id);
  }
}

// Mocked handle that lets tests control behavior.
function makeHandle(overrides: {
  joinJson?: string;
  kickStatus?: string;
  kickExitCode?: number;
  writes?: Array<{ path: string; contents: string | Uint8Array }>;
}): SandboxHandle {
  const writes = overrides.writes ?? [];
  return {
    sandboxId: 'sbx-1',
    substrate: 'e2b' as SubstrateId,
    pause: async () => {},
    kill: async () => {},
    getInfo: async () => ({ sandboxId: 'sbx-1', state: 'running', metadata: {}, createdAt: '' }),
    writeFile: async (path: string, contents: string | Uint8Array) => {
      writes.push({ path, contents });
    },
    readFile: async (path: string): Promise<string> => {
      if (path === '/tmp/slicc-join.json') {
        return (
          overrides.joinJson ??
          JSON.stringify({
            joinUrl: 'https://w/join/new',
            trayId: 't-new',
            updatedAt: new Date().toISOString(),
            sliccVersion: 'test',
          })
        );
      }
      throw new Error(`ENOENT ${path}`);
    },
    run: async (_cmd: string): Promise<RunResult> => ({
      stdout: overrides.kickStatus ?? '200',
      stderr: '',
      exitCode: overrides.kickExitCode ?? 0,
    }),
  };
}

function fakeSubstrate(handle: SandboxHandle): SandboxSubstrate {
  return {
    id: 'e2b',
    async create(_opts: CreateOpts) {
      throw new Error('not used');
    },
    async connect(_id: string) {
      return handle;
    },
    async list() {
      return [];
    },
  };
}

describe('resumeCone', () => {
  it('resumes a paused cone and updates registry with refreshed joinUrl', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://old/join',
      lastSeen: '',
      state: 'paused',
      trayId: 't-old',
      lastJoinUpdatedAt: '2026-05-01T00:00:00.000Z',
    });
    const substrate = fakeSubstrate(makeHandle({}));
    const result = await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'test',
      }
    );
    expect(result.joinUrl).toBe('https://w/join/new');
    expect(result.trayRebuilt).toBe(true); // t-old → t-new
    expect(registry.entries[0]?.state).toBe('running');
    expect(registry.entries[0]?.trayId).toBe('t-new');
    expect(registry.entries[0]?.joinUrl).toBe('https://w/join/new');
  });

  it('throws NOT_FOUND when query does not match', async () => {
    const registry = new MemRegistry();
    const substrate = fakeSubstrate(makeHandle({}));
    await expect(
      resumeCone({ substrate, registry }, { query: 'missing', localSliccVersion: 'test' })
    ).rejects.toMatchObject({ name: 'CloudError', code: 'NOT_FOUND' });
  });

  it('throws ALREADY_RUNNING when entry is already running', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join',
      lastSeen: '',
      state: 'running',
    });
    const substrate = fakeSubstrate(makeHandle({}));
    await expect(
      resumeCone({ substrate, registry }, { query: 'sbx-1', localSliccVersion: 'test' })
    ).rejects.toMatchObject({ name: 'CloudError', code: 'ALREADY_RUNNING' });
  });

  it('writes refreshSecretsContents to /slicc/secrets.env when provided', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join',
      lastSeen: '',
      state: 'paused',
    });
    const writes: Array<{ path: string; contents: string | Uint8Array }> = [];
    const handle = makeHandle({ writes });
    const substrate = fakeSubstrate(handle);
    await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'test',
        refreshSecretsContents: 'ADOBE_IMS_TOKEN=fresh',
      }
    );
    expect(writes).toContainEqual({
      path: '/slicc/secrets.env',
      contents: 'ADOBE_IMS_TOKEN=fresh',
    });
  });

  it('throws LEADER_NOT_READY when kick returns unexpected status', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join',
      lastSeen: '',
      state: 'paused',
    });
    const substrate = fakeSubstrate(makeHandle({ kickStatus: '418' }));
    await expect(
      resumeCone({ substrate, registry }, { query: 'sbx-1', localSliccVersion: 'test' })
    ).rejects.toMatchObject({ name: 'CloudError', code: 'LEADER_NOT_READY' });
  });

  it('reports versionMismatch when running version differs from local', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join',
      lastSeen: '',
      state: 'paused',
      lastJoinUpdatedAt: '2026-05-01T00:00:00.000Z',
    });
    const substrate = fakeSubstrate(
      makeHandle({
        joinJson: JSON.stringify({
          joinUrl: 'https://w/join/new',
          trayId: 't-new',
          updatedAt: new Date().toISOString(),
          sliccVersion: 'v1.2.3',
        }),
      })
    );
    const result = await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'v1.0.0',
      }
    );
    expect(result.versionMismatch).toEqual({ running: 'v1.2.3', local: 'v1.0.0' });
  });

  it('does not report trayRebuilt when no baseline trayId', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join',
      lastSeen: '',
      state: 'paused',
      lastJoinUpdatedAt: '2026-05-01T00:00:00.000Z',
      // No trayId in baseline
    });
    const substrate = fakeSubstrate(makeHandle({}));
    const result = await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'test',
      }
    );
    expect(result.trayRebuilt).toBe(false);
  });
});
