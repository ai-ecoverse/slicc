/**
 * Minimal stand-in for the SLICC /cdp proxy (node-server `index.ts` and
 * swift-server `CDPProxy.swift`): one Chrome browser-level WebSocket, one
 * active client slot, frames relayed verbatim.
 *
 * Policies for what happens when the Chrome leg closes:
 *   'node' / 'swift'  — the shipped behaviour of both floats (issue #2417):
 *             buffer client frames, reconnect to Chrome after ~1s, flush, then
 *             close the client with application code 4002 `upstream-reset` so
 *             it re-dials and drops every cached session. The two floats differ
 *             only in reconnect-failure handling, which this stand-in does not
 *             model, so the policies behave identically here.
 *   'legacy-swift' — pre-fix swift-server: reconnect to Chrome after ~1s and
 *             keep serving the SAME client without telling it. Older Sliccstart
 *             binaries in the field still do this, so the webapp's self-heal
 *             must cope with it.
 *   'legacy-node'  — pre-fix node-server: chromeWs = null; client frames are
 *             DROPPED until a NEW client connects (the client is never told).
 *             Nothing client-side can recover from this except timeouts.
 *
 * `dropChromeLeg()` simulates the `messageTooLarge` / 1006 close seen in the
 * production logs; Chrome discards every session on that connection.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export type ProxyPolicy = 'node' | 'swift' | 'legacy-swift' | 'legacy-node';

/** Mirrors `CDP_UPSTREAM_RESET_CLOSE_CODE` in packages/webapp/src/cdp/cdp-client.ts. */
export const UPSTREAM_RESET_CLOSE_CODE = 4002;

export interface ProxyStats {
  chromeOpens: number;
  droppedFrames: number;
  relayed: number;
  /** Client closes issued with the 4002 upstream-reset code. */
  upstreamResets: number;
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

const RECONNECT_MS = 1000;

export async function startProxy(chromeWsUrl: string, policy: ProxyPolicy): Promise<ProxyHandle> {
  const stats: ProxyStats = { chromeOpens: 0, droppedFrames: 0, relayed: 0, upstreamResets: 0 };
  const reconnects = policy !== 'legacy-node';
  const signalsReset = policy === 'node' || policy === 'swift';
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
        const reestablished = stats.chromeOpens > 1;
        if (buffer) for (const m of buffer) ws.send(m);
        buffer = null;
        // Shipped proxies: once the leg is back and buffered frames flushed,
        // cut the client loose with 4002 so it resets its session state.
        if (reestablished && signalsReset && activeClient?.readyState === WebSocket.OPEN) {
          stats.upstreamResets += 1;
          activeClient.close(UPSTREAM_RESET_CLOSE_CODE, 'upstream-reset');
        }
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
        if (reconnects) {
          buffer = [];
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectChrome().catch(() => {});
          }, RECONNECT_MS);
        }
        // 'legacy-node': nothing. Frames drop until a NEW client connects.
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
