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

  function broadcastLickEvent(event: unknown): void {
    const msg = JSON.stringify(event);
    for (const client of lickClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  return { lickWss, sendLickRequest, broadcastLickEvent };
}
