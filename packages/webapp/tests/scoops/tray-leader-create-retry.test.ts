import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLeaderTrayRuntimeStatus,
  LeaderTrayManager,
  type LeaderTraySession,
  type LeaderTraySessionStore,
  type LeaderTrayWebSocket,
} from '../../src/scoops/tray-leader.js';
import {
  backoffDelayMs,
  parseRetryAfterMs,
  resolveTrayRequestRetry,
  retryTrayRequest,
  TrayRequestRetryExhaustedError,
} from '../../src/scoops/tray-request-retry.js';

const privateState = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/scoops/db.js', () => ({
  getState: vi.fn(async (key: string) => privateState.get(key) ?? null),
  setState: vi.fn(async (key: string, value: string) => {
    privateState.set(key, value);
  }),
  compareAndSetState: vi.fn(async (key: string, expected: string | null, value: string) => {
    if ((privateState.get(key) ?? null) !== expected) return false;
    privateState.set(key, value);
    return true;
  }),
}));

class MemorySessionStore implements LeaderTraySessionStore {
  value: LeaderTraySession | null = null;
  async load(): Promise<LeaderTraySession | null> {
    return this.value;
  }
  async save(session: LeaderTraySession): Promise<void> {
    this.value = session;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}

class ReadySocket implements LeaderTrayWebSocket {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    if (type === 'message') {
      queueMicrotask(() => listener({ data: JSON.stringify({ type: 'leader.connected' }) }));
    }
  }
  send(): void {}
  close(): void {}
}

const BASE = 'https://tray.example.com';

function created(): Response {
  return Response.json(
    {
      trayId: 'tray-1',
      createdAt: '2026-10-23T15:35:36.000Z',
      capabilities: {
        join: { url: `${BASE}/join/tray-1.jt` },
        controller: { url: `${BASE}/controller/tray-1.ct` },
        webhook: { url: `${BASE}/webhook/tray-1.wt` },
      },
    },
    { status: 201 }
  );
}

function attached(): Response {
  return Response.json({
    trayId: 'tray-1',
    controllerId: 'controller-1',
    role: 'leader',
    leaderKey: 'leader-key-1',
    websocket: { url: 'wss://tray.example.com/controller/tray-1.ct' },
  });
}

function unavailable(retryAfter?: string): Response {
  return Response.json(
    { error: 'Tray hub temporarily unavailable', code: 'TRAY_TEMPORARILY_UNAVAILABLE' },
    { status: 503, headers: retryAfter ? { 'retry-after': retryAfter } : {} }
  );
}

function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    }),
  };
}

function makeManager(
  fetchImpl: typeof fetch,
  clock: ReturnType<typeof fakeClock>,
  store: LeaderTraySessionStore = new MemorySessionStore()
) {
  return new LeaderTrayManager({
    workerBaseUrl: BASE,
    runtime: 'slicc-hosted-leader',
    kind: 'hosted',
    store,
    identityStore: {
      load: async () => null,
      save: async () => {},
      compareAndSwap: async () => true,
    },
    replacementStore: new MemorySessionStore(),
    fetchImpl,
    webSocketFactory: () => new ReadySocket(),
    pingIntervalMs: 60_000,
    reconnect: false,
    requestRetry: { deadlineMs: 90_000, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
  });
}

function trayPosts(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): number {
  return fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/tray').length;
}

describe('LeaderTrayManager tray creation retry (#4112)', () => {
  let managers: LeaderTrayManager[];
  beforeEach(() => {
    privateState.clear();
    managers = [];
  });
  afterEach(() => {
    for (const manager of managers) manager.stop();
  });

  it('retries a 503 from POST /tray and yields a join URL from the 201', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unavailable('1'))
      .mockResolvedValueOnce(created())
      .mockResolvedValueOnce(attached());
    const manager = makeManager(fetchImpl, clock);
    managers.push(manager);

    const session = await manager.start();

    expect(session.joinUrl).toBe(`${BASE}/join/tray-1.jt`);
    expect(trayPosts(fetchImpl)).toBe(2);

    expect(clock.sleeps).toEqual([1000]);

    const bodies = fetchImpl.mock.calls
      .filter(([url]) => new URL(String(url)).pathname === '/tray')
      .map(([, init]) => JSON.parse(String(init?.body)).createAttemptId);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('retries a network error and a 429, honouring Retry-After', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '7' } }))
      .mockResolvedValueOnce(created())
      .mockResolvedValueOnce(attached());
    const manager = makeManager(fetchImpl, clock);
    managers.push(manager);

    await expect(manager.start()).resolves.toMatchObject({ trayId: 'tray-1' });
    expect(trayPosts(fetchImpl)).toBe(3);
    expect(clock.sleeps).toEqual([750, 7000]);
  });

  it('gives up on repeated 503s with a clear error before the deadline', async () => {
    const clock = fakeClock();
    const startedAt = clock.now();
    const fetchImpl = vi.fn<typeof fetch>(async () => unavailable('1'));
    const manager = makeManager(fetchImpl, clock);
    managers.push(manager);

    const error = await manager.start().then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(TrayRequestRetryExhaustedError);
    expect((error as Error).message).toMatch(
      /^POST \/tray failed after \d+ attempts in \d+s: HTTP 503 TRAY_TEMPORARILY_UNAVAILABLE$/
    );
    expect(clock.now() - startedAt).toBeLessThan(90_000);
    expect(trayPosts(fetchImpl)).toBeGreaterThan(3);

    expect(getLeaderTrayRuntimeStatus()).toMatchObject({
      state: 'error',
      error: (error as Error).message,
    });
  });

  it('does not retry a 400', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'bad', code: 'INVALID_BODY' }, { status: 400 }));
    const manager = makeManager(fetchImpl, clock);
    managers.push(manager);

    await expect(manager.start()).rejects.toThrow('Tray request failed (400)');
    expect(trayPosts(fetchImpl)).toBe(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('retries the attach to a freshly minted tray under the same budget', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(created())
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(attached());
    const manager = makeManager(fetchImpl, clock);
    managers.push(manager);

    await expect(manager.start()).resolves.toMatchObject({ trayId: 'tray-1' });
    expect(trayPosts(fetchImpl)).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries the attach to the tray minted after a stale stored session', async () => {
    const clock = fakeClock();
    const store = new MemorySessionStore();
    store.value = {
      workerBaseUrl: BASE,
      trayId: 'tray-old',
      createdAt: '2026-10-22T00:00:00.000Z',
      controllerId: 'controller-old',
      controllerUrl: `${BASE}/controller/tray-old.ct`,
      joinUrl: `${BASE}/join/tray-old.jt`,
      webhookUrl: `${BASE}/webhook/tray-old.wt`,
      runtime: 'slicc-hosted-leader',
    };
    let freshAttaches = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/controller/tray-old.ct') return new Response(null, { status: 404 });
      if (path === '/tray') return created();
      if (path === '/controller/tray-1.ct') {
        freshAttaches++;
        return freshAttaches === 1 ? unavailable('1') : attached();
      }
      if (path.endsWith('/supersede')) return Response.json({ ok: true });
      throw new Error(`unexpected ${path}`);
    });
    const manager = makeManager(fetchImpl, clock, store);
    managers.push(manager);

    await expect(manager.start()).resolves.toMatchObject({ trayId: 'tray-1' });
    expect(freshAttaches).toBe(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it('stops retrying once the manager is stopped', async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn<typeof fetch>(async () => unavailable());
    const manager = makeManager(fetchImpl, clock);
    clock.sleep.mockImplementationOnce(async () => {
      manager.stop();
    });

    await expect(manager.start()).rejects.toThrow('POST /tray cancelled');
    expect(trayPosts(fetchImpl)).toBe(1);
  });
});

describe('tray-request-retry helpers', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('soon')).toBeNull();
    const now = Date.parse('2026-10-23T15:35:36Z');
    expect(parseRetryAfterMs('Fri, 23 Oct 2026 15:35:46 GMT', now)).toBe(10_000);
    expect(parseRetryAfterMs('Fri, 23 Oct 2026 15:35:26 GMT', now)).toBe(0);
  });

  it('backs off exponentially with equal jitter, capped', () => {
    expect(backoffDelayMs(1, 1000, 15_000, () => 0)).toBe(500);
    expect(backoffDelayMs(1, 1000, 15_000, () => 0.999_999)).toBe(1000);
    expect(backoffDelayMs(3, 1000, 15_000, () => 0)).toBe(2000);
    expect(backoffDelayMs(10, 1000, 15_000, () => 0.5)).toBe(11_250);
  });

  it('gives up immediately when Retry-After overshoots the deadline', async () => {
    const clock = fakeClock();
    const retry = resolveTrayRequestRetry({ sleep: clock.sleep, now: clock.now });
    const attempt = vi.fn(async () => {
      throw new Error('busy');
    });
    await expect(
      retryTrayRequest({
        label: 'POST /tray',
        deadlineAt: clock.now() + 10_000,
        retry,
        attempt,
        classify: () => ({ retryable: true, retryAfterMs: 30_000, detail: 'HTTP 503' }),
      })
    ).rejects.toThrow('POST /tray failed after 1 attempt in 0s: HTTP 503');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});
