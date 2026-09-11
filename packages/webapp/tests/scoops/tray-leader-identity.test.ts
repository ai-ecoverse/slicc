import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/scoops/db.js';
import {
  assertNoStableWebhookHome,
  type ConeIdentity,
  getLeaderTrayRuntimeStatus,
  IndexedDbLeaderTraySessionStore,
  IndexedDbLeaderWebhookIdentityStore,
  LeaderTrayManager,
  type LeaderTrayManagerOptions,
  type LeaderTraySession,
  type LeaderTrayWebSocket,
} from '../../src/scoops/tray-leader.js';

class ReadySocket implements LeaderTrayWebSocket {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    if (type === 'message') {
      queueMicrotask(() => listener({ data: JSON.stringify({ type: 'leader.connected' }) }));
    }
  }
  send(): void {}
  close(): void {}
}

describe('durable leader-session webhook management identity', () => {
  let base: string;
  let store: IndexedDbLeaderTraySessionStore;
  let identityStore: IndexedDbLeaderWebhookIdentityStore;
  let managers: LeaderTrayManager[];
  let creates: ConeIdentity[];
  let transfers: string[];
  let bindFails: boolean;
  let transferFails: boolean;
  let attachFails: boolean;
  let legacyHub: boolean;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  let counter = 0;

  beforeEach(() => {
    base = `https://identity-${++counter}.example.com`;
    store = new IndexedDbLeaderTraySessionStore(`test-identity-session-${counter}`);
    identityStore = new IndexedDbLeaderWebhookIdentityStore(base);
    managers = [];
    creates = [];
    transfers = [];
    bindFails = false;
    transferFails = false;
    attachFails = false;
    legacyHub = false;
    fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/tray') {
        const { createAttemptId, ...identity } = JSON.parse(String(init?.body)) as ConeIdentity & {
          createAttemptId: string;
        };
        // Verify the credential survived durable storage before going on the wire.
        expect(await identityStore.load()).toMatchObject({
          ...identity,
          pendingCreateAttemptId: createAttemptId,
        });
        creates.push(identity);
        if (bindFails) return new Response('secret-bearing upstream error', { status: 503 });
        const trayId = `tray-${creates.length}`;
        return Response.json(
          {
            trayId,
            coneId: identity.coneId,
            createdAt: '2026-01-01',
            capabilities: {
              controller: { url: `${base}/controller/${trayId}.ct` },
              join: { url: `${base}/join/${trayId}.jt` },
              webhook: legacyHub
                ? { url: `${base}/webhook/${trayId}.wt` }
                : {
                    url: `${base}/wh/${identity.coneId}.${identity.coneSecret}`,
                    rebindToken: `${identity.coneId}.${identity.rebindSecret}`,
                  },
            },
          },
          { status: 201 }
        );
      }
      if (path.endsWith('/preview-transfer')) {
        const sourceTrayId = path.split('/')[3];
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${sourceTrayId}.ct`);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        transfers.push(String(init?.body));
        if (transferFails) return new Response('private upstream failure', { status: 503 });
        return Response.json({ transferred: true });
      }
      if (path.endsWith('/supersede')) return Response.json({ ok: true });
      if (path.startsWith('/controller/')) {
        if (attachFails) return new Response(null, { status: 409 });
        const trayId = path.split('/').pop()!.split('.')[0];
        return Response.json({
          trayId,
          controllerId: 'controller',
          role: 'leader',
          leaderKey: 'key',
          websocket: { url: `${base.replace('https:', 'wss:')}/socket` },
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });
  });

  afterEach(() => {
    for (const manager of managers) manager.stop();
    vi.restoreAllMocks();
  });

  function manager(options: Partial<LeaderTrayManagerOptions> = {}): LeaderTrayManager {
    const result = new LeaderTrayManager({
      workerBaseUrl: base,
      runtime: 'test',
      store,
      identityStore,
      fetchImpl,
      webSocketFactory: () => new ReadySocket(),
      reconnect: false,
      ...options,
    });
    managers.push(result);
    return result;
  }

  it('retains first-create identity through failure, clear, and manager reload without public secrets', async () => {
    bindFails = true;
    const first = manager();
    await expect(first.start()).rejects.toThrow('Tray request failed (503)');
    const saved = await identityStore.load();
    await first.clearSession();
    first.stop();
    bindFails = false;
    const session = await manager().start();
    expect(creates[1]).toEqual(creates[0]);
    expect(await identityStore.load()).toMatchObject({
      coneId: saved!.coneId,
      coneSecret: saved!.coneSecret,
      rebindSecret: saved!.rebindSecret,
      established: true,
    });
    expect(session).not.toHaveProperty('rebindSecret');
    expect(session).not.toHaveProperty('coneSecret');
    expect(await store.load()).not.toHaveProperty('rebindSecret');
    expect(JSON.stringify(getLeaderTrayRuntimeStatus())).not.toContain(saved!.rebindSecret);
  });

  it('retries an acknowledged create after attach failure without another mint', async () => {
    attachFails = true;
    await expect(manager().start()).rejects.toThrow('(409)');
    attachFails = false;
    expect((await manager().start()).trayId).toBe('tray-1');
    expect(creates).toHaveLength(1);
  });

  it('retains the exact reset source and target after failed preview transfer and reload', async () => {
    const first = manager();
    const old = await first.start();
    transferFails = true;
    await expect(first.reset()).rejects.toThrow('(503)');
    await expect(first.clearSession()).rejects.toThrow('replacement is pending');
    expect(creates).toHaveLength(2);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/supersede'))).toBe(false);
    first.stop();
    transferFails = false;
    const next = await manager().start();
    expect(next.trayId).toBe('tray-2');
    expect(next.webhookUrl).toBe(old.webhookUrl);
    expect(creates).toHaveLength(2);
    expect(transfers[1]).toBe(transfers[0]);
    expect(JSON.parse(transfers[0])).toEqual({
      targetTrayId: 'tray-2',
      targetControllerToken: 'tray-2.ct',
    });
    expect(await db.getState(`leader-tray-replacement:${base}`)).toBe('');
  });

  it('replaces a rejected target only with an explicit pre-freeze refusal', async () => {
    const first = manager();
    await first.start();
    transferFails = true;
    await expect(first.reset()).rejects.toThrow('(503)');
    first.stop();
    transferFails = false;
    fetchImpl.mockResolvedValueOnce(
      Response.json({ code: 'PREVIEW_TARGET_UNAVAILABLE' }, { status: 410 })
    );
    const next = await manager().start();
    expect(next.trayId).toBe('tray-3');
    expect(creates).toHaveLength(3);
    expect(JSON.parse(transfers.at(-1)!)).toMatchObject({ targetTrayId: 'tray-3' });
  });

  it('completes a frozen expired owner then durably roves from it rather than retargeting the source', async () => {
    const first = manager();
    await first.start();
    transferFails = true;
    await expect(first.reset()).rejects.toThrow('(503)');
    first.stop();
    transferFails = false;
    const fetch = fetchImpl.getMockImplementation()!;
    const sources: string[] = [];
    fetchImpl.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/preview-transfer')) sources.push(path.split('/')[3]);
      if (path === '/controller/tray-2.ct') return new Response(null, { status: 410 });
      return fetch(url, init);
    });
    expect((await manager().start()).trayId).toBe('tray-3');
    expect(sources).toEqual(['tray-1', 'tray-2']);
    expect(creates).toHaveLength(3);
  });

  it.each([403, 410])(
    'does not discard a potentially frozen target on generic %s',
    async (status) => {
      const first = manager();
      await first.start();
      transferFails = true;
      await expect(first.reset()).rejects.toThrow('(503)');
      first.stop();
      fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
      await expect(manager().start()).rejects.toThrow(`(${status})`);
      expect(creates).toHaveLength(2);
      expect((await store.load())?.trayId).toBe('tray-2');
    }
  );

  it('supports old hubs only before a stable capability is established', async () => {
    legacyHub = true;
    const first = manager();
    await first.start();
    await first.reset();
    expect(transfers).toHaveLength(0);
    first.stop();
    legacyHub = false;
    await first.clearSession();
    const stable = manager();
    await stable.start();
    legacyHub = true;
    await expect(stable.reset()).rejects.toThrow('did not confirm the stable webhook binding');
    expect(await identityStore.load()).toMatchObject({ established: true });
  });

  it('fails before any network call when identity persistence fails', async () => {
    const failingStore = {
      load: async () => null,
      compareAndSwap: async () => {
        throw new Error('private storage unavailable');
      },
      save: async () => {
        throw new Error('private storage unavailable');
      },
    };
    await expect(manager({ identityStore: failingStore }).start()).rejects.toThrow(
      'storage unavailable'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('migrates a legacy private session before exposing or clearing it', async () => {
    const identity = { coneId: 'old-cone', coneSecret: 'old-secret', rebindSecret: 'old-rebind' };
    const legacy: LeaderTraySession & ConeIdentity = {
      ...identity,
      workerBaseUrl: base,
      runtime: 'test',
      trayId: 'tray-old',
      createdAt: '',
      controllerId: 'old',
      controllerUrl: `${base}/controller/tray-old.ct`,
      joinUrl: `${base}/join/old`,
      webhookUrl: `${base}/wh/old-cone.old-secret`,
    };
    await store.save(legacy);
    const session = await manager().start();
    expect(await identityStore.load()).toMatchObject(identity);
    expect(session).not.toHaveProperty('rebindSecret');
    expect(await store.load()).not.toHaveProperty('rebindSecret');
  });

  it('scopes private identity to the hub and normalizes trailing slashes', async () => {
    await manager().start();
    expect(await new IndexedDbLeaderWebhookIdentityStore(`${base}/`).load()).toEqual(
      await identityStore.load()
    );
    expect(await new IndexedDbLeaderWebhookIdentityStore(`${base}/other`).load()).toBeNull();
  });

  it('coalesces rotation, waits before reset, and publishes only after private persistence', async () => {
    const first = manager();
    const old = await first.start();
    const identity = (await identityStore.load())!;
    let resolveRotation!: (response: Response) => void;
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        oldConeId: identity.coneId,
        oldSecret: identity.coneSecret,
        oldRebindSecret: identity.rebindSecret,
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((resolve) => {
        resolveRotation = resolve;
      });
    });
    const rotation = first.rotateWebhook();
    const duplicate = first.rotateWebhook();
    const reset = first.reset();
    expect(creates).toHaveLength(1);
    const compareAndSwap = identityStore.compareAndSwap.bind(identityStore);
    const save = vi.spyOn(identityStore, 'compareAndSwap');
    save.mockImplementationOnce(async (expected, next) => {
      expect(getLeaderTrayRuntimeStatus().session?.webhookUrl).toBe(old.webhookUrl);
      return compareAndSwap(expected, next);
    });
    await vi.waitFor(() => expect(resolveRotation).toBeTypeOf('function'));
    const intent = (await identityStore.load())!.pendingRotation!;
    const newUrl = `${base}/wh/${identity.coneId}.${intent.secret}`;
    resolveRotation(
      Response.json({
        coneId: identity.coneId,
        webhook: { url: newUrl, rebindToken: `${identity.coneId}.${intent.rebindSecret}` },
      })
    );
    expect(await rotation).toEqual({ webhookUrl: newUrl });
    expect(await duplicate).toEqual({ webhookUrl: newUrl });
    expect((await reset).webhookUrl).toBe(newUrl);
    expect(creates[1].coneSecret).toBe(intent.secret);
    expect(creates[1].rebindSecret).toBe(intent.rebindSecret);
    expect(JSON.stringify(getLeaderTrayRuntimeStatus())).not.toContain(intent.rebindSecret);
    expect(JSON.stringify(await store.load())).not.toContain(intent.rebindSecret);
  });

  it('persists independent cryptographic replacements for rotations from the same leaked identity', async () => {
    const first = manager();
    await first.start();
    const identity = (await identityStore.load())!;
    const replacements: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      // Model independent copies of the same pre-rotation private record.
      await identityStore.save(identity);
      fetchImpl.mockImplementationOnce(async (_url, init) => {
        const intent = (await identityStore.load())!.pendingRotation!;
        const body = JSON.parse(String(init?.body));
        expect(body.secret).toBe(intent.secret);
        expect(body.rebindSecret).toBe(intent.rebindSecret);
        for (const secret of [intent.secret, intent.rebindSecret]) {
          expect(secret).toMatch(/^[a-f0-9]{32}$/);
          expect(secret).not.toBe(identity.coneSecret);
          expect(secret).not.toBe(identity.rebindSecret);
          replacements.push(secret);
        }
        throw new Error('lost response');
      });
      await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
    }
    expect(new Set(replacements).size).toBe(4);
  });

  it('sends no rotation when another tab wins the intent CAS', async () => {
    const first = manager();
    await first.start();
    const calls = fetchImpl.mock.calls.length;
    vi.spyOn(identityStore, 'compareAndSwap').mockResolvedValueOnce(false);
    await expect(first.rotateWebhook()).rejects.toThrow('another tab');
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect((await identityStore.load())?.pendingRotation).toBeUndefined();
  });

  it('refuses legacy deterministic intent without changing storage or sending credentials', async () => {
    const first = manager();
    const session = await first.start();
    const identity = (await identityStore.load())!;
    first.stop();
    const key = `leader-webhook-identity:${base}`;
    const raw = JSON.stringify({ ...identity, pendingRotation: session });
    await db.setState(key, raw);
    const calls = fetchImpl.mock.calls.length;
    await expect(manager().start()).rejects.toThrow('rotation intent is invalid');
    expect(await db.getState(key)).toBe(raw);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('retains old identity after lost rotation response for an idempotent retry', async () => {
    const first = manager();
    await first.start();
    const identity = await identityStore.load();
    fetchImpl.mockRejectedValueOnce(new Error(`secret-bearing error ${identity!.rebindSecret}`));
    await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
    expect(await identityStore.load()).toMatchObject(identity!);
    expect((await identityStore.load())?.pendingRotation?.trayId).toBe('tray-1');
    const failedBody = fetchImpl.mock.calls[2][1]?.body;
    const intent = (await identityStore.load())!.pendingRotation!;
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        coneId: identity!.coneId,
        webhook: {
          url: `${base}/wh/${identity!.coneId}.${intent.secret}`,
          rebindToken: `${identity!.coneId}.${intent.rebindSecret}`,
        },
      })
    );
    await first.rotateWebhook();
    expect(fetchImpl.mock.calls[3][1]?.body).toBe(failedBody);
  });

  it('replays a lost rotation response on reload before reset can rebind the stale secret', async () => {
    const first = manager();
    await first.start();
    const identity = (await identityStore.load())!;
    fetchImpl.mockImplementationOnce(async () => {
      expect((await identityStore.load())?.pendingRotation?.trayId).toBe('tray-1');
      throw new Error('response lost after server committed rotation');
    });
    await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
    const rotationBody = fetchImpl.mock.calls[2][1]?.body;
    const intent = (await identityStore.load())!.pendingRotation!;
    const newUrl = `${base}/wh/${identity.coneId}.${intent.secret}`;
    first.stop();
    const callsBeforeReload = fetchImpl.mock.calls.length;
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        coneId: identity.coneId,
        webhook: { url: newUrl, rebindToken: `${identity.coneId}.${intent.rebindSecret}` },
      })
    );
    const reloaded = manager();
    expect((await reloaded.start()).webhookUrl).toBe(newUrl);
    expect(String(fetchImpl.mock.calls[callsBeforeReload][0])).toContain('/webhook/rotate');
    expect(fetchImpl.mock.calls[callsBeforeReload][1]?.body).toBe(rotationBody);
    expect((await identityStore.load())?.pendingRotation).toBeUndefined();
    expect((await reloaded.reset()).webhookUrl).toBe(newUrl);
    expect(creates[1].coneSecret).toBe(intent.secret);
  });

  it.each([400, 401, 403, 404, 410, 422])(
    'drops a definitively refused rotation on replay (%s) without bricking start',
    async (status) => {
      const first = manager();
      await first.start();
      fetchImpl.mockRejectedValueOnce(new Error('lost response'));
      await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
      first.stop();
      fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
      const next = manager();
      expect((await next.start()).trayId).toBe('tray-1');
      expect((await identityStore.load())?.pendingRotation).toBeUndefined();
      await next.clearSession();
    }
  );

  it.each([403, 200])(
    'never overwrites another tab identity with a late rotation response (%s)',
    async (status) => {
      const first = manager();
      const old = await first.start();
      const identity = (await identityStore.load())!;
      let reply!: (response: Response) => void;
      fetchImpl.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            reply = resolve;
          })
      );
      const rotating = first.rotateWebhook();
      await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
      const intent = (await identityStore.load())!.pendingRotation!;
      const newer = { ...identity, coneSecret: 'newer-tab-secret' };
      await new IndexedDbLeaderWebhookIdentityStore(base).save(newer);
      await store.save({
        ...old,
        trayId: 'tray-newer',
        webhookUrl: `${base}/wh/${identity.coneId}.newer-tab-secret`,
      });
      reply(
        status === 403
          ? new Response(null, { status })
          : Response.json({
              coneId: identity.coneId,
              webhook: {
                url: `${base}/wh/${identity.coneId}.${intent.secret}`,
                rebindToken: `${identity.coneId}.${intent.rebindSecret}`,
              },
            })
      );
      await expect(rotating).rejects.toThrow(status === 403 ? '(403)' : 'another tab');
      expect(await identityStore.load()).toEqual(newer);
      expect((await store.load())?.trayId).toBe('tray-newer');
    }
  );

  it('atomically admits only one identity writer across two IndexedDB stores', async () => {
    await manager().start();
    const otherStore = new IndexedDbLeaderWebhookIdentityStore(base);
    const a = (await identityStore.load())!;
    const b = (await otherStore.load())!;
    const results = await Promise.all([
      identityStore.compareAndSwap(a, { ...a, coneSecret: 'writer-a' }),
      otherStore.compareAndSwap(b, { ...b, coneSecret: 'writer-b' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await identityStore.load())?.coneSecret).toBe(results[0] ? 'writer-a' : 'writer-b');
  });

  it('keeps reconnect fail-closed when refusal races a newer pending rotation', async () => {
    const first = manager();
    await first.start();
    fetchImpl.mockRejectedValueOnce(new Error('lost response'));
    await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
    first.stop();
    const identity = (await identityStore.load())!;
    const newer = {
      ...identity,
      pendingRotation: { ...identity.pendingRotation!, trayId: 'tray-newer' },
    };
    fetchImpl.mockImplementationOnce(async () => {
      await new IndexedDbLeaderWebhookIdentityStore(base).save(newer);
      return new Response(null, { status: 403 });
    });
    await expect(manager().start()).rejects.toThrow('another tab');
    expect(await identityStore.load()).toEqual(newer);
    expect(creates).toHaveLength(1);
  });

  it.each([408, 409, 429, 500, 503])(
    'keeps a pending rotation fail-closed on ambiguous replay (%s)',
    async (status) => {
      const first = manager();
      await first.start();
      fetchImpl.mockRejectedValueOnce(new Error('lost rotation response'));
      await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
      first.stop();
      fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
      await expect(manager().start()).rejects.toThrow(`(${status})`);
      expect(creates).toHaveLength(1);
      expect((await identityStore.load())?.pendingRotation).toBeDefined();
    }
  );

  it.each([true, false])(
    'replays pending rotation before rebinding an expired source (server committed: %s)',
    async (committed) => {
      const first = manager();
      await first.start();
      const identity = (await identityStore.load())!;
      let serverSecret = identity.coneSecret;
      fetchImpl.mockImplementationOnce(async (_url, init) => {
        if (committed) serverSecret = JSON.parse(String(init?.body)).secret;
        throw new Error('uncertain response before source expires');
      });
      await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
      first.stop();
      // The worker's ownership-only rotation replay can authenticate a retained
      // source controller after expiry; it must not require a fresh target bind.
      const intent = (await identityStore.load())!.pendingRotation!;
      fetchImpl.mockImplementationOnce(async (url, init) => {
        expect(String(url)).toBe(`${base}/api/tray/tray-1/webhook/rotate`);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tray-1.ct');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          oldSecret: identity.coneSecret,
          oldRebindSecret: identity.rebindSecret,
        });
        expect(serverSecret).toBe(committed ? intent.secret : identity.coneSecret);
        serverSecret = intent.secret;
        return Response.json({
          coneId: identity.coneId,
          webhook: {
            url: `${base}/wh/${identity.coneId}.${serverSecret}`,
            rebindToken: `${identity.coneId}.${intent.rebindSecret}`,
          },
        });
      });
      // Simulate the expired source attach AFTER rotation intent recovery.
      fetchImpl.mockResolvedValueOnce(new Response(null, { status: 410 }));
      const next = await manager().start();
      expect(next.trayId).toBe('tray-2');
      expect(creates[1].coneSecret).toBe(serverSecret);
      expect(transfers).toHaveLength(1);
      expect((await identityStore.load())?.pendingRotation).toBeUndefined();
    }
  );

  it('revokes a registration with private management auth and a bounded sanitized failure', async () => {
    const first = manager();
    await first.start();
    const identity = (await identityStore.load())!;
    fetchImpl.mockResolvedValueOnce(Response.json({ revoked: true }));
    await first.revokeWebhook('id/with space');
    const [url, init] = fetchImpl.mock.calls[2];
    expect(String(url)).toBe(`${base}/webhooks/${identity.coneId}/id%2Fwith%20space/revoke`);
    expect(JSON.parse(String(init?.body))).toEqual({
      rebindSecret: identity.rebindSecret,
      trayId: 'tray-1',
      controllerToken: 'tray-1.ct',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    fetchImpl.mockResolvedValueOnce(
      Response.json({ error: identity.rebindSecret }, { status: 503 })
    );
    await expect(first.revokeWebhook('id')).rejects.toThrow('Tray request failed (503)');
    expect(JSON.stringify(getLeaderTrayRuntimeStatus())).not.toContain(identity.rebindSecret);
  });

  it('allows local-only deletion but fails closed for a disconnected persisted home', async () => {
    const storage = { getItem: () => base };
    await expect(assertNoStableWebhookHome(storage)).resolves.toBeUndefined();
    await expect(manager().revokeWebhook('local')).resolves.toBeUndefined();
    const first = manager();
    await first.start();
    first.stop();
    await expect(assertNoStableWebhookHome(storage)).rejects.toThrow('leader is disconnected');
    await expect(manager().revokeWebhook('remote')).rejects.toThrow('leader is disconnected');
  });

  it('refuses a pending rotation for a different hub before sending credentials', async () => {
    const first = manager();
    const session = await first.start();
    const identity = (await identityStore.load())!;
    first.stop();
    await identityStore.save({
      ...identity,
      pendingRotation: {
        ...session,
        workerBaseUrl: 'https://other.example.com',
        secret: 'a'.repeat(32),
        rebindSecret: 'b'.repeat(32),
      },
    });
    const calls = fetchImpl.mock.calls.length;
    await expect(manager().start()).rejects.toThrow('different hub');
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('recovers the new URL if rotation persisted identity but session save failed', async () => {
    const first = manager();
    await first.start();
    const identity = (await identityStore.load())!;
    let newUrl = '';
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      const intent = JSON.parse(String(init?.body));
      newUrl = `${base}/wh/${identity.coneId}.${intent.secret}`;
      return Response.json({
        coneId: identity.coneId,
        webhook: { url: newUrl, rebindToken: `${identity.coneId}.${intent.rebindSecret}` },
      });
    });
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('session persistence failed'));
    await expect(first.rotateWebhook()).rejects.toThrow('session persistence failed');
    first.stop();
    expect((await manager().start()).webhookUrl).toBe(newUrl);
  });

  it('fails closed on corrupt management state instead of minting a replacement identity', async () => {
    await db.setState(`leader-webhook-identity:${base}`, '{"coneId":"partial"}');
    await expect(manager().start()).rejects.toThrow('management identity is invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs only sanitized status for rejected supersession, without reading its body', async () => {
    const first = manager();
    const source = await first.start();
    const response = new Response('rebind-secret-in-error', { status: 503 });
    const bodyRead = vi.spyOn(response, 'json');
    fetchImpl.mockResolvedValueOnce(response);
    first.supersedePreviousSession(source, {
      joinUrl: `${base}/join/new`,
      webhookUrl: source.webhookUrl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(bodyRead).not.toHaveBeenCalled();
    expect(getLeaderTrayRuntimeStatus().error).toBeNull();
    expect(fetchImpl.mock.calls[2][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
