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

interface PingEnvelope {
  t: 'ping';
}

type OutboundEnvelope = CdpResponseEnvelope | PingEnvelope;

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
        const payload = JSON.stringify({ name, detail });
        navigator.sendBeacon('/__slicc/emit', payload);
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
      try {
        const frame = JSON.parse(event.data);
        if (frame.t === 'cdp.req') {
          await handleFrame(frame);
        }
      } catch (err) {
        console.error('[preview-bridge] message handler failed:', err);
      }
    });

    // Send ping every 30s
    pingInterval = setInterval(() => {
      send({ t: 'ping' });
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
        const bridge = createPreviewBridge({ ws });

        ws.addEventListener('open', () => {
          bridge.installWindowApi();
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
