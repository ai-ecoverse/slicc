/**
 * Shared APNs provider token (issue #2432).
 *
 * Apple throttles provider-token creation per (team id, key id) pair, so the
 * property under test is a *count*: however many tray Durable Objects push,
 * and however often hibernation reconstructs them, exactly one JWT gets
 * signed. The old code signed one per DO per wake.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApnsProviderToken,
  type ApnsProviderTokenSource,
  LocalProviderTokenMinter,
} from '../src/apns.js';
import {
  APNS_TOKEN_DO_NAME,
  APNS_TOKEN_PATH,
  APNS_TOKEN_STORAGE_KEY,
  durableObjectProviderTokenStore,
  handleProviderTokenRequest,
  SharedProviderTokenSource,
} from '../src/apns-provider-token.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import type { DurableObjectNamespaceLike, DurableObjectStubLike } from '../src/shared.js';
import { createCapabilityToken } from '../src/shared.js';
import { createFakeWebSocketPair, FakeDurableObjectState, FakeStorage } from './fake-do-state.js';

const HOST = 'https://www.sliccy.ai';
let pem = '';

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  pem = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

const APNS_ENV = () => ({
  APNS_TEAM_ID: 'TEAM1234',
  APNS_KEY_ID: 'KEY5678',
  APNS_PRIVATE_KEY: pem,
  APNS_TOPIC: 'com.sliccy.follower',
});

const CONFIG = () => ({
  teamId: 'TEAM1234',
  keyId: 'KEY5678',
  privateKeyPem: pem,
  topic: 'com.sliccy.follower',
});

describe('durableObjectProviderTokenStore', () => {
  it('round-trips a token and rejects a malformed stored value', async () => {
    const storage = new FakeStorage();
    const store = durableObjectProviderTokenStore(storage);
    expect(await store.load()).toBeNull();

    await store.save({ value: 'jwt', mintedAt: 42 });
    expect(await store.load()).toEqual({ value: 'jwt', mintedAt: 42 });

    // A half-written or older-shaped record must not be handed to APNs.
    await storage.put(APNS_TOKEN_STORAGE_KEY, { value: '', mintedAt: 'nope' });
    expect(await store.load()).toBeNull();
  });
});

describe('handleProviderTokenRequest', () => {
  it('serves the current token and forwards a stale-token rotation request', async () => {
    const asked: Array<string | undefined> = [];
    const minter: ApnsProviderTokenSource = {
      async getToken(staleToken?: string): Promise<ApnsProviderToken> {
        asked.push(staleToken);
        return { value: staleToken ? 'jwt-2' : 'jwt-1', mintedAt: 7 };
      },
    };

    const plain = await handleProviderTokenRequest(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST', body: '{}' }),
      minter
    );
    expect(await plain.json()).toEqual({ value: 'jwt-1', mintedAt: 7 });

    const rotate = await handleProviderTokenRequest(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ staleToken: 'jwt-1' }),
      }),
      minter
    );
    expect(await rotate.json()).toEqual({ value: 'jwt-2', mintedAt: 7 });
    expect(asked).toEqual([undefined, 'jwt-1']);
  });

  it('tolerates a missing or unparseable body', async () => {
    const minter = new LocalProviderTokenMinter(CONFIG(), { now: () => 1_000 });
    const response = await handleProviderTokenRequest(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST', body: 'not json' }),
      minter
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mintedAt: 1_000 });
  });
});

describe('SharedProviderTokenSource', () => {
  function fakeNamespace(stub: DurableObjectStubLike): DurableObjectNamespaceLike & {
    names: string[];
  } {
    const names: string[] = [];
    return {
      names,
      idFromName(name: string) {
        names.push(name);
        return { toString: () => name } as unknown as ReturnType<
          DurableObjectNamespaceLike['idFromName']
        >;
      },
      get: () => stub,
    };
  }

  it('borrows from the well-known instance and memoises by mint time', async () => {
    let served = 0;
    const stub: DurableObjectStubLike = {
      fetch: async () => {
        served += 1;
        return Response.json({ value: 'shared-jwt', mintedAt: 1_000 });
      },
    };
    const ns = fakeNamespace(stub);
    let now = 1_000;
    const source = new SharedProviderTokenSource(
      ns,
      new LocalProviderTokenMinter(CONFIG(), { now: () => now }),
      () => now
    );

    expect((await source.getToken()).value).toBe('shared-jwt');
    expect(ns.names).toEqual([APNS_TOKEN_DO_NAME]);

    // Within the borrowed token's life: no second round trip.
    now = 1_000 + 40 * 60 * 1000;
    expect((await source.getToken()).value).toBe('shared-jwt');
    expect(served).toBe(1);

    // Past it: ask again rather than ride a token toward Apple's 60-min expiry.
    now = 1_000 + 51 * 60 * 1000;
    await source.getToken();
    expect(served).toBe(2);
  });

  it('always re-asks when reporting a stale token, ignoring the memo', async () => {
    const bodies: string[] = [];
    const stub: DurableObjectStubLike = {
      fetch: async (input) => {
        bodies.push(await (input as Request).text());
        return Response.json({ value: 'shared-jwt', mintedAt: 1_000 });
      },
    };
    const source = new SharedProviderTokenSource(
      fakeNamespace(stub),
      new LocalProviderTokenMinter(CONFIG()),
      () => 1_000
    );
    await source.getToken();
    await source.getToken('shared-jwt');
    expect(bodies).toEqual(['{}', JSON.stringify({ staleToken: 'shared-jwt' })]);
  });

  it('falls back to local minting when the shared instance is unreachable', async () => {
    // A single object being down must not take every push with it; the local
    // minter carries its own 20-minute floor, so the blast radius is bounded.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub: DurableObjectStubLike = {
      fetch: async () => {
        throw new Error('DO unavailable');
      },
    };
    const source = new SharedProviderTokenSource(
      fakeNamespace(stub),
      new LocalProviderTokenMinter(CONFIG(), { now: () => 5_000 }),
      () => 5_000
    );
    await expect(source.getToken()).resolves.toMatchObject({ mintedAt: 5_000 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('shared APNs provider token unavailable'),
      expect.anything()
    );
    warn.mockRestore();
  });

  it('falls back when the shared instance answers with an error or junk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const erroring = new SharedProviderTokenSource(
      fakeNamespace({ fetch: async () => new Response('nope', { status: 503 }) }),
      new LocalProviderTokenMinter(CONFIG(), { now: () => 1 }),
      () => 1
    );
    await expect(erroring.getToken()).resolves.toMatchObject({ mintedAt: 1 });

    const junk = new SharedProviderTokenSource(
      fakeNamespace({ fetch: async () => Response.json({ nope: true }) }),
      new LocalProviderTokenMinter(CONFIG(), { now: () => 2 }),
      () => 2
    );
    await expect(junk.getToken()).resolves.toMatchObject({ mintedAt: 2 });
    warn.mockRestore();
  });
});

describe('SessionTrayDurableObject provider-token route', () => {
  function makeDurable(env: Record<string, unknown>, state = new FakeDurableObjectState()) {
    const durable = new SessionTrayDurableObject(state, env, {
      now: () => 1_750_000_000_000,
      webSocketPairFactory: () => createFakeWebSocketPair(state),
    });
    state.instance = durable;
    return { durable, state };
  }

  it('serves the token without needing a tray record on that instance', async () => {
    // The minting instance is reached by name, never created via /internal/create,
    // so this route has to work before (and without) loadTray().
    const { durable } = makeDurable(APNS_ENV());
    const response = await durable.fetch(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST', body: '{}' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      value: expect.stringMatching(/^ey/),
      mintedAt: 1_750_000_000_000,
    });
  });

  it('persists the minted token so hibernation does not re-mint', async () => {
    const state = new FakeDurableObjectState();
    const first = makeDurable(APNS_ENV(), state);
    const minted = (await (
      await first.durable.fetch(new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST' }))
    ).json()) as ApnsProviderToken;

    // Same storage, brand-new instance: what a hibernation wake looks like.
    const revived = makeDurable(APNS_ENV(), state);
    const again = (await (
      await revived.durable.fetch(new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST' }))
    ).json()) as ApnsProviderToken;
    expect(again.value).toBe(minted.value);
  });

  it('reports 503 when APNs is not configured', async () => {
    const { durable } = makeDurable({});
    const response = await durable.fetch(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST', body: '{}' })
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'APNS_NOT_CONFIGURED' });
  });
});

describe('mint rate across many tray DOs', () => {
  it('signs exactly one JWT no matter how many trays push or hibernate', async () => {
    // The regression this whole change exists for. Before: one signature per
    // tray per wake. After: one signature, borrowed by everyone.
    const mintingState = new FakeDurableObjectState();
    let mintingDurable: SessionTrayDurableObject | null = null;
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name: string) =>
        ({ toString: () => name }) as unknown as ReturnType<
          DurableObjectNamespaceLike['idFromName']
        >,
      get: () => ({
        fetch: async (input: Request | string | URL, init?: RequestInit) => {
          // Reconstruct on every call: the minting DO hibernates too, and the
          // storage-backed cache is what has to absorb that.
          const state = mintingState;
          mintingDurable = new SessionTrayDurableObject(
            state,
            { ...APNS_ENV(), TRAY_HUB: namespace },
            {
              now: () => 1_750_000_000_000,
              webSocketPairFactory: () => createFakeWebSocketPair(state),
            }
          );
          state.instance = mintingDurable;
          return mintingDurable.fetch(
            input instanceof Request ? input : new Request(String(input), init)
          );
        },
      }),
    };

    const signSpy = vi.spyOn(crypto.subtle, 'sign');
    const before = signSpy.mock.calls.length;
    const env = { ...APNS_ENV(), TRAY_HUB: namespace };

    const values: string[] = [];
    for (let tray = 0; tray < 6; tray++) {
      // Fresh instance per iteration == a tray DO woken from hibernation.
      const state = new FakeDurableObjectState();
      const durable = new SessionTrayDurableObject(state, env, {
        now: () => 1_750_000_000_000,
        webSocketPairFactory: () => createFakeWebSocketPair(state),
      });
      state.instance = durable;
      const trayId = crypto.randomUUID();
      await durable.fetch(
        new Request(`${HOST}/internal/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            trayId,
            createdAt: new Date(1_750_000_000_000).toISOString(),
            joinToken: createCapabilityToken(trayId),
            controllerToken: createCapabilityToken(trayId),
            webhookToken: createCapabilityToken(trayId),
          }),
        })
      );
      const borrowed = (await (
        await namespace
          .get(namespace.idFromName(APNS_TOKEN_DO_NAME))
          .fetch(new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST', body: '{}' }))
      ).json()) as ApnsProviderToken;
      values.push(borrowed.value);
    }

    expect(signSpy.mock.calls.length - before).toBe(1);
    expect(new Set(values).size).toBe(1);
    signSpy.mockRestore();
  });
});
