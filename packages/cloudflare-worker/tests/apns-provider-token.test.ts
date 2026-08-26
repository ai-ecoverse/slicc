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

    await store.save({ value: 'jwt', mintedAt: 42, identity: 'TEAM1234.KEY5678' });
    expect(await store.load()).toEqual({
      value: 'jwt',
      mintedAt: 42,
      identity: 'TEAM1234.KEY5678',
    });

    // A half-written or older-shaped record must not be handed to APNs.
    await storage.put(APNS_TOKEN_STORAGE_KEY, { value: '', mintedAt: 'nope' });
    expect(await store.load()).toBeNull();
  });
});

describe('credential rotation', () => {
  it('discards a stored token signed by different credentials and mints at once', async () => {
    // Rotating the key id must not be mistaken for staleness: the floor would
    // pin the dead token for 20 minutes even though the new pair has its own
    // budget with Apple.
    const state = new FakeDurableObjectState();
    const store = durableObjectProviderTokenStore(state.storage);
    const now = () => 1_750_000_000_000;
    const before = await new LocalProviderTokenMinter(CONFIG(), { now, store }).getToken();
    expect(before.identity).toBe('TEAM1234.KEY5678');

    const rotated = new LocalProviderTokenMinter({ ...CONFIG(), keyId: 'KEY9999' }, { now, store });
    const after = await rotated.getToken();
    expect(after.identity).toBe('TEAM1234.KEY9999');
    expect(after.value).not.toBe(before.value);
  });

  it('discards a stored record predating the identity field', async () => {
    const state = new FakeDurableObjectState();
    await state.storage.put(APNS_TOKEN_STORAGE_KEY, { value: 'legacy', mintedAt: 1 });
    const minter = new LocalProviderTokenMinter(CONFIG(), {
      now: () => 1_000,
      store: durableObjectProviderTokenStore(state.storage),
    });
    expect((await minter.getToken()).value).not.toBe('legacy');
  });
});

describe('handleProviderTokenRequest', () => {
  it('serves the current token and forwards a stale-token rotation request', async () => {
    const asked: Array<string | undefined> = [];
    const minter: ApnsProviderTokenSource = {
      async getToken(staleToken?: string): Promise<ApnsProviderToken> {
        asked.push(staleToken);
        return { value: staleToken ? 'jwt-2' : 'jwt-1', mintedAt: 7, identity: 'i' };
      },
    };

    const plain = await handleProviderTokenRequest(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, { method: 'POST', body: '{}' }),
      minter
    );
    expect(await plain.json()).toEqual({ value: 'jwt-1', mintedAt: 7, identity: 'i' });

    const rotate = await handleProviderTokenRequest(
      new Request(`${HOST}${APNS_TOKEN_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ staleToken: 'jwt-1' }),
      }),
      minter
    );
    expect(await rotate.json()).toEqual({ value: 'jwt-2', mintedAt: 7, identity: 'i' });
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
        return Response.json({
          value: 'shared-jwt',
          mintedAt: 1_000,
          identity: 'TEAM1234.KEY5678',
        });
      },
    };
    const ns = fakeNamespace(stub);
    let now = 1_000;
    const source = new SharedProviderTokenSource(ns, () => now);

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
        return Response.json({
          value: 'shared-jwt',
          mintedAt: 1_000,
          identity: 'TEAM1234.KEY5678',
        });
      },
    };
    const source = new SharedProviderTokenSource(fakeNamespace(stub), () => 1_000);
    await source.getToken();
    await source.getToken('shared-jwt');
    expect(bodies).toEqual(['{}', JSON.stringify({ staleToken: 'shared-jwt' })]);
  });

  it('never mints locally when the shared instance is unreachable', async () => {
    // Falling back to per-tray minting would restore the very behaviour this
    // module removes, turning a brief local outage into account-wide 429
    // throttling that outlasts it. Fail the push instead.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signSpy = vi.spyOn(crypto.subtle, 'sign');
    const before = signSpy.mock.calls.length;
    const source = new SharedProviderTokenSource(
      fakeNamespace({
        fetch: async () => {
          throw new Error('DO unavailable');
        },
      }),
      () => 5_000
    );
    await expect(source.getToken()).rejects.toThrow('DO unavailable');
    expect(signSpy.mock.calls.length - before).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping push'), expect.anything());
    signSpy.mockRestore();
    warn.mockRestore();
  });

  it('rides out an outage on a borrowed token that Apple will still accept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = false;
    let now = 1_000;
    const source = new SharedProviderTokenSource(
      fakeNamespace({
        fetch: async () => {
          if (fail) throw new Error('DO unavailable');
          return Response.json({
            value: 'shared-jwt',
            mintedAt: 1_000,
            identity: 'TEAM1234.KEY5678',
          });
        },
      }),
      () => now
    );
    await source.getToken();
    fail = true;

    // Past the re-ask point but inside Apple's expiry: reuse rather than drop.
    now = 1_000 + 52 * 60 * 1000;
    await expect(source.getToken()).resolves.toMatchObject({ value: 'shared-jwt' });

    // Past the hard age limit: the token is no good to Apple either, so fail.
    now = 1_000 + 56 * 60 * 1000;
    await expect(source.getToken()).rejects.toThrow('DO unavailable');
    warn.mockRestore();
  });

  it('does not reuse a borrowed token the gateway just rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = false;
    const source = new SharedProviderTokenSource(
      fakeNamespace({
        fetch: async () => {
          if (fail) throw new Error('DO unavailable');
          return Response.json({
            value: 'shared-jwt',
            mintedAt: 1_000,
            identity: 'TEAM1234.KEY5678',
          });
        },
      }),
      () => 1_000
    );
    await source.getToken();
    fail = true;
    await expect(source.getToken('shared-jwt')).rejects.toThrow('DO unavailable');
    warn.mockRestore();
  });

  it('rejects an error status or a malformed payload from the shared instance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const erroring = new SharedProviderTokenSource(
      fakeNamespace({ fetch: async () => new Response('nope', { status: 503 }) }),
      () => 1
    );
    await expect(erroring.getToken()).rejects.toThrow('responded 503');

    const junk = new SharedProviderTokenSource(
      fakeNamespace({ fetch: async () => Response.json({ nope: true }) }),
      () => 2
    );
    await expect(junk.getToken()).rejects.toThrow('malformed token');
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
