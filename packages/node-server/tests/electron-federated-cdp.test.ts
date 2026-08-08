import { createServer, type Server } from 'node:http';
import type { FollowerToLeaderMessage } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import {
  buildCdpEvent,
  buildCdpResponses,
  buildTargetsAdvertise,
  ElectronFederatedCdp,
  type FederatedCdpInspectableTarget,
} from '../src/electron-federated-cdp.js';

describe('buildTargetsAdvertise', () => {
  const targets: FederatedCdpInspectableTarget[] = [
    { id: 't1', type: 'page', title: 'Signal', url: 'file:///Applications/Signal.app/x.html' },
    { id: 't2', type: 'service_worker', title: 'sw', url: 'file:///sw.js' },
    { id: 't3', type: 'iframe', title: 'frame', url: 'https://www.sliccy.ai/electron' },
  ];

  it('advertises only page targets as browser RemoteTargetInfo', () => {
    const msg = buildTargetsAdvertise('runtime-A', targets);
    expect(msg.type).toBe('targets.advertise');
    expect(msg.runtimeId).toBe('runtime-A');
    expect(msg.targets).toEqual([
      {
        targetId: 't1',
        title: 'Signal',
        url: 'file:///Applications/Signal.app/x.html',
        kind: 'browser',
      },
    ]);
  });

  it('defaults a missing title to empty string', () => {
    const msg = buildTargetsAdvertise('r', [{ id: 'p', type: 'page', url: 'about:blank' }]);
    expect(msg.targets[0]?.title).toBe('');
  });
});

describe('buildCdpResponses', () => {
  it('emits a single cdp.response for a small result', () => {
    const messages = buildCdpResponses('req-1', { result: { value: 42 } });
    expect(messages).toEqual([{ type: 'cdp.response', requestId: 'req-1', result: { value: 42 } }]);
  });

  it('emits an error cdp.response for a CDP error', () => {
    const messages = buildCdpResponses('req-2', { error: 'boom' });
    expect(messages).toEqual([
      { type: 'cdp.response', requestId: 'req-2', result: undefined, error: 'boom' },
    ]);
  });

  it('chunks an oversize result into multiple cdp.response frames', () => {
    const big = { blob: 'x'.repeat(200 * 1024) }; // > 64 KB threshold
    const messages = buildCdpResponses('req-3', { result: big });
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(m.requestId).toBe('req-3');
      expect(typeof m.chunkData).toBe('string');
      expect(typeof m.totalChunks).toBe('number');
    }
    // Chunk indices are contiguous from 0.
    expect(messages.map((m) => m.chunkIndex)).toEqual(messages.map((_, i) => i));
  });
});

describe('buildCdpEvent', () => {
  it('maps a raw CDP event frame to a cdp.event message', () => {
    expect(
      buildCdpEvent({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'f' } },
        sessionId: 's1',
      })
    ).toEqual({
      type: 'cdp.event',
      method: 'Page.frameNavigated',
      params: { frame: { id: 'f' } },
      sessionId: 's1',
    });
  });

  it('defaults absent params to an empty object', () => {
    expect(buildCdpEvent({ method: 'X' })).toEqual({
      type: 'cdp.event',
      method: 'X',
      params: {},
      sessionId: undefined,
    });
  });
});

// -----------------------------------------------------------------------------
// Integration: the servicer over a fake browser CDP WebSocket.
// -----------------------------------------------------------------------------

interface FakeCdp {
  url: string;
  close: () => Promise<void>;
  socket: () => WsWebSocket | undefined;
}

async function startFakeBrowserCdp(
  onFrame: (
    frame: { id?: number; method?: string; sessionId?: string; params?: unknown },
    socket: WsWebSocket
  ) => void
): Promise<FakeCdp> {
  const httpServer: Server = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  const wss = new WebSocketServer({ server: httpServer, path: '/devtools/browser/1' });
  let active: WsWebSocket | undefined;
  wss.on('connection', (socket) => {
    active = socket;
    socket.on('message', (data) => {
      try {
        onFrame(JSON.parse(data.toString()), socket);
      } catch {
        /* ignore */
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/devtools/browser/1`,
    close: async () => {
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
    socket: () => active,
  };
}

describe('ElectronFederatedCdp servicer', () => {
  it('forwards a leader cdp.request to CDP and returns the correlated cdp.response', async () => {
    const fake = await startFakeBrowserCdp((frame, socket) => {
      if (typeof frame.id === 'number' && frame.method === 'Runtime.evaluate') {
        // Echo the session + a result so we can assert routing.
        socket.send(
          JSON.stringify({ id: frame.id, result: { value: `ran@${frame.sessionId ?? 'root'}` } })
        );
      }
    });
    try {
      const sent: FollowerToLeaderMessage[] = [];
      const servicer = new ElectronFederatedCdp({ runtimeId: 'r1', send: (m) => sent.push(m) });
      await servicer.connect(fake.url);

      servicer.handleCdpRequest({
        requestId: 'leader-req-1',
        localTargetId: 't1',
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
        sessionId: 'sess-A',
      });

      await vi.waitFor(() => {
        expect(sent.some((m) => m.type === 'cdp.response')).toBe(true);
      });
      const response = sent.find((m) => m.type === 'cdp.response');
      expect(response).toEqual({
        type: 'cdp.response',
        requestId: 'leader-req-1',
        result: { value: 'ran@sess-A' },
      });
      servicer.stop();
    } finally {
      await fake.close();
    }
  });

  it('forwards raw CDP events as cdp.event', async () => {
    const fake = await startFakeBrowserCdp(() => {});
    try {
      const sent: FollowerToLeaderMessage[] = [];
      const servicer = new ElectronFederatedCdp({ runtimeId: 'r1', send: (m) => sent.push(m) });
      await servicer.connect(fake.url);
      // Server pushes an unsolicited event frame.
      fake.socket()?.send(
        JSON.stringify({
          method: 'Target.targetCreated',
          params: { targetInfo: { id: 'x' } },
          sessionId: 's9',
        })
      );
      await vi.waitFor(() => {
        expect(sent.some((m) => m.type === 'cdp.event')).toBe(true);
      });
      expect(sent.find((m) => m.type === 'cdp.event')).toEqual({
        type: 'cdp.event',
        method: 'Target.targetCreated',
        params: { targetInfo: { id: 'x' } },
        sessionId: 's9',
      });
      servicer.stop();
    } finally {
      await fake.close();
    }
  });

  it('answers with an error cdp.response when not connected', () => {
    const sent: FollowerToLeaderMessage[] = [];
    const servicer = new ElectronFederatedCdp({ runtimeId: 'r1', send: (m) => sent.push(m) });
    servicer.handleCdpRequest({ requestId: 'r', localTargetId: 't', method: 'Page.enable' });
    expect(sent).toEqual([
      { type: 'cdp.response', requestId: 'r', result: undefined, error: 'cdp-not-connected' },
    ]);
  });
});
