/**
 * `/licks-ws` bridge — connects the kernel-host (standalone mode only)
 * to the node-server's lick WebSocket so the existing `/api/webhooks`,
 * `/api/crontasks`, `/api/tray-status`, and inbound webhook/handoff
 * delivery paths work.
 *
 * Standalone-only: the extension offscreen kernel-host gates this out
 * because there is no node-server in extension mode (webhooks land at
 * the cloudflare tray worker instead, and the extension shell command
 * talks to `LickManager` through a BroadcastChannel proxy — see
 * `packages/chrome-extension/src/lick-manager-proxy.ts`).
 *
 * This module is the kernel-side replacement for the legacy page-side
 * handler that lived in `ui/main.ts` before commit 07cdce16 removed
 * the inline-orchestrator standalone path. The wire shape is preserved
 * verbatim — same request types, same response envelope — so
 * `packages/node-server/src/index.ts` needs no changes.
 *
 * Wire shape (from node-server `sendLickRequest` / `broadcastLickEvent`):
 *
 *   inbound  → `{ type, requestId?, ...payload }`
 *   outbound → `{ type: 'response', requestId, data?, error? }`
 *
 * Reconnect: on `onclose`, schedule a reconnect after `reconnectDelayMs`
 * unless `stop()` was called. The reconnect timer is the only piece of
 * mutable state that survives `connect()` calls.
 */

import { createLogger } from '../core/logger.js';
import type { LickManager } from './lick-manager.js';
import { getLickWebSocketUrl, getTrayWebhookUrl, getWebhookUrl } from '../ui/runtime-mode.js';
import { getLeaderTrayRuntimeStatus } from './tray-leader.js';

const log = createLogger('lick-ws-bridge');

const DEFAULT_RECONNECT_DELAY_MS = 3000;

export interface LickWsBridgeOptions {
  /** Origin-bearing URL used to construct ws URLs and webhook URLs. */
  locationHref: string;
  /** Override the WebSocket constructor (tests). */
  webSocketFactory?: (url: string) => WebSocket;
  /** Override the reconnect delay (tests). Defaults to 3000ms. */
  reconnectDelayMs?: number;
  /** Override the setTimeout used for reconnection (tests). */
  setTimeoutFn?: (cb: () => void, delay: number) => ReturnType<typeof setTimeout>;
  /** Override clearTimeout used for reconnection (tests). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface LickWsBridgeHandle {
  /** Tear down the bridge: close the socket and cancel any pending reconnect. */
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
 * Open the bridge and start handling messages. The returned handle's
 * `stop()` cancels any pending reconnect and closes the active socket.
 */
export function startLickWsBridge(
  lickManager: LickManager,
  options: LickWsBridgeOptions
): LickWsBridgeHandle {
  const wsFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  const reconnectDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;

  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectHandle: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;
    const wsUrl = getLickWebSocketUrl(options.locationHref);
    let ws: WebSocket;
    try {
      ws = wsFactory(wsUrl);
    } catch (err) {
      log.error('Failed to construct lick WebSocket', {
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      log.info('Lick WebSocket connected');
    };

    ws.onmessage = (event: MessageEvent) => {
      void handleMessage(ws, event.data).catch((err) => {
        log.error('Failed to process lick message', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    ws.onclose = () => {
      socket = null;
      if (stopped) return;
      log.warn(`Lick WebSocket disconnected, reconnecting in ${reconnectDelay}ms`);
      scheduleReconnect();
    };

    ws.onerror = (err: Event) => {
      log.error('Lick WebSocket error', { error: String(err) });
    };
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectHandle != null) return;
    reconnectHandle = setTimer(() => {
      reconnectHandle = null;
      connect();
    }, reconnectDelay);
  };

  const handleMessage = async (ws: WebSocket, raw: unknown): Promise<void> => {
    const text = typeof raw === 'string' ? raw : String(raw);
    const data = JSON.parse(text) as RequestMessage;

    if (data.requestId) {
      const reply = await handleRequest(data);
      ws.send(JSON.stringify(reply));
      return;
    }

    if (data.type === 'webhook_event') {
      lickManager.handleWebhookEvent(
        data.webhookId as string,
        (data.headers as Record<string, string>) ?? {},
        data.body
      );
      return;
    }

    if (data.type === 'navigate_event') {
      const sliccHeader = typeof data.sliccHeader === 'string' ? data.sliccHeader : '';
      const navUrl = typeof data.url === 'string' && data.url.length > 0 ? data.url : '';
      if (sliccHeader && navUrl) {
        lickManager.emitEvent({
          type: 'navigate',
          navigateUrl: navUrl,
          targetScoop: undefined,
          timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
          body: {
            url: navUrl,
            sliccHeader,
            title: typeof data.title === 'string' ? data.title : undefined,
          },
        });
      }
    }
  };

  const handleRequest = async (data: RequestMessage): Promise<ResponseEnvelope> => {
    const requestId = data.requestId!;
    try {
      switch (data.type) {
        case 'list_webhooks': {
          const entries = lickManager.listWebhooks();
          return {
            type: 'response',
            requestId,
            data: entries.map((wh) => ({ ...wh, url: resolveWebhookUrl(wh.id) })),
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
            data: { ...wh, url: resolveWebhookUrl(wh.id) },
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
          const leaderStatus = getLeaderTrayRuntimeStatus();
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
  };

  const resolveWebhookUrl = (webhookId: string): string => {
    const traySession = getLeaderTrayRuntimeStatus().session;
    return traySession?.webhookUrl
      ? getTrayWebhookUrl(traySession.webhookUrl, webhookId)
      : getWebhookUrl(options.locationHref, webhookId);
  };

  connect();

  return {
    stop(): void {
      stopped = true;
      if (reconnectHandle != null) {
        clearTimer(reconnectHandle);
        reconnectHandle = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignored — already closed
        }
        socket = null;
      }
    },
  };
}
