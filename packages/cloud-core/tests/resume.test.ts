import { describe, expect, it } from 'vitest';
import type { RunResult, SandboxHandle, SubstrateId } from '../src/index.js';
import { resumeCone } from '../src/operations/resume.js';
import { MemRegistry, makeFakeSubstrate } from './fixtures/index.js';

// Specialized handle for resume tests: configurable joinJson and kick behavior.
function makeResumeTestHandle(overrides: {
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
    getInfo: async () => ({
      sandboxId: 'sbx-1',
      state: 'running' as const,
      metadata: {},
      createdAt: '',
    }),
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
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({}),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({}),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({}),
    });
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
    const handle = makeResumeTestHandle({ writes });
    const substrate = makeFakeSubstrate({ handle });
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
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({ kickStatus: '418' }),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({
        joinJson: JSON.stringify({
          joinUrl: 'https://w/join/new',
          trayId: 't-new',
          updatedAt: new Date().toISOString(),
          sliccVersion: 'v1.2.3',
        }),
      }),
    });
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
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({}),
    });
    const result = await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'test',
      }
    );
    expect(result.trayRebuilt).toBe(false);
  });

  it('rejects an older /tmp/slicc-join.json on resume (stale file)', async () => {
    const registry = new MemRegistry();
    const baselineUpdatedAt = '2026-05-01T12:00:00.000Z';
    const olderUpdatedAt = '2026-05-01T11:00:00.000Z'; // 1 hour earlier
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join/old',
      lastSeen: '',
      state: 'paused',
      lastJoinUpdatedAt: baselineUpdatedAt,
    });
    const substrate = makeFakeSubstrate({
      handle: makeResumeTestHandle({
        joinJson: JSON.stringify({
          joinUrl: 'https://w/join/stale',
          trayId: 't-stale',
          updatedAt: olderUpdatedAt,
        }),
      }),
    });
    await expect(
      resumeCone(
        { substrate, registry },
        {
          query: 'sbx-1',
          localSliccVersion: 'test',
          pollTimeoutMs: 200,
          pollIntervalMs: 50,
        }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'LEADER_NOT_READY' });
  });

  it('applies coneConfigDelta over existing files when both are present', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 'sbx-1',
      substrate: 'e2b',
      createdAt: '',
      joinUrl: 'https://w/join',
      lastSeen: '',
      state: 'paused',
    });
    const existingConfig = JSON.stringify({
      model: 'adobe:claude-opus-4-6',
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'old' }],
    });
    const existingSecrets =
      'ADOBE_IMS_TOKEN=old\nADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy\n' +
      'GITHUB_TOKEN=user-pat\nGITHUB_TOKEN_DOMAINS=github.com\n';
    const writes: Array<{ path: string; contents: string | Uint8Array }> = [];
    const base = makeResumeTestHandle({ writes });
    const handle: SandboxHandle = {
      ...base,
      readFile: async (path: string): Promise<string> => {
        if (path === '/slicc/cone-config.json') return existingConfig;
        if (path === '/slicc/secrets.env') return existingSecrets;
        return base.readFile(path);
      },
    };
    const substrate = makeFakeSubstrate({ handle });
    await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'test',
        coneConfigDelta: {
          upsert: {
            secrets: [{ name: 'OPENAI_API_KEY', value: 'sk-new', domains: ['api.openai.com'] }],
          },
        },
      }
    );
    const secretsWrite = writes.find((w) => w.path === '/slicc/secrets.env');
    expect(secretsWrite).toBeDefined();
    expect(String(secretsWrite?.contents)).toContain('GITHUB_TOKEN=user-pat');
    expect(String(secretsWrite?.contents)).toContain('OPENAI_API_KEY=sk-new');
    expect(String(secretsWrite?.contents)).toContain('ADOBE_IMS_TOKEN=old');
  });

  it('treats a missing cone-config.json / secrets.env as empty (ENOENT is a real absent-file case)', async () => {
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
    // Default makeResumeTestHandle throws ENOENT for anything other than
    // /tmp/slicc-join.json — mirrors a pre-feature cone with no persisted config.
    const substrate = makeFakeSubstrate({ handle: makeResumeTestHandle({ writes }) });
    await resumeCone(
      { substrate, registry },
      {
        query: 'sbx-1',
        localSliccVersion: 'test',
        coneConfigDelta: {
          upsert: { secrets: [{ name: 'OPENAI_API_KEY', value: 'sk', domains: ['x'] }] },
        },
      }
    );
    // Wrote a fresh pair (delta-applied-to-empty-base is the legitimate outcome here).
    expect(writes.some((w) => w.path === '/slicc/secrets.env')).toBe(true);
    expect(writes.some((w) => w.path === '/slicc/cone-config.json')).toBe(true);
  });

  it('aborts before writing when readFile hits a transient sandbox fault (does not wipe existing config)', async () => {
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
    const base = makeResumeTestHandle({ writes });
    const handle: SandboxHandle = {
      ...base,
      readFile: async (path: string): Promise<string> => {
        if (path === '/slicc/cone-config.json') {
          // Simulate an e2b transient error (5xx / socket reset / FS not ready).
          throw new Error('sandbox request failed: 503 Service Unavailable');
        }
        return base.readFile(path);
      },
    };
    const substrate = makeFakeSubstrate({ handle });
    await expect(
      resumeCone(
        { substrate, registry },
        {
          query: 'sbx-1',
          localSliccVersion: 'test',
          coneConfigDelta: {
            upsert: { secrets: [{ name: 'OPENAI_API_KEY', value: 'sk', domains: ['x'] }] },
          },
        }
      )
    ).rejects.toMatchObject({
      name: 'CloudError',
      code: 'INTERNAL',
      message: expect.stringContaining('/slicc/cone-config.json'),
    });
    // Critically: no writeFile ran, so the on-disk config was NOT overwritten
    // with a delta-applied-to-empty-base (issue #1357).
    expect(writes).toEqual([]);
  });
});
