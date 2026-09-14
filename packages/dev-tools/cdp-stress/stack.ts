import { MessageChannel } from 'node:worker_threads';
import type { CDPPayload } from '@slicc/shared-ts';
import type { BrowserAPI } from '../../webapp/src/cdp/browser-api.js';
import type { CDPClient } from '../../webapp/src/cdp/cdp-client.js';
import type { CDPTransport } from '../../webapp/src/cdp/transport.js';
import type { WorkerCdpProxy } from '../../webapp/src/kernel/cdp-worker-proxy.js';
import type { MessagePortLike } from '../../webapp/src/kernel/transport-message-channel.js';

interface DevGlobal {
  __DEV__?: boolean;
  MessageChannel?: unknown;
}
const devGlobal = globalThis as DevGlobal;
devGlobal.__DEV__ ??= false;
devGlobal.MessageChannel ??= MessageChannel;

interface RawMessageSink {
  handleMessage(raw: string): void;
}

const CONNECT_TIMEOUT_MS = 10_000;

export async function loadSlicc() {
  const [browserApi, cdpClient, workerProxy, pageForwarder, logger, navigationWatcher] =
    await Promise.all([
      import('../../webapp/src/cdp/browser-api.js'),
      import('../../webapp/src/cdp/cdp-client.js'),
      import('../../webapp/src/kernel/cdp-worker-proxy.js'),
      import('../../webapp/src/kernel/cdp-page-forwarder.js'),
      import('../../webapp/src/base/logger.js'),
      import('../../webapp/src/cdp/navigation-watcher.js'),
    ]);
  logger.setLogLevel(logger.LogLevel.ERROR);
  return {
    BrowserAPI: browserApi.BrowserAPI,
    CDPClient: cdpClient.CDPClient,
    WorkerCdpProxy: workerProxy.WorkerCdpProxy,
    startPageCdpForwarder: pageForwarder.startPageCdpForwarder,
    NavigationWatcher: navigationWatcher.NavigationWatcher,
    createOwnTabMatcher: navigationWatcher.createOwnTabMatcher,
  };
}

export interface StackCounters {
  sends: number;
  byMethod: Map<string, number>;
  eventsIn: number;
  eventsByMethod: Map<string, number>;
  eventTimes: number[];
}

export interface Stack {
  browser: BrowserAPI;
  pageClient: CDPClient;

  transport: CDPTransport;

  reconnectPage: () => Promise<void>;

  counters: StackCounters;

  maxBurst: (windowMs: number) => number;

  sessions: string[];
  stop: () => void;
}

export interface StackOptions {
  direct?: boolean;
  navigationWatcher?: boolean;

  ownTabUrl?: string;

  onNavigation?: (event: unknown) => void;
}

export function harnessCdpTimeoutMs(): number | undefined {
  return Number(process.env['HARNESS_CDP_TIMEOUT_MS']) || undefined;
}

export async function buildStack(cdpUrl: string, opts: StackOptions = {}): Promise<Stack> {
  const slicc = await loadSlicc();
  const pageClient = new slicc.CDPClient();
  await pageClient.connect({ url: cdpUrl, timeout: CONNECT_TIMEOUT_MS });

  let transport: CDPTransport = pageClient;
  let stop = () => pageClient.disconnect();
  if (!opts.direct) {
    const channel = new MessageChannel();

    const port1 = channel.port1 as unknown as MessagePortLike;
    const port2 = channel.port2 as unknown as MessagePortLike;

    const stopForwarder = slicc.startPageCdpForwarder(port1, pageClient, {
      reconnect: async () => {
        if (pageClient.state === 'disconnected') {
          await pageClient.connect({ url: cdpUrl, timeout: CONNECT_TIMEOUT_MS });
        }
      },
    });
    const proxy: WorkerCdpProxy = new slicc.WorkerCdpProxy(port2);
    await proxy.connect();
    transport = proxy;
    stop = () => {
      stopForwarder();
      proxy.disconnect();
      pageClient.disconnect();
      channel.port1.close();
      channel.port2.close();
    };
  }

  const counters: StackCounters = {
    sends: 0,
    byMethod: new Map(),
    eventsIn: 0,
    eventsByMethod: new Map(),
    eventTimes: [],
  };
  const origSend = transport.send.bind(transport);
  transport.send = (method: string, params?: CDPPayload, sessionId?: string, timeout?: number) => {
    counters.sends += 1;
    counters.byMethod.set(method, (counters.byMethod.get(method) ?? 0) + 1);
    return origSend(method, params, sessionId, timeout ?? harnessCdpTimeoutMs());
  };

  const sink = pageClient as unknown as RawMessageSink;
  const origHandle = sink.handleMessage.bind(sink);
  sink.handleMessage = (raw: string) => {
    if (raw.startsWith('{"method"')) {
      counters.eventsIn += 1;
      counters.eventTimes.push(Date.now());
      const method = raw.slice(11, raw.indexOf('"', 11));
      counters.eventsByMethod.set(method, (counters.eventsByMethod.get(method) ?? 0) + 1);
    }
    return origHandle(raw);
  };

  const browser = new slicc.BrowserAPI(transport);
  browser.primeConnectOptions({ url: cdpUrl });
  if (opts.navigationWatcher) {
    const ownTabUrl = opts.ownTabUrl;
    const onNavigation = opts.onNavigation;
    const watcher = new slicc.NavigationWatcher(
      transport,
      (event) => onNavigation?.(event),
      ownTabUrl ? { isOwnTab: slicc.createOwnTabMatcher(() => ownTabUrl) } : {}
    );
    await watcher.start();
    const prevStop = stop;
    stop = () => {
      void watcher.stop();
      prevStop();
    };
  }
  const sessions: string[] = [];
  browser.setSessionChangeCallback((sessionId: string) => {
    sessions.push(sessionId);
  });

  return {
    browser,
    pageClient,
    transport,
    counters,
    sessions,
    stop,
    maxBurst: (windowMs: number) => {
      const times = counters.eventTimes;
      let best = 0;
      let lo = 0;
      for (let hi = 0; hi < times.length; hi++) {
        while ((times[hi] as number) - (times[lo] as number) > windowMs) lo++;
        best = Math.max(best, hi - lo + 1);
      }
      return best;
    },
    reconnectPage: async () => {
      if (pageClient.state === 'disconnected') {
        await pageClient.connect({ url: cdpUrl, timeout: CONNECT_TIMEOUT_MS });
      }
    },
  };
}

const unhandledMessages: string[] = [];
process.on('unhandledRejection', (e) => {
  unhandledMessages.push(e instanceof Error ? e.message : String(e));
});

export function unhandled(): string[] {
  return [...unhandledMessages];
}

export function resetUnhandled(): void {
  unhandledMessages.length = 0;
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

export function summarize(xs: number[]): Summary {
  return {
    n: xs.length,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: Math.max(0, ...xs),
  };
}

export function errKind(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);

  if (e instanceof Error && e.name === 'CommandAbortedError') return 'aborted';
  if (m.includes('Session with given id not found')) return 'session-not-found';
  if (m.includes('No session with given id')) return 'session-not-found';
  if (m.includes('timed out') || m.includes('Timed out')) return 'timeout';
  if (m.includes('not connected')) return 'not-connected';
  if (m.includes('No target with given id')) return 'no-target';
  if (m.includes('Not attached')) return 'not-attached';
  if (m.includes('CDP connection closed') || m.includes('disconnected')) return 'connection-closed';
  return m.slice(0, 60);
}

export interface Timed<T> {
  ms: number;
  ok: boolean;
  value?: T;
  error?: string;
}

export async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = Date.now();
  try {
    return { ms: Date.now() - t0, ok: true, value: await fn() };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, error: errKind(e) };
  }
}

export function isMain(moduleUrl: string): boolean {
  return moduleUrl === `file://${process.argv[1]}`;
}
