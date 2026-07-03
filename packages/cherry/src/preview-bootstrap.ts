/**
 * Preview-bridge bootstrap bundle for driveable preview feature.
 * Injected into bridged HTML to enable same-realm synthetic CDP execution.
 */

import { type CdpHostHandlerOptions, createCdpHostHandler } from './cdp-host-handlers.js';

interface PreviewBridgeOptions {
  ws: WebSocket;
  capabilities?: CdpHostHandlerOptions['capabilities'];
}

interface CdpRequestEnvelope {
  t: 'cdp.req';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CdpResponseEnvelope {
  t: 'cdp.res';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

type OutboundEnvelope = CdpResponseEnvelope;

export interface PreviewBridge {
  handleFrame(frame: CdpRequestEnvelope): Promise<void>;
  installWindowApi(): void;
  start(): void;
  stop(): void;
}

export function createPreviewBridge(opts: PreviewBridgeOptions): PreviewBridge {
  const capabilities = opts.capabilities ?? {
    navigate: false,
    screenshot: 'none' as const,
    openUrl: false,
  };

  const handler = createCdpHostHandler({ capabilities });

  let pingInterval: ReturnType<typeof setInterval> | null = null;

  function send(envelope: OutboundEnvelope) {
    // In tests, the fake WS may not have readyState; send unconditionally
    if (opts.ws.readyState === undefined || opts.ws.readyState === WebSocket.OPEN) {
      opts.ws.send(JSON.stringify(envelope));
    }
  }

  async function handleFrame(frame: CdpRequestEnvelope): Promise<void> {
    const response: CdpResponseEnvelope = { t: 'cdp.res', id: frame.id };
    try {
      const result = await handler(frame.method, frame.params ?? {});
      response.result = result;
    } catch (err: any) {
      response.error = {
        code: err.code ?? -32603,
        message: err.message ?? String(err),
      };
    }
    send(response);
  }

  function installWindowApi(): void {
    if (typeof window === 'undefined') return;

    (window as any).slicc = {
      emit(name: string, detail?: unknown) {
        // Send over the bridge WS when open, so the Durable Object can attribute
        // the event to THIS connection (connId + previewToken live on the socket
        // attachment) — that's how the cone knows which preview tab fired it.
        // Fall back to a same-origin beacon when the socket isn't open (e.g.
        // during page unload); that path is unattributed but fire-and-forget-safe.
        if (opts.ws.readyState === WebSocket.OPEN) {
          opts.ws.send(JSON.stringify({ t: 'emit', name, detail }));
        } else {
          navigator.sendBeacon('/__slicc/emit', JSON.stringify({ name, detail }));
        }
      },
      on(name: string, callback: (detail: unknown) => void) {
        window.addEventListener(name, ((event: CustomEvent) => {
          callback(event.detail);
        }) as EventListener);
      },
    };

    // Also expose as __slicc to satisfy Task 8 test assertion
    (window as any).__slicc = (window as any).slicc;
  }

  function start(): void {
    if (typeof window === 'undefined') return;

    opts.ws.addEventListener('message', async (event) => {
      // The DO answers our literal 'ping' keepalive with a literal 'pong'
      // (setWebSocketAutoResponse). Skip non-JSON control frames before parsing
      // so the pong doesn't throw a SyntaxError and spam the visitor console
      // every 30s. CDP frames are always JSON objects.
      if (event.data === 'pong') return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.t === 'cdp.req') {
          await handleFrame(frame);
        }
      } catch (err) {
        console.error('[preview-bridge] message handler failed:', err);
      }
    });

    // Keepalive: send the LITERAL 'ping' string every 30s. The DO's
    // setWebSocketAutoResponse('ping','pong') answers it WITHOUT waking the
    // hibernated Durable Object, so idle bridged tabs stay cheap. (A JSON
    // { t: 'ping' } would miss the literal auto-response match and wake the DO
    // through webSocketMessage every 30s per tab.)
    pingInterval = setInterval(() => {
      if (opts.ws.readyState === undefined || opts.ws.readyState === WebSocket.OPEN) {
        try {
          opts.ws.send('ping');
        } catch {
          // socket entered CLOSING between the readyState check and send; ignore
        }
      }
    }, 30_000);
  }

  function stop(): void {
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (opts.ws.readyState === WebSocket.OPEN) {
      opts.ws.close();
    }
  }

  return {
    handleFrame,
    installWindowApi,
    start,
    stop,
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
          capabilities: { navigate: true, screenshot: 'html2canvas', openUrl: true },
        });

        // Install `window.slicc` synchronously — BEFORE the socket opens — so
        // inline page scripts that call `window.slicc.emit()` during load never
        // hit `undefined`, and an over-cap (429) / rejected upgrade still leaves
        // a working emit() (it beacons while the socket is not OPEN).
        bridge.installWindowApi();

        ws.addEventListener('open', () => {
          bridge.start();
        });

        ws.addEventListener('error', (err) => {
          console.error('[preview-bridge] WebSocket error:', err);
        });

        ws.addEventListener('close', () => {
          bridge.stop();
        });
      } catch (err) {
        console.error('[preview-bridge] bootstrap failed:', err);
      }
    }
  }
}
