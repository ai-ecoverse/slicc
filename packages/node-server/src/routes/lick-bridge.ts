import { WebSocket, WebSocketServer } from 'ws';

/**
 * Lick system — WebSocket bridge for webhooks/crontasks. All the actual
 * logic lives in the browser; this bridge is the request/response and
 * broadcast transport between the CLI's HTTP routes and the connected
 * browser client(s).
 */
export interface LickBridge {
  /** noServer WebSocketServer — the caller wires `/licks-ws` upgrades to it. */
  lickWss: WebSocketServer;
  /** Send a request to the browser and wait for its response. */
  sendLickRequest(type: string, data: unknown, timeout?: number): Promise<unknown>;
  /**
   * Send a streaming request to the browser. Incoming `shell-chunk` frames
   * are forwarded to `onFrame`; `shell-done` resolves the promise. The
   * timeout (default 10 min) resets on each frame so a slow-but-active
   * stream stays alive. Standalone-only (extension has no node-server).
   */
  sendLickStream(
    type: string,
    data: unknown,
    onFrame: (frame: unknown) => void,
    timeout?: number
  ): Promise<void>;
  /** Broadcast an event to all connected browsers (no response expected). */
  broadcastLickEvent(event: unknown): void;
  /**
   * Register the sink for browser-pushed `lickback-event` frames (a cup
   * page's outbound chat / `upgrade` / sprinkle licks). The sink is the
   * LickbackRegistry's `enqueue`. Passing `null` clears it. Only one sink at a
   * time (cup runs one registry). Standalone-only (spec §11).
   */
  setLickbackSink(handler: ((channel: string, event: unknown) => void) | null): void;
}

export function createLickBridge(): LickBridge {
  const lickWss = new WebSocketServer({ noServer: true });
  const lickClients = new Set<WebSocket>();
  // Cup pages that announced (`register-shell-host`) they can service
  // steering requests. Insertion order = connection order, so the first entry
  // is the topology-A leader (the overlay injects + boots it first). See
  // `pickSteeringClient`.
  const shellHostClients = new Set<WebSocket>();
  const pendingRequests = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  const pendingStreams = new Map<
    string,
    {
      onFrame: (frame: unknown) => void;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  >();
  let requestIdCounter = 0;
  // Browser-pushed lick-back events (cup outbound channel) drain here.
  let lickbackSink: ((channel: string, event: unknown) => void) | null = null;

  /**
   * Dispatch one inbound message from a connected browser client: a response to
   * a pending request, a shell stream frame / terminator, a cup page
   * registering itself as a steering shell host, or a lick-back outbound push.
   */
  function dispatchClientMessage(
    ws: WebSocket,
    msg: { type: string; requestId?: string; [key: string]: unknown }
  ): void {
    if (msg.type === 'response' && msg.requestId) {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        if (msg.error) {
          pending.reject(new Error(msg.error as string));
        } else {
          pending.resolve(msg.data);
        }
      }
    } else if (msg.type === 'shell-chunk' && msg.requestId) {
      pendingStreams.get(msg.requestId)?.onFrame(msg.frame);
    } else if (msg.type === 'shell-done' && msg.requestId) {
      const stream = pendingStreams.get(msg.requestId);
      if (stream) {
        pendingStreams.delete(msg.requestId);
        stream.resolve();
      }
    } else if (msg.type === 'register-shell-host') {
      // A cup page announcing it can service steering requests
      // (shell-exec, vfs-*, targets, lick-emit). See pickSteeringClient.
      shellHostClients.add(ws);
    } else if (msg.type === 'lickback-event') {
      // A cup page pushing an outbound lick-back event (chat message,
      // forwarded `upgrade`/sprinkle lick). No `requestId`, no reply — the
      // sink (LickbackRegistry.enqueue) buffers/forwards it to the channel's
      // claimed owner. Channel defaults to `chat` for a malformed push.
      const channel = typeof msg.channel === 'string' && msg.channel ? msg.channel : 'chat';
      lickbackSink?.(channel, msg.event);
    }
  }

  lickWss.on('connection', (ws) => {
    lickClients.add(ws);
    console.log('[licks] Browser client connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          requestId?: string;
          [key: string]: unknown;
        };
        dispatchClientMessage(ws, msg);
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on('close', () => {
      lickClients.delete(ws);
      shellHostClients.delete(ws);
      console.log('[licks] Browser client disconnected');
    });
  });

  /**
   * Pick the client a steering request (shell-exec, vfs-*, targets, lick-emit)
   * is sent to. Prefer a registered cup shell host — the first still-OPEN
   * one, which by Set insertion order is the leader (the overlay injects + boots
   * it first, so it registers first); if it drops, the next registered host
   * takes over. Fall back to the first OPEN client when nothing registered, so
   * the single-page standalone cup path is unchanged.
   */
  function pickSteeringClient(): WebSocket | undefined {
    for (const c of shellHostClients) {
      if (c.readyState === WebSocket.OPEN) return c;
    }
    return Array.from(lickClients).find((c) => c.readyState === WebSocket.OPEN);
  }

  function sendLickRequest(type: string, data: unknown, timeout = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++requestIdCounter}`;
      const msg = JSON.stringify({ type, requestId, ...(data as object) });

      // Route to the cup shell host (the leader) when one is registered.
      const client = pickSteeringClient();
      if (!client) {
        reject(new Error('No browser connected'));
        return;
      }

      // Set up timeout
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeout);

      pendingRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      client.send(msg);
    });
  }

  // 10 minutes — resets on every frame so a slow-but-active stream stays alive.
  // NOTE: phase-1 cup streamExec is block-level (it emits all frames at command
  // completion), so this per-frame reset is currently inert for cup exec — a
  // command must finish within one timeout window. The reset becomes meaningful
  // once incremental output lands (see cup-session.ts TODO(streaming)).
  const STREAM_DEFAULT_TIMEOUT = 600_000;

  function sendLickStream(
    type: string,
    data: unknown,
    onFrame: (frame: unknown) => void,
    timeout = STREAM_DEFAULT_TIMEOUT
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++requestIdCounter}`;
      const client = pickSteeringClient();
      if (!client) {
        reject(new Error('No browser connected'));
        return;
      }

      let timer = setTimeout(onTimeout, timeout);

      function onTimeout(): void {
        pendingStreams.delete(requestId);
        reject(new Error('Request timeout'));
      }

      pendingStreams.set(requestId, {
        onFrame: (frame: unknown) => {
          clearTimeout(timer);
          timer = setTimeout(onTimeout, timeout);
          onFrame(frame);
        },
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      // `stream: true` (after the spread so a payload field can't clobber it)
      // tells the webapp lick-ws-bridge to route this to its streaming handler
      // (handleLickStream → shell-chunk/shell-done frames) rather than the
      // one-shot path. Without it, /api/shell/exec?stream=true returns empty.
      client.send(JSON.stringify({ type, requestId, ...(data as object), stream: true }));
    });
  }

  function broadcastLickEvent(event: unknown): void {
    const msg = JSON.stringify(event);
    for (const client of lickClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  function setLickbackSink(handler: ((channel: string, event: unknown) => void) | null): void {
    lickbackSink = handler;
  }

  return { lickWss, sendLickRequest, sendLickStream, broadcastLickEvent, setLickbackSink };
}
