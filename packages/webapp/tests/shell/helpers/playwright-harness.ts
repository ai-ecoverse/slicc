import { vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/index.js';
import type { CDPTransport } from '../../../src/cdp/transport.js';
import type { VirtualFS } from '../../../src/fs/index.js';
import type {
  PlaywrightHandlerCtx,
  PlaywrightState,
} from '../../../src/shell/supplemental-commands/playwright/types.js';

type EventListener = (params: Record<string, unknown>) => unknown;

export function createPlaywrightState(): PlaywrightState {
  return {
    snapshots: new Map(),
    appTabId: null,
    harRecorder: null,
    sessionDirsCreated: new Set(),
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

  emit: (event: string, params: Record<string, unknown>) => Promise<void>;

  hasListener: (event: string) => boolean;

  listenerCount: (event: string) => number;

  clearListeners: () => void;
}

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
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    clearListeners: () => listeners.clear(),
  };
}

export type SessionReplacedFn = (
  sessionId: string,
  transport: CDPTransport,
  targetId: string
) => void;

export function withSessionReplaced(browser: BrowserAPI): SessionReplacedFn {
  type Cb = Parameters<BrowserAPI['onSessionReplaced']>[1];
  const subs = new Set<Cb>();
  Object.assign(browser, {
    onSessionReplaced: (_targetId: string, cb: Cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  });
  return (sessionId, transport, targetId) => {
    for (const cb of [...subs]) cb(sessionId, transport, targetId);
  };
}

export interface MockBrowser {
  browser: BrowserAPI;
  transport: MockTransport;

  sendCDP: ReturnType<typeof vi.fn>;

  page: MockTabPage;
}

export interface MockTabPage {
  targetId: string;
  sessionId: string;
  transport: CDPTransport;
  send: ReturnType<typeof vi.fn>;
}

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
  const page: MockTabPage = {
    targetId: 'tab-1',
    sessionId,
    transport: transport.transport,
    send: sendCDP,
  };
  const browser = {
    withTab: async <T>(targetId: string, fn: (tab: MockTabPage) => Promise<T>) => {
      page.targetId = targetId;
      return fn(page);
    },
    getTransport: () => transport.transport,
  } as unknown as BrowserAPI;
  return { browser, transport, sendCDP, page };
}

export function createHandlerCtx(opts?: {
  browser?: BrowserAPI;
  fs?: Partial<VirtualFS>;
  state?: PlaywrightState;
  positional?: string[];
  flags?: Record<string, string>;
  scratchDir?: string;
  sessionRoot?: string;
  signal?: AbortSignal;
}): PlaywrightHandlerCtx {
  const browser = opts?.browser ?? createMockBrowser().browser;
  return {
    browser,
    fs: (opts?.fs ?? {}) as VirtualFS,
    state: opts?.state ?? createPlaywrightState(),
    positional: opts?.positional ?? [],
    flags: opts?.flags ?? {},

    scratchDir: opts?.scratchDir ?? '/tmp',
    sessionRoot: opts?.sessionRoot ?? '/.playwright',

    onTab: (targetId, fn) => browser.withTab(targetId, fn, { signal: opts?.signal }),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  };
}

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

export function allBytesFixture(): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, i) => i);
}
