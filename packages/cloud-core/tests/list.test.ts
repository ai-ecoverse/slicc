import { describe, it, expect } from 'vitest';
import { listCones } from '../src/operations/list.js';
import type { ConeEntry, Registry, SandboxSubstrate, SandboxSummary } from '../src/index.js';

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

function fakeSubstrate(sandboxes: SandboxSummary[]): SandboxSubstrate {
  return {
    id: 'e2b',
    async create() {
      throw new Error('not used');
    },
    async connect() {
      throw new Error('not used');
    },
    async list() {
      return sandboxes;
    },
  };
}

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
    const substrate = fakeSubstrate([
      { sandboxId: 's-1', state: 'running', metadata: { name: 'mine' } },
    ]);
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
    const substrate = fakeSubstrate([]); // empty
    const result = await listCones({ substrate, registry });
    expect(result[0]?.state).toBe('dead');
    expect(registry.entries[0]?.state).toBe('dead');
  });

  it('rebuilds orphans (substrate sandboxes not in registry) into the registry', async () => {
    const registry = new MemRegistry();
    const substrate = fakeSubstrate([
      { sandboxId: 's-orphan', state: 'running', metadata: { name: 'orphan' } },
    ]);
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
    const substrate = fakeSubstrate([
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
    ]);
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
    const substrate = fakeSubstrate([]); // empty
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
    const substrate = fakeSubstrate([{ sandboxId: 's-running', state: 'running', metadata: {} }]);
    const initialEntry = { ...registry.entries[0]! };
    await listCones({ substrate, registry });
    // State should remain unchanged (not re-written):
    expect(registry.entries[0]).toEqual(initialEntry);
  });

  it('recovers metadata fields from substrate during orphan recovery', async () => {
    const registry = new MemRegistry();
    const substrate = fakeSubstrate([
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
    ]);
    const result = await listCones({ substrate, registry });
    const recovered = result.find((c) => c.sandboxId === 's-orphan-with-meta');
    expect(recovered?.name).toBe('custom-name');
    expect(recovered?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(recovered?.joinUrl).toBe('https://custom/join/url');
    expect(recovered?.trayId).toBe('tray-123');
    expect(recovered?.lastJoinUpdatedAt).toBe('2026-01-02T00:00:00Z');
  });
});
