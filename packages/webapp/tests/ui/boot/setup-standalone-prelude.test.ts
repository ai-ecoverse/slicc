import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
} from '../../../src/cdp/extension-bridge-protocol.js';
import { ExtensionBridgeTransport } from '../../../src/cdp/extension-bridge-transport.js';
import type { BrowserAPI } from '../../../src/cdp/index.js';
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
});
