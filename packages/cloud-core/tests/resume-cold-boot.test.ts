import { describe, expect, it } from 'vitest';
import type { ConnectOpts, RunResult, SandboxHandle, SubstrateId } from '../src/index.js';
import { CloudError, resumeCone } from '../src/index.js';
import { MemRegistry, makeFakeSubstrate } from './fixtures/index.js';

// Resume of a sandbox whose memory snapshot e2b refuses to restore because the
// guest was unresponsive when it was paused (GuestUnresponsiveError). The
// substrate cold-boots it from disk and flags the handle `coldBooted`; these
// tests pin what resumeCone does with that flag. No e2b calls: the substrate
// and handle are in-memory fakes.

const BASELINE = '2026-05-01T00:00:00.000Z';

type Event =
  | { kind: 'write'; path: string }
  | { kind: 'run'; cmd: string }
  | { kind: 'spawn'; cmd: string };

interface ColdBootHandleOpts {
  coldBooted?: boolean;
  /** Whether something answers on :5710 after the boot (default: nothing). */
  nodeServerUp?: boolean;
  /** Omit `spawn` to model a substrate that cannot start background work. */
  withSpawn?: boolean;
}

function makeHandle(opts: ColdBootHandleOpts = {}): { handle: SandboxHandle; events: Event[] } {
  const events: Event[] = [];
  const handle: SandboxHandle = {
    sandboxId: 'sbx-1',
    substrate: 'e2b' as SubstrateId,
    ...(opts.coldBooted ? { coldBooted: true } : {}),
    pause: async () => {},
    kill: async () => {},
    getInfo: async () => ({ sandboxId: 'sbx-1', state: 'running', metadata: {}, createdAt: '' }),
    writeFile: async (path: string) => {
      events.push({ kind: 'write', path });
    },
    readFile: async (path: string): Promise<string> => {
      if (path === '/tmp/slicc-join.json') {
        return JSON.stringify({
          joinUrl: 'https://w/join/new',
          trayId: 't-new',
          updatedAt: new Date().toISOString(),
          sliccVersion: 'test',
        });
      }
      throw new Error(`ENOENT ${path}`);
    },
    run: async (cmd: string): Promise<RunResult> => {
      events.push({ kind: 'run', cmd });
      if (cmd.includes('--max-time')) {
        // Like the real probe: always exit 0, verdict on stdout.
        return { stdout: opts.nodeServerUp ? 'up\n' : 'down\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '200', stderr: '', exitCode: 0 };
    },
    ...(opts.withSpawn === false
      ? {}
      : {
          spawn: async (cmd: string) => {
            events.push({ kind: 'spawn', cmd });
          },
        }),
  };
  return { handle, events };
}

async function pausedRegistry(): Promise<MemRegistry> {
  const registry = new MemRegistry();
  await registry.append({
    sandboxId: 'sbx-1',
    substrate: 'e2b',
    createdAt: '',
    joinUrl: 'https://old/join',
    lastSeen: '',
    state: 'paused',
    trayId: 't-old',
    lastJoinUpdatedAt: BASELINE,
  });
  return registry;
}

const DELTA = {
  upsert: { secrets: [{ name: 'OPENAI_API_KEY', value: 'sk', domains: ['api.openai.com'] }] },
};

describe('resumeCone after an unresponsive-guest snapshot', () => {
  it('opts in to the substrate cold-boot retry on connect', async () => {
    const connectCalls: Array<{ sandboxId: string; opts?: ConnectOpts }> = [];
    const { handle } = makeHandle();
    const substrate = makeFakeSubstrate({ handle, connectCalls });

    await resumeCone(
      { substrate, registry: await pausedRegistry() },
      { query: 'sbx-1', localSliccVersion: 'test' }
    );

    expect(connectCalls).toEqual([{ sandboxId: 'sbx-1', opts: { rebootIfUnresponsive: true } }]);
  });

  it('does not report a cold boot, probe, or spawn for a normal memory restore', async () => {
    const { handle, events } = makeHandle();
    const result = await resumeCone(
      { substrate: makeFakeSubstrate({ handle }), registry: await pausedRegistry() },
      { query: 'sbx-1', localSliccVersion: 'test' }
    );

    expect(result.coldBooted).toBeUndefined();
    expect(events.some((e) => e.kind === 'spawn')).toBe(false);
    expect(events.some((e) => e.kind === 'run' && e.cmd.includes('--max-time'))).toBe(false);
    expect(events.some((e) => e.kind === 'run' && e.cmd.includes('leader-restart'))).toBe(true);
  });

  it('surfaces coldBooted and restarts the hosted leader after writing the config files', async () => {
    const { handle, events } = makeHandle({ coldBooted: true });
    const registry = await pausedRegistry();

    const result = await resumeCone(
      { substrate: makeFakeSubstrate({ handle }), registry },
      { query: 'sbx-1', localSliccVersion: 'test', coneConfigDelta: DELTA }
    );

    expect(result.coldBooted).toBe(true);
    expect(result.joinUrl).toBe('https://w/join/new');
    expect(registry.entries[0]?.state).toBe('running');

    const spawnAt = events.findIndex((e) => e.kind === 'spawn');
    const lastWriteAt = events.map((e) => e.kind).lastIndexOf('write');
    expect(spawnAt).toBeGreaterThan(-1);
    // The fresh node-server must read the merged files, so they land first.
    expect(lastWriteAt).toBeGreaterThan(-1);
    expect(lastWriteAt).toBeLessThan(spawnAt);

    const spawn = events[spawnAt] as { kind: 'spawn'; cmd: string };
    expect(spawn.cmd).toContain('/usr/local/bin/slicc-start');
    // The create-time copies of secrets/config must not overwrite the newer files.
    for (const name of ['SLICC_SECRETS_ENV_B64', 'SLICC_CONE_CONFIG_B64', 'ADOBE_IMS_TOKEN']) {
      expect(spawn.cmd).toContain(`-u ${name} `);
    }

    // A freshly started node-server reads the files and boots the leader on
    // its own: no proxy reload or kick against a server that is not up yet.
    const runs = events.filter((e) => e.kind === 'run').map((e) => e.cmd);
    expect(runs.some((c) => c.includes('leader-restart'))).toBe(false);
    expect(runs.some((c) => c.includes('secrets/reload'))).toBe(false);
    // e2b's commands.run throws on a non-zero exit, so the probe must always
    // exit 0 and report on stdout instead.
    const probe = runs.find((c) => c.includes('--max-time'));
    expect(probe).toMatch(/&& echo up \|\| echo down$/);
  });

  it('reloads and kicks instead of spawning when node-server already answers after the boot', async () => {
    const { handle, events } = makeHandle({ coldBooted: true, nodeServerUp: true });

    const result = await resumeCone(
      { substrate: makeFakeSubstrate({ handle }), registry: await pausedRegistry() },
      { query: 'sbx-1', localSliccVersion: 'test', coneConfigDelta: DELTA }
    );

    expect(result.coldBooted).toBe(true);
    expect(events.some((e) => e.kind === 'spawn')).toBe(false);
    const runs = events.filter((e) => e.kind === 'run').map((e) => e.cmd);
    expect(runs.some((c) => c.includes('secrets/reload'))).toBe(true);
    expect(runs.some((c) => c.includes('leader-restart'))).toBe(true);
  });

  it('fails as LEADER_NOT_READY when a cold-booted handle cannot restart the leader', async () => {
    const { handle } = makeHandle({ coldBooted: true, withSpawn: false });
    const registry = await pausedRegistry();

    await expect(
      resumeCone(
        { substrate: makeFakeSubstrate({ handle }), registry },
        { query: 'sbx-1', localSliccVersion: 'test' }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'LEADER_NOT_READY' });
    expect(registry.entries[0]?.state).toBe('paused');
  });

  it('propagates the substrate SANDBOX_UNRESPONSIVE error unchanged and leaves the entry paused', async () => {
    const unresponsive = new CloudError('SANDBOX_UNRESPONSIVE', 'sbx-1 is unresponsive', {
      sandboxId: 'sbx-1',
    });
    const registry = await pausedRegistry();

    await expect(
      resumeCone(
        { substrate: makeFakeSubstrate({ connectError: unresponsive }), registry },
        { query: 'sbx-1', localSliccVersion: 'test' }
      )
    ).rejects.toBe(unresponsive);
    expect(registry.entries[0]?.state).toBe('paused');
  });
});
