import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
} from '../../../src/cdp/extension-bridge-protocol.js';
import { ExtensionBridgeTransport } from '../../../src/cdp/extension-bridge-transport.js';
import { BrowserAPI } from '../../../src/cdp/index.js';
import { fetchRuntimeConfig } from '../../../src/scoops/tray-runtime-config.js';
import {
  getBridgeToken,
  setBridgeToken,
  setLocalApiBaseUrl,
} from '../../../src/shell/proxied-fetch.js';
import {
  CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS,
  connectWithBoundedRetry,
  parseExtensionLeaderParams,
  setupStandalonePrelude,
} from '../../../src/ui/boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';

function createLog(): BootStageLogger & {
  warnCalls: unknown[][];
  infoCalls: unknown[][];
} {
  const warnCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  return {
    debug: vi.fn(),
    info: (..._args: unknown[]) => {
      infoCalls.push(_args);
    },
    warn: (..._args: unknown[]) => {
      warnCalls.push(_args);
    },
    error: vi.fn(),
    warnCalls,
    infoCalls,
  } as unknown as BootStageLogger & { warnCalls: unknown[][]; infoCalls: unknown[][] };
}

function createBrowser(connect: BrowserAPI['connect']): BrowserAPI {
  return { connect } as unknown as BrowserAPI;
}

describe('connectWithBoundedRetry', () => {
  it('resolves on the first attempt when the bridge accepts immediately', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const log = createLog();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithBoundedRetry(
      createBrowser(connect as unknown as BrowserAPI['connect']),
      { url: 'ws://localhost:5710/cdp', protocols: 'slicc.bridge.v1.x' },
      log,
      [100, 200],
      sleep
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.warnCalls).toHaveLength(0);
    expect(log.infoCalls).toHaveLength(0);
  });

  it('retries with the supplied backoff schedule and succeeds after a transient failure', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    const log = createLog();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithBoundedRetry(
      createBrowser(connect as unknown as BrowserAPI['connect']),
      undefined,
      log,
      [100, 200, 400],
      sleep
    );

    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    expect(log.infoCalls).toHaveLength(1);
    expect(log.warnCalls).toHaveLength(0);
  });

  it('gives up after all retries are exhausted and logs the final failure (does not throw)', async () => {
    const err = new Error('bridge never came up');
    const connect = vi.fn().mockRejectedValue(err);
    const log = createLog();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithBoundedRetry(
      createBrowser(connect as unknown as BrowserAPI['connect']),
      undefined,
      log,
      [50, 50],
      sleep
    );

    // delays.length + 1 attempts total.
    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.warnCalls).toHaveLength(1);
    expect(String(log.warnCalls[0]?.[1] ?? '')).toBe('bridge never came up');
  });

  it('exposes a non-trivial default backoff schedule', () => {
    expect(CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    // Schedule must be monotonically non-decreasing — exponential backoff intent.
    for (let i = 1; i < CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS.length; i++) {
      const prev = CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS[i - 1] ?? 0;
      const cur = CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS[i] ?? 0;
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe('parseExtensionLeaderParams', () => {
  it('returns the extension id for the pinned leader tab carrying ?slicc=leader&ext=<id>', () => {
    expect(parseExtensionLeaderParams('?slicc=leader&ext=abc123')).toEqual({
      extensionId: 'abc123',
    });
  });

  it('tolerates a search string without the leading question mark', () => {
    expect(parseExtensionLeaderParams('slicc=leader&ext=abc123')).toEqual({
      extensionId: 'abc123',
    });
  });

  it('returns null when the slicc=leader marker is absent', () => {
    expect(parseExtensionLeaderParams('?ext=abc123')).toBeNull();
  });

  it('returns null when the slicc marker has a non-leader value', () => {
    expect(parseExtensionLeaderParams('?slicc=follower&ext=abc123')).toBeNull();
  });

  it('returns null when the ext id is missing (e.g. a hand-opened leader tab)', () => {
    expect(parseExtensionLeaderParams('?slicc=leader')).toBeNull();
  });

  it('returns null when the ext id is present but empty', () => {
    expect(parseExtensionLeaderParams('?slicc=leader&ext=')).toBeNull();
  });
});

interface FakeBridgePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

function createFakeWindow(search: string): Window {
  const store = new Map<string, string>();
  return {
    location: { search, href: `https://www.sliccy.ai/${search}` },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  } as unknown as Window;
}

describe('setupStandalonePrelude — extension leader transport selection', () => {
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup of an injected global
    delete (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as Record<string, unknown>).__slicc_browser;
  });

  it('routes CDP through ExtensionBridgeTransport when the leader tab carries ?slicc=leader&ext=<id>', async () => {
    const connect = vi.fn((_extensionId: string, _info: { name: string }): FakeBridgePort => {
      const listeners: Array<(msg: unknown) => void> = [];
      return {
        postMessage: (msg: unknown) => {
          const env = msg as { kind?: string; channelId?: string };
          if (env?.kind === 'handshake.hello') {
            queueMicrotask(() => {
              for (const l of listeners) {
                l({
                  bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
                  channelId: env.channelId,
                  kind: 'handshake.welcome',
                });
              }
            });
          }
        },
        disconnect: vi.fn(),
        onMessage: {
          addListener: (cb: (msg: unknown) => void) => {
            listeners.push(cb);
          },
        },
        onDisconnect: { addListener: () => {} },
      };
    });
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect } };

    const result = await setupStandalonePrelude({
      runtimeMode: 'standalone',
      envBaseUrl: null,
      window: createFakeWindow('?slicc=leader&ext=test-ext-id'),
      log: createLog(),
    });

    expect(connect).toHaveBeenCalledWith('test-ext-id', { name: EXTENSION_BRIDGE_PORT_NAME });
    expect(result.realCdpTransport).toBeInstanceOf(ExtensionBridgeTransport);
    expect(result.browser).toBeDefined();
  });

  it('forwards an extension.lick into the late-bound client inject seam as a navigate LickEvent', async () => {
    // Capture the live port listeners + the channelId the transport minted so
    // the test can push an `extension.lick` envelope down the welcomed Port.
    const listeners: Array<(msg: unknown) => void> = [];
    let channelId: string | undefined;
    const connect = vi.fn((_extensionId: string, _info: { name: string }): FakeBridgePort => {
      return {
        postMessage: (msg: unknown) => {
          const env = msg as { kind?: string; channelId?: string };
          if (env?.kind === 'handshake.hello') {
            channelId = env.channelId;
            queueMicrotask(() => {
              for (const l of listeners) {
                l({
                  bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
                  channelId: env.channelId,
                  kind: 'handshake.welcome',
                });
              }
            });
          }
        },
        disconnect: vi.fn(),
        onMessage: {
          addListener: (cb: (msg: unknown) => void) => {
            listeners.push(cb);
          },
        },
        onDisconnect: { addListener: () => {} },
      };
    });
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect } };

    const result = await setupStandalonePrelude({
      runtimeMode: 'standalone',
      envBaseUrl: null,
      window: createFakeWindow('?slicc=leader&ext=test-ext-id'),
      log: createLog(),
    });

    // Late-bind the kernel client (minted after the prelude in real boot).
    const forwarded: unknown[] = [];
    expect(result.attachLickForwardingClient).toBeDefined();
    result.attachLickForwardingClient?.({
      sendForwardedLick: (event) => forwarded.push(event),
    });

    // Push a handoff lick down the (welcomed) Port — channelId-matched.
    expect(channelId).toBeDefined();
    for (const l of listeners) {
      l({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
        kind: 'extension.lick',
        verb: 'handoff',
        target: 'https://github.com/acme/repo',
        url: 'https://www.sliccy.ai/handoff?handoff=fix+the+bug',
        instruction: 'fix the bug',
      });
    }

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      type: 'navigate',
      navigateUrl: 'https://www.sliccy.ai/handoff?handoff=fix+the+bug',
      body: {
        verb: 'handoff',
        target: 'https://github.com/acme/repo',
        url: 'https://www.sliccy.ai/handoff?handoff=fix+the+bug',
        instruction: 'fix the bug',
      },
    });
  });

  it('buffers extension.licks delivered BEFORE the client attaches and flushes them in order on attach', async () => {
    const listeners: Array<(msg: unknown) => void> = [];
    let channelId: string | undefined;
    const connect = vi.fn((_extensionId: string, _info: { name: string }): FakeBridgePort => {
      return {
        postMessage: (msg: unknown) => {
          const env = msg as { kind?: string; channelId?: string };
          if (env?.kind === 'handshake.hello') {
            channelId = env.channelId;
            queueMicrotask(() => {
              for (const l of listeners) {
                l({
                  bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
                  channelId: env.channelId,
                  kind: 'handshake.welcome',
                });
              }
            });
          }
        },
        disconnect: vi.fn(),
        onMessage: {
          addListener: (cb: (msg: unknown) => void) => {
            listeners.push(cb);
          },
        },
        onDisconnect: { addListener: () => {} },
      };
    });
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect } };

    const result = await setupStandalonePrelude({
      runtimeMode: 'standalone',
      envBaseUrl: null,
      window: createFakeWindow('?slicc=leader&ext=test-ext-id'),
      log: createLog(),
    });

    expect(result.attachLickForwardingClient).toBeDefined();
    expect(channelId).toBeDefined();

    // Two licks arrive on the welcomed Port BEFORE the kernel client attaches.
    const pushLick = (target: string, instruction: string): void => {
      const url = `https://www.sliccy.ai/handoff?handoff=${encodeURIComponent(instruction)}`;
      for (const l of listeners) {
        l({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId,
          kind: 'extension.lick',
          verb: 'handoff',
          target,
          url,
          instruction,
        });
      }
    };
    pushLick('https://github.com/acme/first', 'first');
    pushLick('https://github.com/acme/second', 'second');

    // Late-bind the kernel client — buffered licks flush in arrival order.
    const forwarded: unknown[] = [];
    result.attachLickForwardingClient?.({
      sendForwardedLick: (event) => forwarded.push(event),
    });

    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]).toMatchObject({
      type: 'navigate',
      body: { target: 'https://github.com/acme/first', instruction: 'first' },
    });
    expect(forwarded[1]).toMatchObject({
      type: 'navigate',
      body: { target: 'https://github.com/acme/second', instruction: 'second' },
    });

    // A lick after attach forwards synchronously (no second flush).
    pushLick('https://github.com/acme/third', 'third');
    expect(forwarded).toHaveLength(3);
    expect(forwarded[2]).toMatchObject({
      type: 'navigate',
      body: { target: 'https://github.com/acme/third', instruction: 'third' },
    });
  });
});

describe('setupStandalonePrelude — thin-bridge runtime-config origin', () => {
  afterEach(() => {
    // Reset the module-level proxied-fetch state mutated by the bridge boot so
    // it can't leak into sibling tests (same-origin assumptions elsewhere).
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    vi.unstubAllGlobals();
  });

  it('reads runtime-config (trayJoinUrl) from the local node-server origin with the bridge token, after wiring the bridge', async () => {
    // A follower overlay tab so the boot skips the eager /cdp connect — the
    // assertion target is the runtime-config fetch, not CDP.
    const search = '?bridge=ws://localhost:7777/cdp&bridgeToken=secret-bridge-token&role=follower';

    const fetchCalls: Array<{ url: string; bridgeHeader: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ url: String(input), bridgeHeader: headers['X-Bridge-Token'] });
      return new Response(JSON.stringify({ trayJoinUrl: 'https://tray.example/join' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await setupStandalonePrelude({
      runtimeMode: 'electron-overlay',
      envBaseUrl: null,
      window: createFakeWindow(search),
      log: createLog(),
    });

    // The runtime-config fetch must target the local node-server origin
    // (derived from the bridge WS URL), NOT the hosted leader same-origin.
    const cfgCall = fetchCalls.find((c) => c.url.endsWith('/api/runtime-config'));
    expect(cfgCall).toBeDefined();
    expect(cfgCall?.url).toBe('http://localhost:7777/api/runtime-config');
    // And it must carry the bridge token header — proving setLocalApiBaseUrl +
    // setBridgeToken ran BEFORE the fetch (ordering invariant).
    expect(cfgCall?.bridgeHeader).toBe('secret-bridge-token');

    // The bridge wiring is surfaced on the prelude result for the caller.
    expect(result.localApiBaseUrl).toBe('http://localhost:7777');
    expect(result.bridgeToken).toBe('secret-bridge-token');
    expect(getBridgeToken()).toBe('secret-bridge-token');
  });

  it('primes the bridge connect options for a follower overlay (BUG-F3) without eager-connecting', async () => {
    // A follower overlay tab skips the eager /cdp dial (single-client slot
    // contention), but must still record the LOCAL bridge connect options so a
    // later tray-follower `listPages()` reconnects to the bridge instead of the
    // hosted-leader origin. Without this its Electron pages never federate.
    const search = '?bridge=ws://localhost:7777/cdp&bridgeToken=secret-bridge-token&role=follower';

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const primeSpy = vi.spyOn(BrowserAPI.prototype, 'primeConnectOptions');
    const connectSpy = vi.spyOn(BrowserAPI.prototype, 'connect');

    try {
      await setupStandalonePrelude({
        runtimeMode: 'electron-overlay',
        envBaseUrl: null,
        window: createFakeWindow(search),
        log: createLog(),
      });

      // No eager connect for the follower overlay …
      expect(connectSpy).not.toHaveBeenCalled();
      // … but the bridge connect options are primed for the lazy reconnect.
      expect(primeSpy).toHaveBeenCalledWith({
        url: 'ws://localhost:7777/cdp',
        protocols: 'slicc.bridge.v1.secret-bridge-token',
      });
    } finally {
      primeSpy.mockRestore();
      connectSpy.mockRestore();
    }
  });

  it('seeds the tray worker base URL in hosted-leader mode even without a runtime-config endpoint', async () => {
    // Regression guard: hosted-leader must pass its runtimeMode (not
    // 'standalone') to shouldUseRuntimeModeTrayDefaults so the default
    // production worker URL is seeded. Without this, the tray never
    // initializes and /api/cloud-status is never called — cones time out.
    const search = '?runtime=hosted-leader';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })) // no runtime-config endpoint
    );

    const fakeWindow = createFakeWindow(search);
    await setupStandalonePrelude({
      runtimeMode: 'hosted-leader',
      envBaseUrl: null,
      window: fakeWindow,
      log: createLog(),
    });

    const stored = (
      fakeWindow as unknown as { localStorage: { getItem(k: string): string | null } }
    ).localStorage.getItem('slicc.trayWorkerBaseUrl');
    expect(stored).toBeTruthy();
  });

  it('keeps the runtime-config fetch same-origin with no bridge token when no bridge is wired (no regression)', async () => {
    // No bridge configured (the legacy bundled-UI path). `resolveApiUrl`
    // returns the relative path and `apiHeaders` is empty, so the fetch must
    // stay same-origin without an `X-Bridge-Token`.
    setLocalApiBaseUrl(null);
    setBridgeToken(null);

    let seenUrl: string | undefined;
    let seenBridgeHeader: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenUrl = String(input);
      seenBridgeHeader = headers['X-Bridge-Token'];
      return new Response(JSON.stringify({ trayJoinUrl: 'https://tray.example/join' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await fetchRuntimeConfig(fetchMock as unknown as typeof fetch);

    expect(seenUrl).toBe('/api/runtime-config');
    expect(seenBridgeHeader).toBeUndefined();
  });
});
