import { describe, expect, it } from 'vitest';
import type { ConnectOpts, SandboxHandle, SubstrateId } from '../src/index.js';
import { CloudError, killCone } from '../src/index.js';
import { MemRegistry, makeFakeSubstrate } from './fixtures/index.js';

// Specialized handle for kill tests: allows controlled throw on kill.
function makeKillTestHandle(throwOnKill?: Error): SandboxHandle {
  return {
    sandboxId: 'sbx-test-1',
    substrate: 'e2b' as SubstrateId,
    pause: async () => {},
    kill: async () => {
      if (throwOnKill) throw throwOnKill;
    },
    getInfo: async () => ({
      sandboxId: 'sbx-test-1',
      state: 'running' as const,
      metadata: {},
      createdAt: new Date().toISOString(),
    }),
    writeFile: async () => {},
    readFile: async () => '',
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
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
    const substrate = makeFakeSubstrate({
      handle: makeKillTestHandle(),
    });
    const result = await killCone({ substrate, registry }, 'sbx-1');
    expect(result).toEqual({ sandboxId: 'sbx-1', alreadyDead: false });
    expect(registry.entries).toEqual([]);
  });

  it('throws NOT_FOUND when query has no match', async () => {
    const registry = new MemRegistry();
    const substrate = makeFakeSubstrate({
      handle: makeKillTestHandle(),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeKillTestHandle(notFoundErr),
    });
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
      const substrate = makeFakeSubstrate({
        handle: makeKillTestHandle(err),
      });
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
    const substrate = makeFakeSubstrate({
      handle: makeKillTestHandle(),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeKillTestHandle(networkErr),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeKillTestHandle(err),
    });
    const result = await killCone({ substrate, registry }, 'sbx-1');
    expect(result.alreadyDead).toBe(true);
    expect(registry.entries).toEqual([]);
  });

  it('opts in to the cold-boot retry so an unresponsive-guest sandbox stays killable', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: '',
      state: 'paused',
    });
    const connectCalls: Array<{ sandboxId: string; opts?: ConnectOpts }> = [];
    const substrate = makeFakeSubstrate({ handle: makeKillTestHandle(), connectCalls });

    await killCone({ substrate, registry }, 'sbx-1');

    expect(connectCalls).toEqual([{ sandboxId: 'sbx-1', opts: { rebootIfUnresponsive: true } }]);
    expect(registry.entries).toEqual([]);
  });

  it('keeps the registry entry when even the cold boot fails (SANDBOX_UNRESPONSIVE)', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      joinUrl: '',
      state: 'paused',
    });
    const substrate = makeFakeSubstrate({
      connectError: new CloudError(
        'SANDBOX_UNRESPONSIVE',
        'Sandbox sbx-1 is unresponsive: cold-booting it from its disk failed too (boot timed out).'
      ),
    });

    await expect(killCone({ substrate, registry }, 'sbx-1')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('Registry entry NOT removed'),
    });
    expect(registry.entries).toHaveLength(1);
  });
});
