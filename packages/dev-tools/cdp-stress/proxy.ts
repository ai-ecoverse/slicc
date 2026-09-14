import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export type ProxyPolicy = 'node' | 'swift' | 'legacy-swift' | 'legacy-node';

export const UPSTREAM_RESET_CLOSE_CODE = 4002;

export interface ProxyStats {
  chromeOpens: number;
  droppedFrames: number;
  relayed: number;

  upstreamResets: number;

  droppedBufferedFrames: number;
}

export interface ProxyHandle {
  url: string;
  policy: ProxyPolicy;

  dropChromeLeg: () => void;

  evictClient: () => void;

  killClient: () => void;
  stats: ProxyStats;
  close: () => void;
}

const RECONNECT_MS = 1000;

const RECONNECT_FAILURE_THRESHOLD = 3;

interface BufferGeneration {
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

  const releaseBuffer = (): void => {
    if (!buffer) return;
    stats.droppedBufferedFrames += buffer.frames.length;
    buffer = null;
  };

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
        if (!reconnects) return;

        buffer ??= {
          generation: { chromeConnectionId: connectionId, clientId: activeClientId },
          frames: [],
        };
        scheduleReconnect();
      });
      ws.on('error', (e) => reject(e));
    });

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

    if (buffer && buffer.generation.clientId !== clientId) releaseBuffer();

    if (!chromeWs) buffer ??= { generation: { chromeConnectionId: null, clientId }, frames: [] };
    client.on('message', (data) => {
      const str = String(data);
      if (chromeWs && chromeWs.readyState === WebSocket.OPEN && buffer === null) {
        chromeWs.send(str);
      } else if (buffer !== null) {
        buffer.frames.push(str);
      } else {
        stats.droppedFrames += 1;
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
