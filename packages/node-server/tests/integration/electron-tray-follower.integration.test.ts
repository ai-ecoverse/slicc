// End-to-end: a mock leader (werift offerer + mock tray signalling) drives the
// real `ElectronTrayFollower` over a REAL WebRTC data channel, servicing CDP
// against a fake browser CDP endpoint. Mirrors the live validation that ran
// against Signal's real CDP. Kept in tests/integration/ (out of the default
// gate) because it exercises a real WebRTC/ICE handshake.
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RTCPeerConnection } from 'werift';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { ElectronTrayFollower } from '../../src/electron-tray-follower.js';

/** Fake browser CDP endpoint that answers Target.getTargets. */
async function startFakeBrowserCdp(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer: Server = createServer();
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as { port: number }).port;
  const wss = new WebSocketServer({ server: httpServer, path: '/devtools/browser/x' });
  wss.on('connection', (socket: WsWebSocket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.method === 'Target.getTargets') {
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: {
              targetInfos: [{ targetId: 'p1', type: 'page', url: 'app://renderer', title: 'App' }],
            },
          })
        );
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/x`,
    close: async () => {
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

interface MockLeader {
  joinUrl: string;
  waitForCdpResponse: (requestId: string) => Promise<Record<string, unknown>>;
  received: Array<{ type: string; [k: string]: unknown }>;
  close: () => Promise<void>;
}

/** werift offerer + mock tray signalling server; drives Target.getTargets once
 *  the follower advertises its targets. */
async function startMockLeader(): Promise<MockLeader> {
  const leader = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const dc = leader.createDataChannel('tray-control');
  const received: Array<{ type: string; [k: string]: unknown }> = [];
  const cdpWaiters = new Map<string, (m: Record<string, unknown>) => void>();

  dc.onMessage.subscribe((data) => {
    const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    received.push(msg);
    if (msg.type === 'targets.advertise') {
      dc.send(
        JSON.stringify({
          type: 'cdp.request',
          requestId: 'R1',
          localTargetId: 'browser',
          method: 'Target.getTargets',
        })
      );
    }
    if (msg.type === 'cdp.response' && cdpWaiters.has(msg.requestId)) {
      cdpWaiters.get(msg.requestId)!(msg);
      cdpWaiters.delete(msg.requestId);
    }
  });

  const offer = await leader.createOffer();
  await leader.setLocalDescription(offer);
  await new Promise<void>((resolve) => {
    if (leader.iceGatheringState === 'complete') return resolve();
    leader.iceGatheringStateChange.subscribe((st) => st === 'complete' && resolve());
    setTimeout(resolve, 3000);
  });
  const offerSdp = leader.localDescription!.sdp;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const msg = body ? JSON.parse(body) : {};
      const reply = (v: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(v));
      };
      const bootstrap = { bootstrapId: 'b1' };
      if (!msg.action) {
        return reply({
          trayId: 't1',
          role: 'follower',
          result: { action: 'signal', code: 'LEADER_CONNECTED', bootstrap },
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
      }
      if (msg.action === 'poll') {
        const events =
          msg.cursor === 0
            ? [{ type: 'bootstrap.offer', offer: { type: 'offer', sdp: offerSdp } }]
            : [];
        return reply({ role: 'follower', bootstrap, events });
      }
      if (msg.action === 'answer')
        await leader.setRemoteDescription({ type: 'answer', sdp: msg.answer.sdp });
      if (msg.action === 'ice-candidate') {
        try {
          await leader.addIceCandidate(msg.candidate);
        } catch {
          /* ignore late candidate */
        }
      }
      reply({ role: 'follower', bootstrap, events: [] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const joinUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/join`;

  return {
    joinUrl,
    received,
    waitForCdpResponse: (requestId) => new Promise((resolve) => cdpWaiters.set(requestId, resolve)),
    close: async () => {
      void leader.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('ElectronTrayFollower e2e (WebRTC + federated CDP)', () => {
  let cdp: Awaited<ReturnType<typeof startFakeBrowserCdp>>;
  let leader: MockLeader;
  let follower: ElectronTrayFollower;

  beforeEach(async () => {
    cdp = await startFakeBrowserCdp();
    leader = await startMockLeader();
  });
  afterEach(async () => {
    follower?.stop();
    await leader.close();
    await cdp.close();
  });

  it('joins the tray, connects over WebRTC, advertises targets, and services cdp.request against CDP', async () => {
    follower = new ElectronTrayFollower({
      joinUrl: leader.joinUrl,
      browserWsUrl: cdp.url,
      listTargets: async () => [{ id: 'p1', type: 'page', title: 'App', url: 'app://renderer' }],
      runtimeId: 'follower-under-test',
      pollIntervalMs: 200,
    });
    await follower.start();

    const response = (await leader.waitForCdpResponse('R1')) as {
      type: string;
      requestId: string;
      result?: { targetInfos?: Array<{ type: string }> };
    };
    expect(response.type).toBe('cdp.response');
    expect(response.requestId).toBe('R1');
    expect(response.result?.targetInfos?.[0]?.type).toBe('page');
    // The follower's hello + targets.advertise reached the leader.
    expect(leader.received.some((m) => m.type === 'hello')).toBe(true);
    expect(leader.received.some((m) => m.type === 'targets.advertise')).toBe(true);
  }, 20000);
});
