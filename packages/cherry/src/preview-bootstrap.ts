/**
 * Preview-bridge bootstrap bundle for driveable preview feature.
 * Injected into bridged HTML to enable same-realm synthetic CDP execution.
 */

import {
  type CdpHostHandlerOptions,
  type CdpPayload,
  createCdpHostHandler,
} from './cdp-host-handlers.js';

interface PreviewBridgeOptions {
  ws: WebSocket;
  createWebSocket?: () => WebSocket;
  capabilities?: CdpHostHandlerOptions['capabilities'];
}
interface BridgeWindowApi {
  emit(name: string, detail?: unknown): void;
  on(name: string, callback: (detail: unknown) => void): void;
}

type PreviewWindow = Window & {
  slicc?: BridgeWindowApi;
  __slicc?: BridgeWindowApi;
};

interface CdpRequestEnvelope {
  t: 'cdp.req';
  id: number;
  method: string;
  params?: CdpPayload;
  sessionId?: string;
}

interface CdpResponseEnvelope {
  t: 'cdp.res';
  id: number;
  result?: CdpPayload;
  error?: { code: number; message: string };
}

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const TERMINAL_CLOSE_REASONS = new Set(['closed by leader', 'preview revoked']);

export interface PreviewBridge {
  handleFrame(frame: CdpRequestEnvelope): Promise<void>;
  installWindowApi(): void;
  start(): void;
  stop(): void;
}

interface SocketControllerOptions {
  ws: WebSocket;
  createWebSocket?: () => WebSocket;
  onFrame(frame: CdpRequestEnvelope): Promise<void>;
}

class PreviewSocketController {
  private ws: WebSocket;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private started = false;
  private stopped = false;
  private terminal = false;
  private suspended = false;
  private resumePending = false;
  private pingOnOpen = false;
  private readonly wiredSockets = new Set<WebSocket>();

  constructor(private readonly opts: SocketControllerOptions) {
    this.ws = opts.ws;
  }

  send(data: string): boolean {
    if (!this.socketIsOpen()) return false;
    try {
      this.ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    if (typeof window === 'undefined' || this.started || this.stopped || this.terminal) return;
    this.started = true;
    this.wireSocket(this.ws);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    if (this.socketIsOpen()) this.startKeepalive();
    else if (this.ws.readyState === WebSocket.CLOSED) this.scheduleReconnect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.suspended = true;
    this.resumePending = false;
    this.pingOnOpen = false;
    this.clearPingInterval();
    this.clearReconnectTimer();
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    }
    for (const socket of this.wiredSockets) this.unwireSocket(socket);
    this.wiredSockets.clear();
    this.closeCurrentSocket();
  }

  private socketIsOpen(socket = this.ws): boolean {
    return socket.readyState === undefined || socket.readyState === WebSocket.OPEN;
  }

  private clearPingInterval(): void {
    if (this.pingInterval === null) return;
    clearInterval(this.pingInterval);
    this.pingInterval = null;
  }

  private readonly sendPing = (): void => {
    this.send('ping');
  };

  private startKeepalive(): void {
    this.clearPingInterval();
    // Keepalive: send the LITERAL 'ping' string every 30s. The DO's
    // setWebSocketAutoResponse('ping','pong') answers it WITHOUT waking the
    // hibernated Durable Object, so idle bridged tabs stay cheap. (A JSON
    // { t: 'ping' } would miss the literal auto-response match and wake the DO
    // through webSocketMessage every 30s per tab.)
    this.pingInterval = setInterval(this.sendPing, PING_INTERVAL_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private connectReplacement(): void {
    if (this.stopped || this.terminal || this.suspended || !this.opts.createWebSocket) return;
    try {
      this.ws = this.opts.createWebSocket();
      this.wireSocket(this.ws);
      if (this.socketIsOpen()) this.handleSocketOpen(this.ws);
      else if (this.ws.readyState === WebSocket.CLOSED) this.scheduleReconnect();
    } catch (err) {
      console.error('[preview-bridge] WebSocket reconnect failed:', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.terminal ||
      this.suspended ||
      !this.opts.createWebSocket ||
      this.reconnectTimer !== null
    ) {
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectReplacement();
    }, delay);
  }

  private readonly onSocketMessage = async (event: MessageEvent): Promise<void> => {
    if (event.currentTarget != null && event.currentTarget !== this.ws) return;
    // The DO answers our literal 'ping' keepalive with a literal 'pong'
    // (setWebSocketAutoResponse). Skip non-JSON control frames before parsing.
    if (event.data === 'pong') {
      this.reconnectAttempt = 0;
      return;
    }
    try {
      const frame = JSON.parse(event.data);
      if (frame.t === 'cdp.req') {
        this.reconnectAttempt = 0;
        await this.opts.onFrame(frame);
      }
    } catch (err) {
      console.error('[preview-bridge] message handler failed:', err);
    }
  };

  private readonly onSocketOpen = (event?: Event): void => {
    if (event?.currentTarget != null && event.currentTarget !== this.ws) return;
    this.handleSocketOpen(this.ws);
  };

  private handleSocketOpen(socket: WebSocket): void {
    if (socket !== this.ws || this.stopped || this.terminal || this.suspended) return;
    if (this.pingOnOpen) {
      this.pingOnOpen = false;
      this.sendPing();
    }
    this.startKeepalive();
  }

  private readonly onSocketClose = (event?: CloseEvent): void => {
    const socket = (event?.currentTarget as WebSocket | null | undefined) ?? this.ws;
    if (socket !== this.ws) {
      this.unwireSocket(socket);
      this.wiredSockets.delete(socket);
      return;
    }
    this.unwireSocket(socket);
    this.wiredSockets.delete(socket);
    this.clearPingInterval();
    if (event?.code === 1000 && TERMINAL_CLOSE_REASONS.has(event.reason)) {
      this.latchTerminalState();
      return;
    }
    this.scheduleReconnect();
  };

  private latchTerminalState(): void {
    this.terminal = true;
    this.suspended = true;
    this.resumePending = false;
    this.pingOnOpen = false;
    this.clearReconnectTimer();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
  }

  private readonly onSocketError = (event: Event): void => {
    if (event.currentTarget == null || event.currentTarget === this.ws) {
      console.error('[preview-bridge] WebSocket error:', event);
    }
  };

  private wireSocket(socket: WebSocket): void {
    if (this.wiredSockets.has(socket)) return;
    this.wiredSockets.add(socket);
    socket.addEventListener('message', this.onSocketMessage);
    socket.addEventListener('open', this.onSocketOpen);
    socket.addEventListener('close', this.onSocketClose);
    socket.addEventListener('error', this.onSocketError);
  }

  private unwireSocket(socket: WebSocket): void {
    socket.removeEventListener('message', this.onSocketMessage);
    socket.removeEventListener('open', this.onSocketOpen);
    socket.removeEventListener('close', this.onSocketClose);
    socket.removeEventListener('error', this.onSocketError);
  }

  private readonly onVisibilityChange = (): void => {
    if (this.stopped || this.terminal) return;
    if (document.visibilityState !== 'visible') {
      this.resumePending = true;
      this.sendPing();
      return;
    }
    this.resume();
  };

  private readonly onPageShow = (): void => {
    this.resume();
  };

  private resume(): void {
    if (this.stopped || this.terminal || !this.resumePending) return;
    this.resumePending = false;
    this.suspended = false;
    this.clearReconnectTimer();
    if (this.socketIsOpen()) {
      this.sendPing();
      this.startKeepalive();
    } else if (this.ws.readyState !== WebSocket.CONNECTING) {
      this.pingOnOpen = true;
      this.connectReplacement();
    } else {
      this.pingOnOpen = true;
    }
  }

  private readonly onPageHide = (): void => {
    if (this.stopped || this.terminal) return;
    this.suspended = true;
    this.resumePending = true;
    this.clearPingInterval();
    this.clearReconnectTimer();
    this.closeCurrentSocket();
  };

  private closeCurrentSocket(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

export function createPreviewBridge(opts: PreviewBridgeOptions): PreviewBridge {
  const handler = createCdpHostHandler({
    capabilities: opts.capabilities ?? {
      navigate: false,
      screenshot: 'none' as const,
      openUrl: false,
    },
  });
  let socketController: PreviewSocketController;

  async function handleFrame(frame: CdpRequestEnvelope): Promise<void> {
    const response: CdpResponseEnvelope = { t: 'cdp.res', id: frame.id };
    try {
      response.result = await handler(frame.method, frame.params ?? {});
    } catch (err: unknown) {
      const error = err as { code?: number; message?: string };
      response.error = {
        code: typeof error.code === 'number' ? error.code : -32603,
        message: error.message ?? String(err),
      };
    }
    socketController.send(JSON.stringify(response));
  }

  function installWindowApi(): void {
    if (typeof window === 'undefined') return;
    const previewWindow = window as PreviewWindow;
    previewWindow.slicc = {
      emit(name: string, detail?: unknown) {
        const frame = JSON.stringify({ t: 'emit', name, detail });
        if (!socketController.send(frame)) navigator.sendBeacon('/__slicc/emit', frame);
      },
      on(name: string, callback: (detail: unknown) => void) {
        window.addEventListener(name, ((event: CustomEvent) => {
          callback(event.detail);
        }) as EventListener);
      },
    };
    previewWindow.__slicc = previewWindow.slicc;
  }

  socketController = new PreviewSocketController({
    ws: opts.ws,
    createWebSocket: opts.createWebSocket,
    onFrame: handleFrame,
  });

  return {
    handleFrame,
    installWindowApi,
    start: () => socketController.start(),
    stop: () => socketController.stop(),
  };
}

// IIFE bootstrap — reads data attributes from its own script tag and auto-starts
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const scripts = document.querySelectorAll('script[data-slicc-token][data-slicc-ws]');
  const thisScript = scripts[scripts.length - 1] as HTMLScriptElement | undefined;

  if (thisScript) {
    const token = thisScript.dataset.sliccToken;
    const wsUrl = thisScript.dataset.sliccWs;

    if (token && wsUrl) {
      try {
        const ws = new WebSocket(wsUrl);
        // `serve --bridge` is full-drive: the leader may navigate, screenshot
        // (html2canvas raster), and open URLs on the visitor tab. Without this
        // the handler falls back to the all-off default and every navigate /
        // screenshot / openUrl rejects with CherryUnsupportedError.
        const bridge = createPreviewBridge({
          ws,
          createWebSocket: () => new WebSocket(wsUrl),
          capabilities: { navigate: true, screenshot: 'html2canvas', openUrl: true },
        });

        // Install `window.slicc` synchronously — BEFORE the socket opens — so
        // inline page scripts that call `window.slicc.emit()` during load never
        // hit `undefined`, and an over-cap (429) / rejected upgrade still leaves
        // a working emit() (it beacons while the socket is not OPEN).
        bridge.installWindowApi();
        bridge.start();
      } catch (err) {
        console.error('[preview-bridge] bootstrap failed:', err);
      }
    }
  }
}
