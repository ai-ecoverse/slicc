import { vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/index.js';
import type { CDPTransport } from '../../../src/cdp/transport.js';
import type { VirtualFS } from '../../../src/fs/index.js';
import type {
  PlaywrightHandlerCtx,
  PlaywrightState,
} from '../../../src/shell/supplemental-commands/playwright/types.js';

type EventListener = (params: Record<string, unknown>) => unknown;

/** Fresh, empty {@link PlaywrightState} for handler tests. */
export function createPlaywrightState(): PlaywrightState {
  return {
    snapshots: new Map(),
    appTabId: null,
    harRecorder: null,
    sessionDirsCreated: false,
    teleportWatchers: new Map(),
    consoleMessages: new Map(),
    consoleCleanup: new Map(),
    networkRequests: new Map(),
    networkRequestIndex: new Map(),
    networkCleanup: new Map(),
    routes: new Map(),
    routeCleanup: new Map(),
    lastMousePosition: new Map(),
  };
}

export interface MockTransport {
  transport: CDPTransport;
  send: ReturnType<typeof vi.fn>;
  /**
   * Fire a CDP event to every registered listener and await async handlers, so
   * a handler that issues follow-up `transport.send` calls has settled before
   * the returned promise resolves (no timer flushing needed).
   */
  emit: (event: string, params: Record<string, unknown>) => Promise<void>;
  /** True once a listener for `event` is registered. */
  hasListener: (event: string) => boolean;
}

/**
 * Build a mock {@link CDPTransport} whose `on`/`off` track listeners and whose
 * `send` is a spy. `emit` drives captured events into the registered handlers.
 */
export function createMockTransport(
  sendImpl?: (method: string, params?: Record<string, unknown>) => unknown
): MockTransport {
  const listeners = new Map<string, Set<EventListener>>();
  const send = vi.fn(
    async (method: string, params?: Record<string, unknown>) =>
      (sendImpl?.(method, params) as Record<string, unknown> | undefined) ?? {}
  );
  const transport = {
    send,
    on: (event: string, cb: EventListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    off: (event: string, cb: EventListener) => {
      listeners.get(event)?.delete(cb);
    },
  } as unknown as CDPTransport;
  return {
    transport,
    send,
    emit: async (event, params) => {
      await Promise.all([...(listeners.get(event) ?? [])].map((cb) => cb(params)));
    },
    hasListener: (event) => (listeners.get(event)?.size ?? 0) > 0,
  };
}

export interface MockBrowser {
  browser: BrowserAPI;
  transport: MockTransport;
  sendCDP: ReturnType<typeof vi.fn>;
}

/**
 * Build a mock {@link BrowserAPI}. `withTab` invokes its callback with
 * `sessionId`; `getTransport` returns the shared mock transport; `sendCDP`
 * is a spy backed by `sendCdpImpl`.
 */
export function createMockBrowser(opts?: {
  sessionId?: string;
  transport?: MockTransport;
  sendCdpImpl?: (method: string, params?: Record<string, unknown>) => unknown;
}): MockBrowser {
  const transport = opts?.transport ?? createMockTransport();
  const sessionId = opts?.sessionId ?? 'session-1';
  const sendCDP = vi.fn(
    async (method: string, params?: Record<string, unknown>) =>
      (opts?.sendCdpImpl?.(method, params) as Record<string, unknown> | undefined) ?? {}
  );
  const browser = {
    withTab: async <T>(_targetId: string, fn: (sessionId: string) => Promise<T>) => fn(sessionId),
    getTransport: () => transport.transport,
    sendCDP,
  } as unknown as BrowserAPI;
  return { browser, transport, sendCDP };
}

/** Assemble a {@link PlaywrightHandlerCtx} from the mock pieces. */
export function createHandlerCtx(opts?: {
  browser?: BrowserAPI;
  fs?: Partial<VirtualFS>;
  state?: PlaywrightState;
  positional?: string[];
  flags?: Record<string, string>;
  scratchDir?: string;
}): PlaywrightHandlerCtx {
  return {
    browser: opts?.browser ?? createMockBrowser().browser,
    fs: (opts?.fs ?? {}) as VirtualFS,
    state: opts?.state ?? createPlaywrightState(),
    positional: opts?.positional ?? [],
    flags: opts?.flags ?? {},
    // Defaults to the shared root so existing cases keep asserting the paths
    // they always did; the per-unit behaviour is covered explicitly.
    scratchDir: opts?.scratchDir ?? '/tmp',
  };
}

/**
 * Count `EF BF BD` (UTF-8 U+FFFD) sequences in a byte string — the signature a
 * text round-trip leaves on binary file content (#2878 / #2883).
 */
export function countReplacementSeqs(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) {
      n++;
      i += 2;
    }
  }
  return n;
}

/**
 * A `VirtualFS.readFile` whose default encoding is UTF-8 *with replacement*,
 * exactly like production. A caller that forgets `{ encoding: 'binary' }` sees
 * U+FFFD for every high byte, so a handler that regresses fails the test.
 */
export function vfsLikeReadFile(files: Map<string, string | Uint8Array>): VirtualFS['readFile'] {
  return (async (path: string, options?: { encoding?: string }) => {
    const stored = files.get(path);
    if (stored === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' as const });
    }
    const encoding = options?.encoding ?? 'utf-8';
    if (stored instanceof Uint8Array) {
      if (encoding === 'binary') return stored;
      return new TextDecoder('utf-8').decode(stored);
    }
    if (encoding === 'binary') return new TextEncoder().encode(stored);
    return stored;
  }) as VirtualFS['readFile'];
}

/** Every byte 0x00..0xFF exactly once — the #2883 / #2878 corruption probe. */
export function allBytesFixture(): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, i) => i);
}
