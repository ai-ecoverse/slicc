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
}

export function createLickBridge(): LickBridge {
  const lickWss = new WebSocketServer({ noServer: true });
  const lickClients = new Set<WebSocket>();
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

        // Handle responses to pending requests
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
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on('close', () => {
      lickClients.delete(ws);
      console.log('[licks] Browser client disconnected');
    });
  });

  function sendLickRequest(type: string, data: unknown, timeout = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++requestIdCounter}`;
      const msg = JSON.stringify({ type, requestId, ...(data as object) });

      // Find a connected client
      const client = Array.from(lickClients).find((c) => c.readyState === WebSocket.OPEN);
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
  const STREAM_DEFAULT_TIMEOUT = 600_000;

  function sendLickStream(
    type: string,
    data: unknown,
    onFrame: (frame: unknown) => void,
    timeout = STREAM_DEFAULT_TIMEOUT
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++requestIdCounter}`;
      const client = Array.from(lickClients).find((c) => c.readyState === WebSocket.OPEN);
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

      client.send(JSON.stringify({ type, requestId, ...(data as object) }));
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

  return { lickWss, sendLickRequest, sendLickStream, broadcastLickEvent };
}
