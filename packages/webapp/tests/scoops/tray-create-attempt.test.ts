import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as db from '../../src/scoops/db.js';
import {
  type ConeIdentity,
  IndexedDbLeaderWebhookIdentityStore,
  LeaderTrayManager,
  type LeaderTraySession,
} from '../../src/scoops/tray-leader.js';

function fixture() {
  let identity: ConeIdentity | null = null;
  let session: LeaderTraySession | null = null;
  const identityStore = {
    load: vi.fn(async () => identity && structuredClone(identity)),
    save: vi.fn(async (next: ConeIdentity) => {
      identity = structuredClone(next);
    }),
    compareAndSwap: vi.fn(async (expected: ConeIdentity | null, next: ConeIdentity) => {
      if (JSON.stringify(expected) !== JSON.stringify(identity)) return false;
      identity = structuredClone(next);
      return true;
    }),
  };
  const store = {
    load: vi.fn(async () => session),
    save: vi.fn(async (next: LeaderTraySession) => {
      session = next;
    }),
    clear: vi.fn(async () => {
      session = null;
    }),
  };
  const attempts: string[] = [];
  const trays = new Map<string, string>();
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as ConeIdentity & { createAttemptId: string };
    expect(identity?.pendingCreateAttemptId).toBe(body.createAttemptId);
    expect(body.createAttemptId).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    attempts.push(body.createAttemptId);
    if (!trays.has(body.createAttemptId)) trays.set(body.createAttemptId, `tray-${trays.size + 1}`);
    const trayId = trays.get(body.createAttemptId)!;
    return Response.json({
      trayId,
      createdAt: '2026-01-01',
      capabilities: {
        controller: { url: `https://create.example/controller/${trayId}.ct` },
        join: { url: `https://create.example/join/${trayId}.jt` },
        webhook: {
          url: `https://create.example/wh/${body.coneId}.${body.coneSecret}`,
          rebindToken: `${body.coneId}.${body.rebindSecret}`,
        },
      },
    });
  });
  // Exercise the creation transaction without opening a leader socket.
  const manager = () =>
    new LeaderTrayManager({
      workerBaseUrl: 'https://create.example',
      runtime: 'test',
      identityStore,
      store,
      fetchImpl,
    }) as unknown as {
      createTraySession(): Promise<LeaderTraySession>;
      finishPendingCreate(session: LeaderTraySession | null): Promise<void>;
    };
  return { manager, identityStore, store, fetchImpl, attempts, trays };
}

describe('durable authenticated tray creation attempts', () => {
  it('persists before POST and reuses the attempt after a lost response and reload', async () => {
    const f = fixture();
    const server = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async (...args) => {
      await server(...args);
      throw new Error('response lost');
    });
    await expect(f.manager().createTraySession()).rejects.toThrow('transport unavailable');
    expect((await f.manager().createTraySession()).trayId).toBe('tray-1');
    expect(f.attempts[1]).toBe(f.attempts[0]);
    expect(f.trays.size).toBe(1);
    expect(await f.identityStore.load()).not.toHaveProperty('pendingCreateAttemptId');
  });

  it('reuses the attempt after bind 503 and session storage failure', async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(f.manager().createTraySession()).rejects.toThrow('(503)');
    const pending = (await f.identityStore.load())!.pendingCreateAttemptId;
    f.store.save.mockRejectedValueOnce(new Error('session disk full'));
    await expect(f.manager().createTraySession()).rejects.toThrow('session disk full');
    expect((await f.identityStore.load())!.pendingCreateAttemptId).toBe(pending);
    expect((await f.manager().createTraySession()).trayId).toBe('tray-1');
    expect(f.trays.size).toBe(1);
  });

  it('allocates a fresh attempt for each deliberate replacement', async () => {
    const f = fixture();
    const first = await f.manager().createTraySession();
    const second = await f.manager().createTraySession();
    expect(second.trayId).not.toBe(first.trayId);
    expect(f.attempts[1]).not.toBe(f.attempts[0]);
    expect(await f.store.load()).not.toHaveProperty('pendingCreateAttemptId');
  });

  it('reconciles a saved target when acknowledgement fails, before the next reset', async () => {
    const f = fixture();
    const cas = f.identityStore.compareAndSwap.getMockImplementation()!;
    f.identityStore.compareAndSwap.mockImplementation(async (expected, next) => {
      if (!next.pendingCreateAttemptId) throw new Error('ack disk full');
      return cas(expected, next);
    });
    await expect(f.manager().createTraySession()).rejects.toThrow('ack disk full');
    expect((await f.store.load())!.trayId).toBe('tray-1');
    expect((await f.identityStore.load())!.pendingCreateTrayId).toBe('tray-1');
    f.identityStore.compareAndSwap.mockImplementation(cas);
    expect((await f.manager().createTraySession()).trayId).toBe('tray-2');
    expect(f.attempts[1]).not.toBe(f.attempts[0]);
  });

  it('never sends POST when persisting the attempt fails', async () => {
    const f = fixture();
    f.identityStore.compareAndSwap.mockRejectedValueOnce(new Error('identity disk full'));
    await expect(f.manager().createTraySession()).rejects.toThrow('identity disk full');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not overwrite another tab identity when its response arrives late', async () => {
    const f = fixture();
    const server = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async (...args) => {
      const response = await server(...args);
      const current = (await f.identityStore.load())!;
      await f.identityStore.save({ ...current, coneSecret: 'rotated' });
      return response;
    });
    await expect(f.manager().createTraySession()).rejects.toThrow('identity changed');
    expect((await f.identityStore.load())!.coneSecret).toBe('rotated');
    expect(f.store.save).not.toHaveBeenCalled();
  });

  it('bounds CAS contention without sending a request', async () => {
    const f = fixture();
    f.identityStore.compareAndSwap.mockResolvedValue(false);
    await expect(f.manager().createTraySession()).rejects.toThrow('identity changed');
    expect(f.identityStore.compareAndSwap).toHaveBeenCalledTimes(8);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('stored create intent validation', () => {
  let counter = 0;
  it.each([
    { pendingCreateAttemptId: 'short' },
    { pendingCreateAttemptId: 'a'.repeat(129) },
    { pendingCreateAttemptId: 'a'.repeat(32) + '.' },
    { pendingCreateAttemptId: 42 },
    { pendingCreateTrayId: 'tray' },
    { pendingCreateAttemptId: 'a'.repeat(32), pendingCreateTrayId: '' },
  ])('rejects malformed intent %j', async (pending) => {
    const base = `https://invalid-create-${++counter}.example`;
    await db.setState(
      `leader-webhook-identity:${base}`,
      JSON.stringify({
        coneId: 'cone',
        coneSecret: 'delivery',
        rebindSecret: 'management',
        ...pending,
      })
    );
    await expect(new IndexedDbLeaderWebhookIdentityStore(base).load()).rejects.toThrow(
      'Stored tray creation intent is invalid'
    );
  });

  it('preserves valid pending fields through IndexedDB load', async () => {
    const store = new IndexedDbLeaderWebhookIdentityStore('https://valid-create.example');
    const identity: ConeIdentity = {
      coneId: 'cone',
      coneSecret: 'delivery',
      rebindSecret: 'management',
      pendingCreateAttemptId: 'a'.repeat(32),
      pendingCreateTrayId: 'tray-1',
    };
    await store.save(identity);
    expect(await store.load()).toMatchObject(identity);
  });
});
