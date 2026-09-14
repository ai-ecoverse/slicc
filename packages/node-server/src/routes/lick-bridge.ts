import { WebSocket, WebSocketServer } from 'ws';

export interface LickBridge {
  lickWss: WebSocketServer;

  sendLickRequest(type: string, data: unknown, timeout?: number): Promise<unknown>;

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
      } catch {}
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

      const client = Array.from(lickClients).find((c) => c.readyState === WebSocket.OPEN);
      if (!client) {
        reject(new Error('No browser connected'));
        return;
      }

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
