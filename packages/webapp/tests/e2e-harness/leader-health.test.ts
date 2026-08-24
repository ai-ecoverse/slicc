// Unit coverage for the E2E leader-origin health gate (#2372). The gate itself
// only runs inside Playwright, so its decision logic lives in a dependency-
// injected module that Vitest can drive without a browser or a live workerd.
import { describe, expect, it, vi } from 'vitest';
import {
  assertLeaderAlive,
  createLeaderHealthState,
  type LeaderHealthDeps,
  probeLeader,
  WRANGLER_CRASHED,
  WranglerCrashedError,
} from '../e2e/leader-health.js';

function makeDeps(
  responder: (url: string, init?: RequestInit) => Promise<{ ok: boolean }>
): LeaderHealthDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    statusUrl: 'http://localhost:8787/status',
    restartUrl: 'http://127.0.0.1:8788/restart',
    fetch: responder,
    sleep: async () => {},
    log: (message) => logs.push(message),
    logs,
  };
}

describe('probeLeader', () => {
  it('accepts a single healthy HEAD without a second request', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true }));
    const deps = makeDeps(fetchMock);

    await expect(probeLeader(deps)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('HEAD');
  });

  it('confirms a failed HEAD with a GET so one dropped response is not a crash', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'HEAD' ? { ok: false } : { ok: true }
    );

    await expect(probeLeader(makeDeps(fetchMock))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a refused connection (throw) as dead', async () => {
    const deps = makeDeps(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(probeLeader(deps)).resolves.toBe(false);
  });
});

describe('assertLeaderAlive', () => {
  it('is a no-op while the origin answers', async () => {
    const deps = makeDeps(async () => ({ ok: true }));
    const state = createLeaderHealthState();

    await expect(assertLeaderAlive(deps, state, 'spec', 'before')).resolves.toBeUndefined();
    expect(state.restarts).toBe(0);
    expect(state.aborted).toBeNull();
  });

  it('restarts wrangler and fails only the current spec when the origin died', async () => {
    let restarted = false;
    const deps = makeDeps(async (url) => {
      if (url.endsWith('/restart')) {
        restarted = true;
        return { ok: true };
      }
      return { ok: restarted };
    });
    const state = createLeaderHealthState();

    const error = await assertLeaderAlive(deps, state, 'reference scenario', 'before').catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(WranglerCrashedError);
    expect((error as Error).name).toBe(WRANGLER_CRASHED);
    expect((error as Error).message).toContain('before "reference scenario"');
    expect(restarted).toBe(true);
    // Restart succeeded, so the suite is NOT latched off — later specs run.
    expect(state.aborted).toBeNull();
    expect(state.restarts).toBe(1);
  });

  it('names the running spec when the origin dies during it', async () => {
    const deps = makeDeps(async (url) => ({ ok: url.endsWith('/restart') }));
    const state = createLeaderHealthState();

    const error = await assertLeaderAlive(deps, state, 'transcript export', 'after').catch(
      (e: unknown) => e
    );

    // Restart POST answered ok but the origin never came back → suite latched.
    expect((error as Error).message).toContain('during "transcript export"');
    expect(state.aborted).not.toBeNull();
  });

  it('latches the suite off when no supervisor can restart wrangler', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const deps = makeDeps(fetchMock);
    const state = createLeaderHealthState();

    await expect(assertLeaderAlive(deps, state, 'first', 'before')).rejects.toThrow(
      /could not.*bring it back/s
    );
    expect(state.aborted).toContain('died before "first"');

    const callsAfterFirst = fetchMock.mock.calls.length;
    // Every later spec fails instantly with the same named error rather than
    // burning its 30 s timeout against a dead origin.
    const error = await assertLeaderAlive(deps, state, 'second', 'before').catch((e: unknown) => e);
    expect((error as Error).name).toBe(WRANGLER_CRASHED);
    expect((error as Error).message).toContain('skipping "second"');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('signals the slow path once, before any restart is awaited', async () => {
    const onSlowPath = vi.fn();
    const healthy = makeDeps(async () => ({ ok: true }));

    await assertLeaderAlive(healthy, createLeaderHealthState(), 'spec', 'before', onSlowPath);
    // A live origin must not inflate the spec's timeout budget.
    expect(onSlowPath).not.toHaveBeenCalled();

    const dead = makeDeps(async (url) => ({ ok: url.endsWith('/restart') }));
    await assertLeaderAlive(dead, createLeaderHealthState(), 'spec', 'before', onSlowPath).catch(
      () => {}
    );
    expect(onSlowPath).toHaveBeenCalledTimes(1);
  });

  it('latches when the supervisor refuses to restart (its permanent-failure short circuit)', async () => {
    // The supervisor answers 503 without attempting another cold start once it
    // has given up; the fixture must treat that as unrecoverable, not retry it.
    const deps = makeDeps(async () => ({ ok: false }));
    const state = createLeaderHealthState();

    await expect(assertLeaderAlive(deps, state, 'spec', 'before')).rejects.toThrow(
      /could not.*bring it back/s
    );
    expect(state.aborted).not.toBeNull();
  });

  it('emits a CI warning annotation so a contained crash stays visible', async () => {
    const previous = process.env['CI'];
    process.env['CI'] = 'true';
    try {
      const deps = makeDeps(async (url) => ({ ok: url.endsWith('/restart') }));
      await assertLeaderAlive(deps, createLeaderHealthState(), 'spec', 'before').catch(() => {});
      expect(
        deps.logs.some((line) => line.startsWith(`::warning title=${WRANGLER_CRASHED}::`))
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['CI'];
      else process.env['CI'] = previous;
    }
  });
});
