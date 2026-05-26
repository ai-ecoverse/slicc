import { describe, it, expect } from 'vitest';
import { killCone, type CloudError } from '../src/index.js';
import type {
  ConeEntry,
  Registry,
  SandboxSubstrate,
  SandboxHandle,
  SubstrateId,
} from '../src/index.js';

class MemRegistry implements Registry {
  entries: ConeEntry[] = [];

  async list(): Promise<ConeEntry[]> {
    return [...this.entries];
  }

  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    return this.entries.find((e) => e.sandboxId === query || e.name === query) ?? null;
  }

  async append(entry: ConeEntry): Promise<void> {
    const i = this.entries.findIndex((x) => x.sandboxId === entry.sandboxId);
    if (i >= 0) {
      this.entries[i] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  async update(id: string, patch: Partial<ConeEntry>): Promise<void> {
    const i = this.entries.findIndex((e) => e.sandboxId === id);
    if (i < 0) throw new Error(`not found ${id}`);
    this.entries[i] = { ...this.entries[i]!, ...patch };
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.sandboxId !== id);
  }
}

function makeHandle(throwOnKill?: Error): SandboxHandle {
  return {
    sandboxId: 'sbx-test-1',
    substrate: 'e2b' as SubstrateId,
    pause: async () => {},
    kill: async () => {
      if (throwOnKill) throw throwOnKill;
    },
    getInfo: async () => ({
      sandboxId: 'sbx-test-1',
      state: 'running',
      metadata: {},
      createdAt: new Date().toISOString(),
    }),
    writeFile: async () => {},
    readFile: async () => '',
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

function fakeSubstrate(handle: SandboxHandle, throwOnConnect?: Error): SandboxSubstrate {
  return {
    id: 'e2b',
    async create() {
      throw new Error('not used');
    },
    async connect(_id: string) {
      if (throwOnConnect) throw throwOnConnect;
      return handle;
    },
    async list() {
      return [];
    },
  };
}

describe('killCone', () => {
  it('kills sandbox and removes registry entry', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: 'https://tray.example.com/join/abc123',
      state: 'running',
    });
    const substrate = fakeSubstrate(makeHandle());
    const result = await killCone({ substrate, registry }, 'sbx-1');
    expect(result).toEqual({ sandboxId: 'sbx-1', alreadyDead: false });
    expect(registry.entries).toEqual([]);
  });

  it('throws NOT_FOUND when query has no match', async () => {
    const registry = new MemRegistry();
    const substrate = fakeSubstrate(makeHandle());
    let caught: CloudError | null = null;
    try {
      await killCone({ substrate, registry }, 'missing');
    } catch (err) {
      caught = err as CloudError;
    }
    expect(caught).toBeTruthy();
    expect(caught?.code).toBe('NOT_FOUND');
    expect(caught?.message).toContain('cloud session not found');
  });

  it('still removes registry entry if substrate.kill says sandbox is already gone', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: 'https://tray.example.com/join/paused123',
      state: 'paused',
    });
    const notFoundErr = new Error('unknown sandbox id');
    const substrate = fakeSubstrate(makeHandle(notFoundErr));
    const result = await killCone({ substrate, registry }, 'sbx-1');
    expect(result.alreadyDead).toBe(true);
    expect(result.sandboxId).toBe('sbx-1');
    expect(registry.entries).toEqual([]);
  });

  it('handles "not found" pattern variations', async () => {
    const patterns = ['sandbox not found', 'unknown sandbox', '404 not found', 'does not exist'];
    for (const pattern of patterns) {
      const registry = new MemRegistry();
      await registry.append({
        sandboxId: 'sbx-test',
        substrate: 'e2b',
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        joinUrl: 'https://tray.example.com/join/test',
        state: 'running',
      });
      const err = new Error(pattern);
      const substrate = fakeSubstrate(makeHandle(err));
      const result = await killCone({ substrate, registry }, 'sbx-test');
      expect(result.alreadyDead).toBe(true);
      expect(registry.entries).toEqual([]);
    }
  });

  it('finds entry by name', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      name: 'my-prod-session',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: 'https://tray.example.com/join/prod123',
      state: 'running',
    });
    const substrate = fakeSubstrate(makeHandle());
    const result = await killCone({ substrate, registry }, 'my-prod-session');
    expect(result.sandboxId).toBe('sbx-1');
    expect(registry.entries).toEqual([]);
  });

  it('re-throws non-NotFound errors from kill', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: 'https://tray.example.com/join/net123',
      state: 'running',
    });
    const networkErr = new Error('network timeout');
    const substrate = fakeSubstrate(makeHandle(networkErr));
    let caught: CloudError | null = null;
    try {
      await killCone({ substrate, registry }, 'sbx-1');
    } catch (err) {
      caught = err as CloudError;
    }
    expect(caught).toBeTruthy();
    expect(caught?.code).toBe('INTERNAL');
    expect(caught?.message).toContain('network timeout');
    // Registry entry should still exist since we didn't get past the throw.
    expect(registry.entries.length).toBe(1);
    expect(registry.entries[0]?.sandboxId).toBe('sbx-1');
  });

  it('handles case-insensitive "not found" patterns', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: 'https://tray.example.com/join/case123',
      state: 'running',
    });
    // Test case insensitivity
    const err = new Error('NOT FOUND IN THE SYSTEM');
    const substrate = fakeSubstrate(makeHandle(err));
    const result = await killCone({ substrate, registry }, 'sbx-1');
    expect(result.alreadyDead).toBe(true);
    expect(registry.entries).toEqual([]);
  });
});
