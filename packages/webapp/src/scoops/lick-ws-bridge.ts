/**
 * `/licks-ws` bridge — connects the kernel-host (standalone mode only)
 * to the node-server's lick WebSocket.
 *
 * Wire surface (matches `packages/node-server/src/index.ts`
 * `sendLickRequest` / `broadcastLickEvent`):
 *
 *   - Request/response (each carries a `requestId`):
 *     `list_webhooks`, `create_webhook`, `delete_webhook`,
 *     `list_crontasks`, `create_crontask`, `delete_crontask`,
 *     `tray_status`. Reply envelope: `{ type: 'response',
 *     requestId, data?, error? }`.
 *   - Push events (no `requestId`, no reply): `webhook_event` →
 *     `LickManager.handleWebhookEvent`; `navigate_event` →
 *     `lickManager.emitEvent({ type: 'navigate', ... })`.
 *
 * Standalone-only: the extension offscreen kernel-host gates this out
 * because there is no node-server in extension mode (webhooks land at
 * the cloudflare tray worker instead, and the extension shell command
 * talks to `LickManager` through a BroadcastChannel proxy — see
 * `packages/chrome-extension/src/lick-manager-proxy.ts`).
 *
 * Reconnect policy: exponential backoff capped at 60s, escalating log
 * level after a few attempts, and an unrecoverable signal emitted to
 * the cone after sustained failure so the user sees that lick delivery
 * is down rather than wondering why their webhook never fires.
 */
import { createLogger } from '../core/logger.js';
import { getLickWebSocketUrl, getTrayWebhookUrl, getWebhookUrl } from '../ui/runtime-mode.js';
import type { LickManager } from './lick-manager.js';
import { getLeaderStatusWithFallback, getLeaderTrayRuntimeStatus } from './tray-leader.js';

const log = createLogger('lick-ws-bridge');

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60_000;
/** Number of consecutive failures before warns escalate to errors. */
const RECONNECT_LOG_ESCALATE_AT = 3;
/** Number of consecutive failures before we emit an unrecoverable cone signal. */
const RECONNECT_GIVEUP_AT = 20;

/**
 * Minimal WebSocket-shaped object the bridge uses. Narrower than the
 * full DOM `WebSocket` so the test factory can stub it directly with a
 * plain class. The DOM `WebSocket` satisfies this shape structurally
 * (the bridge uses no constructor-only members and only ever assigns
 * `null`/callback to the `on*` slots).
 */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
}

// Mirror of the DOM `WebSocket.readyState` enum so the bridge doesn't
// depend on the global at evaluation time (the worker entry might be
// transformed before `WebSocket` is defined).
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface LickWsBridgeOptions {
  /**
   * Origin-bearing URL used to construct the WS endpoint and the
   * fallback webhook URL. Validated eagerly via `new URL(...)`; bad
   * input throws synchronously from `startLickWsBridge` rather than
   * silently looping the reconnect.
   */
  locationHref: string;
  /**
   * Absolute lick-WS URL override (e.g. `ws://localhost:5710/licks-ws`).
   * Set in thin-bridge mode where the hosted leader serves the UI but
   * the node-server (and its `/licks-ws`) lives on a different origin —
   * deriving the URL from `locationHref` would dial the UI origin
   * (e.g. wrangler on :8787), which cannot speak the lick wire. When
   * set, the bridge also derives the fallback webhook origin from this
   * URL instead of `locationHref` so `list_webhooks` URLs point at the
   * node-server's `/webhooks/<id>` endpoint. `null` / undefined falls
   * back to same-origin (the legacy bundled-UI assumption).
   */
  lickWsUrl?: string | null;
  /** Override the WebSocket constructor (tests). */
  webSocketFactory?: (url: string) => MinimalWebSocket;
  /** Override the base reconnect delay (tests). Defaults to 3000ms. */
  reconnectDelayMs?: number;
  /** Override the setTimeout used for reconnection (tests). */
  setTimeoutFn?: (cb: () => void, delay: number) => ReturnType<typeof setTimeout>;
  /** Override clearTimeout used for reconnection (tests). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface LickWsBridgeHandle {
  /** Idempotent — safe to call multiple times. */
  stop(): void;
}

interface RequestMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

interface ResponseEnvelope {
  type: 'response';
  requestId: string;
  data?: unknown;
  error?: string;
}

/**
 * Mutable per-bridge state. Lifted out of the `startLickWsBridge` closure so
 * the reconnect/message/request handlers can live as module-level helpers and
 * keep `startLickWsBridge` itself under the function-size cap. The shape and
 * semantics are identical to the original local `let` bindings.
 */
interface BridgeRuntime {
  lickManager: LickManager;
  options: LickWsBridgeOptions;
  wsUrl: string;
  /**
   * HTTP/HTTPS origin used to build the fallback webhook URL when no
   * tray session is active. Derived from `options.lickWsUrl` when that
   * override is supplied (ws→http, wss→https), so thin-bridge mode
   * points webhooks at the node-server origin rather than the hosted
   * UI origin. `null` when no override was supplied — the fallback
   * keeps using `options.locationHref` for backwards compatibility.
   */
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
    // `CloseEvent.code` (per RFC 6455) and `CloseEvent.reason` are
    // the diagnostic gold; `onerror` doesn't see them.
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

/**
 * The session-reload signal is emitted exactly once per failure streak;
 * `consecutiveFailures === RECONNECT_GIVEUP_AT` (not `>=`) ensures we don't
 * re-emit on every subsequent failure. A successful `onopen` resets both
 * counters so a fresh streak can re-arm the signal.
 */
function onBridgeFailure(rt: BridgeRuntime, cause: string): void {
  // If a reconnect is already queued, a fresh failure event (e.g.
  // `onclose` racing with `onerror`) shouldn't increment the counter
  // — the in-flight timer keeps the previously-computed delay, so
  // incrementing here would print a backoff delay in logs that
  // doesn't match the actual timer.
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
    // The await above can hand control to a close/reconnect that
    // invalidates `ws`. Don't send into a dead or replaced socket —
    // the node-server's request hangs to timeout if we do.
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
  }
}

function dispatchWebhookEvent(lickManager: LickManager, data: RequestMessage): void {
  const webhookId = typeof data.webhookId === 'string' ? data.webhookId : null;
  if (!webhookId) {
    log.error('Malformed webhook_event from lick-ws', {
      receivedKeys: Object.keys(data),
    });
    return;
  }
  const headers =
    data.headers && typeof data.headers === 'object'
      ? (data.headers as Record<string, string>)
      : {};
  try {
    lickManager.handleWebhookEvent(webhookId, headers, data.body);
  } catch (err) {
    // Filter compile errors, IndexedDB write errors, scoop-dispatch
    // failures all manifest here. Surface them with the diagnostic
    // context that lets the user figure out which webhook lost an
    // event.
    log.error('Webhook event dispatch failed', {
      webhookId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function dispatchNavigateEvent(lickManager: LickManager, data: RequestMessage): void {
  // Payload mirrors `packages/node-server/src/index.ts` POST
  // /api/handoff — `{ verb, target, instruction?, url, title?,
  // branch?, path? }` (RFC 8288 Link shape). The older `sliccHeader`
  // envelope is no longer emitted.
  const verb = typeof data.verb === 'string' ? data.verb : null;
  const target = typeof data.target === 'string' ? data.target : null;
  const navUrl = typeof data.url === 'string' && data.url.length > 0 ? data.url : null;
  if ((verb !== 'handoff' && verb !== 'upskill') || !target || !navUrl) {
    log.debug('navigate_event dropped — invalid payload', {
      hasVerb: !!verb,
      hasTarget: !!target,
      hasUrl: !!navUrl,
    });
    return;
  }
  const body: Record<string, unknown> = { url: navUrl, verb, target };
  if (typeof data.instruction === 'string') body.instruction = data.instruction;
  if (typeof data.branch === 'string') body.branch = data.branch;
  if (typeof data.path === 'string') body.path = data.path;
  if (typeof data.title === 'string') body.title = data.title;
  lickManager.emitEvent({
    type: 'navigate',
    navigateUrl: navUrl,
    targetScoop: undefined,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
    body,
  });
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
        // In standalone mode the kernel worker hosts this bridge, but
        // the leader tray itself runs on the page — the worker's own
        // module global stays `inactive`. Use the shared shim-aware
        // fallback so `/api/tray-status` (which feeds Sliccstart's row
        // gating + Electron auto-attach) sees the live leader state.
        // Mirrors `host`'s `getLeaderStatusWithFallback` behavior.
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
  // Thin-bridge: dial the node-server origin we learned from the bridge
  // launch params, not the UI origin (which is the hosted leader in
  // thin-bridge mode and has no `/webhooks/*` route). Falls through to
  // the same-origin assumption when no override was supplied.
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
      // Closing an already-closed socket is benign; anything else
      // is noteworthy (CONNECTING/OPEN sockets shouldn't reject
      // `close()`).
      if (s.readyState !== WS_CLOSED && s.readyState !== WS_CLOSING) {
        log.warn('Lick socket close() threw before terminal state', {
          readyState: s.readyState,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Open the bridge and start handling messages. The returned handle's
 * `stop()` cancels any pending reconnect and closes the active socket.
 */
export function startLickWsBridge(
  lickManager: LickManager,
  options: LickWsBridgeOptions
): LickWsBridgeHandle {
  // Fail fast on a malformed `locationHref` rather than letting a bad
  // URL silently loop the reconnect path forever. `void` signals that
  // the constructed URL is discarded — we only want the parse-failure
  // throw.
  try {
    void new URL(options.locationHref);
  } catch (err) {
    throw new Error(
      `startLickWsBridge: invalid locationHref ${JSON.stringify(options.locationHref)}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Prefer the explicit override (thin-bridge) over the
  // locationHref-derived URL. Without this the worker dials the hosted
  // UI origin (e.g. `ws://localhost:8787/licks-ws`) where wrangler
  // cannot speak the lick wire and the upgrade handshake returns 200.
  const wsUrl =
    typeof options.lickWsUrl === 'string' && options.lickWsUrl.length > 0
      ? options.lickWsUrl
      : getLickWebSocketUrl(options.locationHref);
  // Derive the webhook-fallback origin from the override URL when
  // present (ws→http, wss→https). `URL` parse failures degrade to
  // `null` rather than throw — the existing `locationHref`-based
  // fallback then takes over.
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

  // DOM `WebSocket` satisfies `MinimalWebSocket` structurally — no
  // cast needed. `setTimeout` / `clearTimeout` MUST be bound to
  // `globalThis` when used as the default — passing the bare global as
  // `setTimer` then invoking it through `rt.setTimer(...)` calls it as
  // a method on `rt`, which throws "Illegal invocation" in browsers
  // (the timer functions are internal-slot methods on `window` /
  // `WorkerGlobalScope`). Tests can still inject plain functions via
  // `setTimeoutFn` / `clearTimeoutFn`.
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
