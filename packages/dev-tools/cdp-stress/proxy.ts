/**
 * Minimal stand-in for the SLICC /cdp proxy (node-server `index.ts` and
 * swift-server `CDPProxy.swift`): one Chrome browser-level WebSocket, one
 * active client slot, frames relayed verbatim.
 *
 * Two policies for what happens when the Chrome leg closes:
 *   'node'  — node-server behaviour: chromeWs = null; client frames are DROPPED
 *             until a NEW client connects (the existing client is never told).
 *   'swift' — swift-server behaviour: reconnect to Chrome after ~1s and keep
 *             serving the SAME client (again, never told).
 *
 * `dropChromeLeg()` simulates the `messageTooLarge` / 1006 close seen in the
 * production logs; Chrome discards every session on that connection.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export type ProxyPolicy = 'node' | 'swift';

export interface ProxyStats {
  chromeOpens: number;
  droppedFrames: number;
  relayed: number;
}

export interface ProxyHandle {
  url: string;
  policy: ProxyPolicy;
  /** Emulate the Chrome-leg close (`messageTooLarge` / 1006). */
  dropChromeLeg: () => void;
  /** Close the client leg with the 4001 supersede code. */
  evictClient: () => void;
  /** Hard-kill the client leg (1006), like a network blip — no supersede latch. */
  killClient: () => void;
  stats: ProxyStats;
  close: () => void;
}

const SWIFT_RECONNECT_MS = 1000;

export async function startProxy(chromeWsUrl: string, policy: ProxyPolicy): Promise<ProxyHandle> {
  const stats: ProxyStats = { chromeOpens: 0, droppedFrames: 0, relayed: 0 };
  let chromeWs: WebSocket | null = null;
  let activeClient: WebSocket | null = null;
  let buffer: string[] | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connectChrome = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(chromeWsUrl, { maxPayload: 0 });
      chromeWs = ws;
      ws.on('open', () => {
        stats.chromeOpens += 1;
        if (buffer) for (const m of buffer) ws.send(m);
        buffer = null;
        resolve();
      });
      ws.on('message', (data) => {
        stats.relayed += 1;
        if (activeClient && activeClient.readyState === WebSocket.OPEN) {
          activeClient.send(String(data));
        }
      });
      ws.on('close', () => {
        if (chromeWs !== ws) return;
        chromeWs = null;
        if (policy === 'swift') {
          buffer = [];
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectChrome().catch(() => {});
          }, SWIFT_RECONNECT_MS);
        }
        // policy 'node': nothing. Frames drop until a NEW client connects.
      });
      ws.on('error', (e) => reject(e));
    });

  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/cdp' });
  wss.on('connection', (client) => {
    if (activeClient && activeClient.readyState === WebSocket.OPEN) {
      activeClient.close(4001, 'superseded-by-new-cdp-client');
    }
    activeClient = client;
    if (!chromeWs) buffer = buffer ?? [];
    client.on('message', (data) => {
      const str = String(data);
      if (chromeWs && chromeWs.readyState === WebSocket.OPEN && buffer === null) {
        chromeWs.send(str);
      } else if (buffer !== null) {
        buffer.push(str);
      } else {
        stats.droppedFrames += 1; // node-server: "Client→Chrome (DROPPED — no connection)"
      }
    });
    client.on('close', () => {
      if (activeClient === client) activeClient = null;
    });
    if (!chromeWs) void connectChrome().catch(() => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await connectChrome();
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/cdp`,
    policy,
    stats,
    dropChromeLeg: () => chromeWs?.terminate(),
    evictClient: () => activeClient?.close(4001, 'superseded-by-new-cdp-client'),
    killClient: () => activeClient?.terminate(),
    close: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      chromeWs?.terminate();
      activeClient?.terminate();
      wss.close();
      server.close();
    },
  };
}
