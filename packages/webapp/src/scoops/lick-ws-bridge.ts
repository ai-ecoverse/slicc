import { getLickWebSocketUrl, getTrayWebhookUrl, getWebhookUrl } from '../base/lick-urls.js';
import { createLogger } from '../core/logger.js';
import type { LickEvent, LickManager, WebhookDeliveryDisposition } from './lick-manager.js';
import { getLeaderStatusWithFallback, getLeaderTrayRuntimeStatus } from './tray-leader.js';

const log = createLogger('lick-ws-bridge');

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60_000;

const RECONNECT_LOG_ESCALATE_AT = 3;

const RECONNECT_GIVEUP_AT = 20;

export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
}

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface LickWsBridgeOptions {
  locationHref: string;

  lickWsUrl?: string | null;

  onHostfsInvalidate?: (event: HostfsInvalidateEvent) => void;

  webSocketFactory?: (url: string) => MinimalWebSocket;

  reconnectDelayMs?: number;

  setTimeoutFn?: (cb: () => void, delay: number) => ReturnType<typeof setTimeout>;

  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface HostfsInvalidateEvent {
  type: 'hostfs_invalidate';

  mount: string;

  paths: string[];
  timestamp?: string;
}

export interface LickWsBridgeHandle {
  stop(): void;
}

interface RequestMessage {
  type: string;
  requestId?: string;
  webhookId?: unknown;
  headers?: unknown;
  body?: unknown;
  verb?: unknown;
  target?: unknown;
  url?: unknown;
  instruction?: unknown;
  branch?: unknown;
  path?: unknown;
  paths?: unknown;
  mount?: unknown;
  title?: unknown;
  timestamp?: unknown;
  name?: unknown;
  scoop?: unknown;
  filter?: unknown;
  id?: unknown;
  cron?: unknown;
}

interface NavigateLickBody {
  url: string;
  verb: 'handoff' | 'upskill';
  target: string;
  instruction?: string;
  branch?: string;
  path?: string;
  title?: string;
}

interface NavigationPayload {
  verb?: unknown;
  target?: unknown;
  url?: unknown;
  instruction?: unknown;
  branch?: unknown;
  path?: unknown;
  title?: unknown;
  timestamp?: unknown;
}

interface DiscoveryPayload {
  discoveryOrigin?: unknown;
  discoveryKind?: unknown;
  discoveryUrl?: unknown;
  url?: unknown;
  timestamp?: unknown;
}

interface ResponseEnvelope {
  type: 'response';
  requestId: string;
  data?: unknown;
  error?: string;
}

interface BridgeRuntime {
  lickManager: LickManager;
  options: LickWsBridgeOptions;
  wsUrl: string;

  webhookOriginOverride: string | null;
  baseDelay: number;
  wsFactory: (url: string) => MinimalWebSocket;
  setTimer: (cb: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  stopped: boolean;
  socket: MinimalWebSocket | null;
  reconnectHandle: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  unrecoverableSignalled: boolean;
}

function connectBridge(rt: BridgeRuntime): void {
  if (rt.stopped) return;
  let ws: MinimalWebSocket;
  try {
    ws = rt.wsFactory(rt.wsUrl);
  } catch (err) {
    log.error('Failed to construct lick WebSocket', {
      url: rt.wsUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    onBridgeFailure(rt, 'construct-threw');
    return;
  }
  rt.socket = ws;

  ws.onopen = () => {
    if (rt.consecutiveFailures > 0) {
      log.info('Lick WebSocket recovered', { attempts: rt.consecutiveFailures });
    } else {
      log.info('Lick WebSocket connected');
    }
    rt.consecutiveFailures = 0;
    rt.unrecoverableSignalled = false;
  };

  ws.onmessage = (event: MessageEvent) => {
    void processLickMessage(rt, ws, event.data).catch((err) => {
      const preview =
        typeof event.data === 'string' ? event.data.slice(0, 200) : '[non-string payload]';
      log.error('Failed to process lick message', {
        error: err instanceof Error ? err.message : String(err),
        preview,
      });
    });
  };

  ws.onclose = (event: CloseEvent) => {
    if (rt.socket === ws) rt.socket = null;
    if (rt.stopped) return;

    const reasonSegment = event.reason ? ` reason=${JSON.stringify(event.reason)}` : '';
    onBridgeFailure(rt, `disconnected code=${event.code}${reasonSegment}`);
  };

  ws.onerror = (event: Event) => {
    const target = event.target as MinimalWebSocket | null;
    log.error('Lick WebSocket error', {
      url: rt.wsUrl,
      readyState: target?.readyState,
      eventType: event.type,
    });
  };
}

function onBridgeFailure(rt: BridgeRuntime, cause: string): void {
  if (rt.reconnectHandle != null) {
    log.debug('Lick WS failure during pending reconnect — keeping existing timer', { cause });
    return;
  }
  rt.consecutiveFailures++;
  const delay = Math.min(rt.baseDelay * 2 ** (rt.consecutiveFailures - 1), MAX_RECONNECT_DELAY_MS);
  const fields = { url: rt.wsUrl, attempt: rt.consecutiveFailures, cause, retryInMs: delay };
  if (rt.consecutiveFailures >= RECONNECT_LOG_ESCALATE_AT) {
    log.error('Lick WebSocket still down', fields);
  } else {
    log.warn('Lick WebSocket down', fields);
  }
  if (rt.consecutiveFailures === RECONNECT_GIVEUP_AT && !rt.unrecoverableSignalled) {
    rt.unrecoverableSignalled = true;
    try {
      rt.lickManager.emitEvent({
        type: 'session-reload',
        targetScoop: undefined,
        timestamp: new Date().toISOString(),
        body: {
          reason: 'lick-ws-bridge-down',
          url: rt.wsUrl,
          attempts: rt.consecutiveFailures,
        },
      });
    } catch (err) {
      log.error('Failed to emit lick-ws-bridge-down signal', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  scheduleBridgeReconnect(rt, delay);
}

function scheduleBridgeReconnect(rt: BridgeRuntime, delay: number): void {
  if (rt.stopped || rt.reconnectHandle != null) return;
  rt.reconnectHandle = rt.setTimer(() => {
    rt.reconnectHandle = null;
    connectBridge(rt);
  }, delay);
}

async function processLickMessage(
  rt: BridgeRuntime,
  ws: MinimalWebSocket,
  raw: unknown
): Promise<void> {
  const text = typeof raw === 'string' ? raw : String(raw);
  const data = JSON.parse(text) as RequestMessage;

  if (data.requestId) {
    const requestId = data.requestId;
    const reply = await handleLickRequest(rt, data, requestId);

    if (rt.stopped || rt.socket !== ws || ws.readyState !== WS_OPEN) {
      log.warn('Lick reply dropped — socket changed/closed mid-request', {
        type: data.type,
        requestId,
      });
      return;
    }
    try {
      ws.send(JSON.stringify(reply));
    } catch (err) {
      log.error('ws.send() failed delivering lick reply', {
        type: data.type,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (data.type === 'webhook_event') {
    dispatchWebhookEvent(rt.lickManager, data);
    return;
  }

  if (data.type === 'navigate_event') {
    dispatchNavigateEvent(rt.lickManager, data);
    return;
  }

  if (data.type === 'hostfs_invalidate') {
    dispatchHostfsInvalidate(rt, data);
  }
}

function dispatchWebhookEvent(
  lickManager: LickManager,
  data: RequestMessage
): WebhookDeliveryDisposition | 'malformed' | 'failed' {
  const webhookId = typeof data.webhookId === 'string' ? data.webhookId : null;
  if (!webhookId) {
    log.error('Malformed webhook_event from lick-ws', {
      receivedKeys: Object.keys(data),
    });
    return 'malformed';
  }
  const headers =
    data.headers && typeof data.headers === 'object'
      ? (data.headers as Record<string, string>)
      : {};
  try {
    return lickManager.handleWebhookEvent(webhookId, headers, data.body);
  } catch (err) {
    log.error('Webhook event dispatch failed', {
      webhookId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

export function mapNavigatePayloadToLickEvent(data: NavigationPayload): LickEvent | null {
  const verb = typeof data.verb === 'string' ? data.verb : null;
  const target = typeof data.target === 'string' ? data.target : null;
  const navUrl = typeof data.url === 'string' && data.url.length > 0 ? data.url : null;
  if ((verb !== 'handoff' && verb !== 'upskill') || !target || !navUrl) {
    return null;
  }
  const body: NavigateLickBody = { url: navUrl, verb, target };
  if (typeof data.instruction === 'string') body.instruction = data.instruction;
  if (typeof data.branch === 'string') body.branch = data.branch;
  if (typeof data.path === 'string') body.path = data.path;
  if (typeof data.title === 'string') body.title = data.title;
  return {
    type: 'navigate',
    navigateUrl: navUrl,
    targetScoop: undefined,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
    body,
  };
}

export function mapDiscoveryPayloadToLickEvent(data: DiscoveryPayload): LickEvent | null {
  const origin = typeof data.discoveryOrigin === 'string' ? data.discoveryOrigin : null;
  const kind =
    data.discoveryKind === 'ai-catalog' || data.discoveryKind === 'llms-txt'
      ? data.discoveryKind
      : null;
  const url =
    typeof data.discoveryUrl === 'string' && data.discoveryUrl.length > 0
      ? data.discoveryUrl
      : null;
  if (!origin || !kind || !url) return null;
  const pageUrl = typeof data.url === 'string' ? data.url : undefined;
  return {
    type: 'discovery',
    discoveryOrigin: origin,
    discoveryKind: kind,
    discoveryUrl: url,
    discoverySource: 'live-navigation',
    targetScoop: undefined,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
    body: { origin, kind, url, ...(pageUrl ? { pageUrl } : {}) },
  };
}

function dispatchNavigateEvent(lickManager: LickManager, data: RequestMessage): void {
  const event = mapNavigatePayloadToLickEvent(data);
  if (!event) {
    log.debug('navigate_event dropped — invalid payload', {
      hasVerb: typeof data.verb === 'string',
      hasTarget: typeof data.target === 'string',
      hasUrl: typeof data.url === 'string' && data.url.length > 0,
    });
    return;
  }
  lickManager.emitEvent(event);
}

export function parseHostfsInvalidateEvent(data: RequestMessage): HostfsInvalidateEvent | null {
  if (typeof data.mount !== 'string' || data.mount.length === 0) return null;
  const rawPaths = data.paths;
  const paths: string[] = [];
  if (Array.isArray(rawPaths)) {
    for (const p of rawPaths) {
      if (typeof p === 'string') paths.push(p);
    }
  }
  return {
    type: 'hostfs_invalidate',
    mount: data.mount,
    paths,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : undefined,
  };
}

function dispatchHostfsInvalidate(rt: BridgeRuntime, data: RequestMessage): void {
  const event = parseHostfsInvalidateEvent(data);
  if (!event) {
    log.debug('hostfs_invalidate dropped — invalid payload', {
      hasMount: typeof data.mount === 'string' && data.mount.length > 0,
      pathsIsArray: Array.isArray(data.paths),
    });
    return;
  }
  try {
    rt.options.onHostfsInvalidate?.(event);
  } catch (err) {
    log.warn('hostfs_invalidate handler threw', {
      mount: event.mount,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleLickRequest(
  rt: BridgeRuntime,
  data: RequestMessage,
  requestId: string
): Promise<ResponseEnvelope> {
  const { lickManager } = rt;
  try {
    switch (data.type) {
      case 'list_webhooks': {
        const entries = lickManager.listWebhooks();
        return {
          type: 'response',
          requestId,
          data: entries.map((wh) => ({ ...wh, url: resolveLickWebhookUrl(rt, wh.id) })),
        };
      }
      case 'create_webhook': {
        const wh = await lickManager.createWebhook(
          (data.name as string) || 'default',
          data.scoop as string | undefined,
          data.filter as string | undefined
        );
        return {
          type: 'response',
          requestId,
          data: { ...wh, url: resolveLickWebhookUrl(rt, wh.id) },
        };
      }
      case 'webhook_event': {
        return {
          type: 'response',
          requestId,
          data: { disposition: dispatchWebhookEvent(lickManager, data) },
        };
      }
      case 'delete_webhook': {
        const ok = await lickManager.deleteWebhook(data.id as string);
        return ok
          ? { type: 'response', requestId, data: { ok: true } }
          : { type: 'response', requestId, data: { error: 'Webhook not found' } };
      }
      case 'list_crontasks':
        return {
          type: 'response',
          requestId,
          data: lickManager.listCronTasks(),
        };
      case 'create_crontask': {
        if (!data.name) throw new Error('name is required');
        if (!data.cron) throw new Error('cron is required');
        const ct = await lickManager.createCronTask(
          data.name as string,
          data.cron as string,
          data.scoop as string | undefined,
          data.filter as string | undefined
        );
        return { type: 'response', requestId, data: ct };
      }
      case 'delete_crontask': {
        const ok = await lickManager.deleteCronTask(data.id as string);
        return ok
          ? { type: 'response', requestId, data: { ok: true } }
          : { type: 'response', requestId, data: { error: 'Cron task not found' } };
      }
      case 'tray_status': {
        const leaderStatus = getLeaderStatusWithFallback();
        return {
          type: 'response',
          requestId,
          data: {
            state: leaderStatus.state,
            joinUrl: leaderStatus.session?.joinUrl ?? null,
            workerBaseUrl: leaderStatus.session?.workerBaseUrl ?? null,
            trayId: leaderStatus.session?.trayId ?? null,
          },
        };
      }
      default:
        return {
          type: 'response',
          requestId,
          error: `Unknown request type: ${data.type}`,
        };
    }
  } catch (err) {
    return {
      type: 'response',
      requestId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveLickWebhookUrl(rt: BridgeRuntime, webhookId: string): string {
  const traySession = getLeaderTrayRuntimeStatus().session;
  if (traySession?.webhookUrl) {
    return getTrayWebhookUrl(traySession.webhookUrl, webhookId);
  }

  if (rt.webhookOriginOverride) {
    return `${rt.webhookOriginOverride}/webhooks/${webhookId}`;
  }
  return getWebhookUrl(rt.options.locationHref, webhookId);
}

function stopBridge(rt: BridgeRuntime): void {
  if (rt.stopped) return;
  rt.stopped = true;
  if (rt.reconnectHandle != null) {
    rt.clearTimer(rt.reconnectHandle);
    rt.reconnectHandle = null;
  }
  const s = rt.socket;
  rt.socket = null;
  if (s) {
    try {
      s.close();
    } catch (err) {
      if (s.readyState !== WS_CLOSED && s.readyState !== WS_CLOSING) {
        log.warn('Lick socket close() threw before terminal state', {
          readyState: s.readyState,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function startLickWsBridge(
  lickManager: LickManager,
  options: LickWsBridgeOptions
): LickWsBridgeHandle {
  try {
    void new URL(options.locationHref);
  } catch (err) {
    throw new Error(
      `startLickWsBridge: invalid locationHref ${JSON.stringify(options.locationHref)}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const wsUrl =
    typeof options.lickWsUrl === 'string' && options.lickWsUrl.length > 0
      ? options.lickWsUrl
      : getLickWebSocketUrl(options.locationHref);

  let webhookOriginOverride: string | null = null;
  if (typeof options.lickWsUrl === 'string' && options.lickWsUrl.length > 0) {
    try {
      const u = new URL(options.lickWsUrl);
      const httpScheme = u.protocol === 'wss:' ? 'https:' : 'http:';
      webhookOriginOverride = `${httpScheme}//${u.host}`;
    } catch {
      webhookOriginOverride = null;
    }
  }

  const rt: BridgeRuntime = {
    lickManager,
    options,
    wsUrl,
    webhookOriginOverride,
    baseDelay: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    wsFactory: options.webSocketFactory ?? ((url) => new WebSocket(url)),
    setTimer: options.setTimeoutFn ?? setTimeout.bind(globalThis),
    clearTimer: options.clearTimeoutFn ?? clearTimeout.bind(globalThis),
    stopped: false,
    socket: null,
    reconnectHandle: null,
    consecutiveFailures: 0,
    unrecoverableSignalled: false,
  };

  connectBridge(rt);

  return {
    stop(): void {
      stopBridge(rt);
    },
  };
}
