/**
 * Minimal stand-in for the SLICC /cdp proxy (node-server `index.ts` and
 * swift-server `CDPProxy.swift`): one Chrome browser-level WebSocket, one
 * active client slot, frames relayed verbatim.
 *
 * Policies for what happens when the Chrome leg closes:
 *   'node' / 'swift'  — the shipped behaviour of both floats (issue #2417).
 *             Both now run ONE policy, modelled here:
 *               · buffer client frames while the leg is down, tagged with the
 *                 `{chromeConnectionId, clientId}` they were written for;
 *               · reconnect to Chrome after ~1s, indefinitely — no attempt cap;
 *               · on the way back, DISCARD a buffer whose generation no longer
 *                 matches (frames from the dead leg name sessions Chrome threw
 *                 away, and a buffered `Target.createTarget` would open a
 *                 duplicate tab after its caller was already rejected), then
 *                 close the client with application code 4002 `upstream-reset`
 *                 so it re-dials and drops every cached session;
 *               · close the client with 4002 after the 3rd consecutive failed
 *                 reconnect too, so it never hangs on a dead proxy;
 *               · never leave a clientless buffer around.
 *             Frames buffered before Chrome was EVER up (initial connect) still
 *             flush — nothing was lost, so they still mean what they meant.
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
  /** Buffered frames thrown away because their generation no longer matched. */
  droppedBufferedFrames: number;
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
/** Mirrors `CHROME_RECONNECT_FAILURE_THRESHOLD` / `upstreamResetFailureThreshold`. */
const RECONNECT_FAILURE_THRESHOLD = 3;

/** The `{chromeConnection, client}` pair a buffer's frames were written for. */
interface BufferGeneration {
  /** null = no leg was live, so any connection may take the frames. */
  chromeConnectionId: number | null;
  clientId: number | null;
}

interface FrameBuffer {
  generation: BufferGeneration;
  frames: string[];
}

export async function startProxy(chromeWsUrl: string, policy: ProxyPolicy): Promise<ProxyHandle> {
  const stats: ProxyStats = {
    chromeOpens: 0,
    droppedFrames: 0,
    relayed: 0,
    upstreamResets: 0,
    droppedBufferedFrames: 0,
  };
  const reconnects = policy !== 'legacy-node';
  const signalsReset = policy === 'node' || policy === 'swift';
  let chromeWs: WebSocket | null = null;
  let chromeConnectionSeq = 0;
  let activeClient: WebSocket | null = null;
  let activeClientId: number | null = null;
  let clientSeq = 0;
  let buffer: FrameBuffer | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let didSignalFailure = false;
  let closed = false;

  /** Clear the buffer, counting frames nobody will ever deliver. */
  const releaseBuffer = (): void => {
    if (!buffer) return;
    stats.droppedBufferedFrames += buffer.frames.length;
    buffer = null;
  };

  /** Frames the connection `targetId` may take; the rest are dropped. */
  const takeBuffer = (targetId: number): string[] => {
    const held = buffer;
    buffer = null;
    if (!held) return [];
    const { generation } = held;
    const staleLeg =
      generation.chromeConnectionId !== null && generation.chromeConnectionId !== targetId;
    const staleClient = activeClientId === null || generation.clientId !== activeClientId;
    if (!staleLeg && !staleClient) return held.frames;
    stats.droppedBufferedFrames += held.frames.length;
    return [];
  };

  /** Cut the client loose with 4002; its buffer dies with it. */
  const resetClient = (): void => {
    if (!activeClient || activeClient.readyState !== WebSocket.OPEN) return;
    const client = activeClient;
    activeClient = null;
    activeClientId = null;
    releaseBuffer();
    stats.upstreamResets += 1;
    client.close(UPSTREAM_RESET_CLOSE_CODE, 'upstream-reset');
  };

  const connectChrome = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const connectionId = ++chromeConnectionSeq;
      const ws = new WebSocket(chromeWsUrl, { maxPayload: 0 });
      chromeWs = ws;
      ws.on('open', () => {
        stats.chromeOpens += 1;
        consecutiveFailures = 0;
        didSignalFailure = false;
        const reestablished = stats.chromeOpens > 1;
        for (const m of takeBuffer(connectionId)) ws.send(m);
        // Shipped proxies: once the leg is back, cut the client loose with 4002
        // so it resets its session state.
        if (reestablished && signalsReset) resetClient();
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
        if (!reconnects) return; // 'legacy-node': frames drop until a NEW client connects.
        // Tagged with the leg that just died, so the flush onto the replacement
        // discards it rather than replaying dead-session frames.
        buffer ??= {
          generation: { chromeConnectionId: connectionId, clientId: activeClientId },
          frames: [],
        };
        scheduleReconnect();
      });
      ws.on('error', (e) => reject(e));
    });

  // A function declaration, not a const: it and `connectChrome` call each other.
  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectChrome().catch(() => {
        consecutiveFailures += 1;
        if (
          signalsReset &&
          !didSignalFailure &&
          consecutiveFailures >= RECONNECT_FAILURE_THRESHOLD
        ) {
          didSignalFailure = true;
          resetClient();
        }
        // No attempt cap: keep retrying until the harness closes the proxy.
        scheduleReconnect();
      });
    }, RECONNECT_MS);
  }

  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/cdp' });
  wss.on('connection', (client) => {
    if (activeClient && activeClient.readyState === WebSocket.OPEN) {
      activeClient.close(4001, 'superseded-by-new-cdp-client');
    }
    const clientId = ++clientSeq;
    activeClient = client;
    activeClientId = clientId;
    // Whatever the previous holder buffered belongs to IT.
    if (buffer && buffer.generation.clientId !== clientId) releaseBuffer();
    // Initial-connect buffering only: with the leg up, frames go straight out.
    if (!chromeWs) buffer ??= { generation: { chromeConnectionId: null, clientId }, frames: [] };
    client.on('message', (data) => {
      const str = String(data);
      if (chromeWs && chromeWs.readyState === WebSocket.OPEN && buffer === null) {
        chromeWs.send(str);
      } else if (buffer !== null) {
        buffer.frames.push(str);
      } else {
        stats.droppedFrames += 1; // node-server: "Client→Chrome (DROPPED — no connection)"
      }
    });
    client.on('close', () => {
      if (activeClient !== client) return;
      activeClient = null;
      activeClientId = null;
      releaseBuffer();
    });
    if (!chromeWs) void connectChrome().catch(() => scheduleReconnect());
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
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      chromeWs?.terminate();
      activeClient?.terminate();
      wss.close();
      server.close();
    },
  };
}
