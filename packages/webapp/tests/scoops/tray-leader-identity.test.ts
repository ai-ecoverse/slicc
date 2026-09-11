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
        const identity = JSON.parse(String(init?.body)) as ConeIdentity;
        // Verify the credential survived durable storage before going on the wire.
        expect(await identityStore.load()).toMatchObject(identity);
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
    expect(await identityStore.load()).toMatchObject({ ...saved, established: true });
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
      expect(JSON.parse(String(init?.body))).toEqual({
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
    const newUrl = `${base}/wh/${identity.coneId}.newsecret`;
    const save = vi.spyOn(identityStore, 'save');
    save.mockImplementationOnce(async (next) => {
      expect(getLeaderTrayRuntimeStatus().session?.webhookUrl).toBe(old.webhookUrl);
      await new IndexedDbLeaderWebhookIdentityStore(base).save(next);
    });
    await vi.waitFor(() => expect(resolveRotation).toBeTypeOf('function'));
    resolveRotation(
      Response.json({
        coneId: identity.coneId,
        webhook: { url: newUrl, rebindToken: `${identity.coneId}.${identity.rebindSecret}` },
      })
    );
    expect(await rotation).toEqual({ webhookUrl: newUrl });
    expect(await duplicate).toEqual({ webhookUrl: newUrl });
    expect((await reset).webhookUrl).toBe(newUrl);
    expect(creates[1].coneSecret).toBe('newsecret');
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
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        coneId: identity!.coneId,
        webhook: {
          url: `${base}/wh/${identity!.coneId}.newsecret`,
          rebindToken: `${identity!.coneId}.${identity!.rebindSecret}`,
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
    const newUrl = `${base}/wh/${identity.coneId}.newsecret`;
    fetchImpl.mockImplementationOnce(async () => {
      expect((await identityStore.load())?.pendingRotation?.trayId).toBe('tray-1');
      throw new Error('response lost after server committed rotation');
    });
    await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
    const rotationBody = fetchImpl.mock.calls[2][1]?.body;
    first.stop();
    const callsBeforeReload = fetchImpl.mock.calls.length;
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        coneId: identity.coneId,
        webhook: { url: newUrl, rebindToken: `${identity.coneId}.${identity.rebindSecret}` },
      })
    );
    const reloaded = manager();
    expect((await reloaded.start()).webhookUrl).toBe(newUrl);
    expect(String(fetchImpl.mock.calls[callsBeforeReload][0])).toContain('/webhook/rotate');
    expect(fetchImpl.mock.calls[callsBeforeReload][1]?.body).toBe(rotationBody);
    expect((await identityStore.load())?.pendingRotation).toBeUndefined();
    expect((await reloaded.reset()).webhookUrl).toBe(newUrl);
    expect(creates[1].coneSecret).toBe('newsecret');
  });

  it('keeps a pending rotation fail-closed when replay fails on reload', async () => {
    const first = manager();
    await first.start();
    fetchImpl.mockRejectedValueOnce(new Error('lost rotation response'));
    await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
    first.stop();
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(manager().start()).rejects.toThrow('(503)');
    expect(creates).toHaveLength(1);
    expect((await identityStore.load())?.pendingRotation).toBeDefined();
  });

  it.each([true, false])(
    'replays pending rotation before rebinding an expired source (server committed: %s)',
    async (committed) => {
      const first = manager();
      await first.start();
      const identity = (await identityStore.load())!;
      let serverSecret = identity.coneSecret;
      fetchImpl.mockImplementationOnce(async () => {
        if (committed) serverSecret = 'newsecret';
        throw new Error('uncertain response before source expires');
      });
      await expect(first.rotateWebhook()).rejects.toThrow('transport unavailable');
      first.stop();
      // The worker's ownership-only rotation replay can authenticate a retained
      // source controller after expiry; it must not require a fresh target bind.
      fetchImpl.mockImplementationOnce(async (url, init) => {
        expect(String(url)).toBe(`${base}/api/tray/tray-1/webhook/rotate`);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tray-1.ct');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          oldSecret: identity.coneSecret,
          oldRebindSecret: identity.rebindSecret,
        });
        expect(serverSecret).toBe(committed ? 'newsecret' : identity.coneSecret);
        serverSecret = 'newsecret';
        return Response.json({
          coneId: identity.coneId,
          webhook: {
            url: `${base}/wh/${identity.coneId}.${serverSecret}`,
            rebindToken: `${identity.coneId}.${identity.rebindSecret}`,
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
      pendingRotation: { ...session, workerBaseUrl: 'https://other.example.com' },
    });
    const calls = fetchImpl.mock.calls.length;
    await expect(manager().start()).rejects.toThrow('different hub');
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('recovers the new URL if rotation persisted identity but session save failed', async () => {
    const first = manager();
    await first.start();
    const identity = (await identityStore.load())!;
    const newUrl = `${base}/wh/${identity.coneId}.newsecret`;
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        coneId: identity.coneId,
        webhook: { url: newUrl, rebindToken: `${identity.coneId}.${identity.rebindSecret}` },
      })
    );
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
