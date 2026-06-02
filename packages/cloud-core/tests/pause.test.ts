import { describe, expect, it } from 'vitest';
import type { RunResult, SandboxHandle, SandboxInfo, SubstrateId } from '../src/index.js';
import { CloudError, pauseCone } from '../src/index.js';
import { MemRegistry, makeFakeSubstrate } from './fixtures/index.js';

// Specialized handle for pause tests: tracks paused state separately and reflects in getInfo.
function makePauseTestHandle(id: string, paused = { value: false }): SandboxHandle {
  return {
    sandboxId: id,
    substrate: 'e2b' as SubstrateId,
    pause: async () => {
      paused.value = true;
    },
    kill: async () => {
      // noop
    },
    getInfo: async (): Promise<SandboxInfo> => {
      const state: 'running' | 'paused' = paused.value ? 'paused' : 'running';
      return {
        sandboxId: id,
        state,
        metadata: {},
        createdAt: new Date().toISOString(),
      };
    },
    writeFile: async () => {
      // noop
    },
    readFile: async () => '',
    run: async (): Promise<RunResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
  };
}

describe('pauseCone', () => {
  it('pauses a running cone and updates registry state', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://example.com/join',
    });

    const pausedFlag = { value: false };
    const substrate = makeFakeSubstrate({
      handle: makePauseTestHandle('s-1', pausedFlag),
    });

    await pauseCone({ substrate, registry }, 's-1');

    expect(pausedFlag.value).toBe(true);
    const entry = await registry.findByNameOrId('s-1');
    expect(entry).toBeDefined();
    expect(entry?.state).toBe('paused');
  });

  it('throws NOT_FOUND when query does not match', async () => {
    const registry = new MemRegistry();
    const substrate = makeFakeSubstrate({
      handle: makePauseTestHandle('s-x'),
    });

    await expect(pauseCone({ substrate, registry }, 'missing')).rejects.toThrow();
    let thrownErr: Error | undefined;
    try {
      await pauseCone({ substrate, registry }, 'missing');
    } catch (err) {
      thrownErr = err as Error;
    }
    expect(thrownErr).toBeInstanceOf(CloudError);
    const cloudErr = thrownErr as CloudError;
    expect(cloudErr.code).toBe('NOT_FOUND');
    expect(cloudErr.message).toContain('cloud session not found');
  });

  it('throws ALREADY_PAUSED when entry is already paused', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-2',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'paused',
      joinUrl: 'https://example.com/join',
    });

    const substrate = makeFakeSubstrate({
      handle: makePauseTestHandle('s-2'),
    });

    let thrownErr: Error | undefined;
    try {
      await pauseCone({ substrate, registry }, 's-2');
    } catch (err) {
      thrownErr = err as Error;
    }
    expect(thrownErr).toBeInstanceOf(CloudError);
    const cloudErr = thrownErr as CloudError;
    expect(cloudErr.code).toBe('ALREADY_PAUSED');
    expect(cloudErr.message).toContain('already paused');
  });

  it('preserves trayId and lastJoinUpdatedAt on pause', async () => {
    const registry = new MemRegistry();
    const originalTrayId = 'tray-123';
    const originalLastJoinUpdatedAt = '2026-05-22T10:00:00Z';

    await registry.append({
      sandboxId: 's-3',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://example.com/join',
      trayId: originalTrayId,
      lastJoinUpdatedAt: originalLastJoinUpdatedAt,
    });

    const substrate = makeFakeSubstrate({
      handle: makePauseTestHandle('s-3'),
    });
    await pauseCone({ substrate, registry }, 's-3');

    const entry = await registry.findByNameOrId('s-3');
    expect(entry?.trayId).toBe(originalTrayId);
    expect(entry?.lastJoinUpdatedAt).toBe(originalLastJoinUpdatedAt);
  });

  it('finds entry by name', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-4',
      name: 'my-session',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://example.com/join',
    });

    const pausedFlag = { value: false };
    const substrate = makeFakeSubstrate({
      handle: makePauseTestHandle('s-4', pausedFlag),
    });

    await pauseCone({ substrate, registry }, 'my-session');

    expect(pausedFlag.value).toBe(true);
    const entry = await registry.findByNameOrId('my-session');
    expect(entry?.state).toBe('paused');
  });

  it('throws ALREADY_RUNNING when entry is reserved', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-reserved',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'reserved',
      joinUrl: '',
      reservedAt: new Date().toISOString(),
    });

    const substrate = makeFakeSubstrate({
      handle: makePauseTestHandle('s-reserved'),
    });

    let thrownErr: Error | undefined;
    try {
      await pauseCone({ substrate, registry }, 's-reserved');
    } catch (err) {
      thrownErr = err as Error;
    }
    expect(thrownErr).toBeInstanceOf(CloudError);
    const cloudErr = thrownErr as CloudError;
    expect(cloudErr.code).toBe('ALREADY_RUNNING');
    expect(cloudErr.message).toContain('being started/resumed');
  });
});
