import { describe, expect, it } from 'vitest';
import { makeTrayWithConnectedLeader } from './preview-bridge-harness.js';

describe('bridge role routing and relay', () => {
  it('relays cdp.request from leader to the right bridge socket and cdp.res back', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    await h.deliverLeaderMessage({
      type: 'bridge.cdp.request',
      connId: bridgeWs.connId,
      id: 7,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
    });

    const receivedMessages = bridgeWs.ws.received.map((msg) => JSON.parse(msg));
    expect(receivedMessages).toContainEqual(
      expect.objectContaining({ t: 'cdp.req', id: 7, method: 'Runtime.evaluate' })
    );

    await h.deliverBridgeMessage(bridgeWs, {
      t: 'cdp.res',
      id: 7,
      result: { value: 1 },
    });

    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.cdp.response',
        connId: bridgeWs.connId,
        id: 7,
        result: { value: 1 },
      })
    );
  });

  it('replays bridge.connected to a reconnected leader (survives leader reload)', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    const replayed = await h.reconnectLeader();

    expect(replayed).toContainEqual(
      expect.objectContaining({
        type: 'bridge.connected',
        connId: bridgeWs.connId,
        replay: true,
      })
    );
  });

  it('closes the bridge socket and notifies the leader on bridge.close', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    await h.deliverLeaderMessage({ type: 'bridge.close', connId: bridgeWs.connId });

    expect(bridgeWs.closed).toBe(true);
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({ type: 'bridge.disconnected', connId: bridgeWs.connId })
    );
  });

  it('emits bridge.disconnected on bridge socket close', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    await h.closeBridge(bridgeWs);

    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.disconnected',
        connId: bridgeWs.connId,
      })
    );
  });

  it('drops a malformed (non-JSON) bridge frame without crashing the DO; relay survives', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    await expect(
      h.do.webSocketMessage(bridgeWs.serverWs as never, 'not-json{')
    ).resolves.toBeUndefined();

    await h.deliverBridgeMessage(bridgeWs, { t: 'cdp.res', id: 1, result: { ok: true } });
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.cdp.response',
        connId: bridgeWs.connId,
        id: 1,
        result: { ok: true },
      })
    );
  });

  it('synthesizes an error cdp.response when the target bridge connection is gone', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });

    await h.deliverLeaderMessage({
      type: 'bridge.cdp.request',
      connId: 'ghost-conn',
      id: 99,
      method: 'Runtime.evaluate',
      params: {},
    });

    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.cdp.response',
        connId: 'ghost-conn',
        id: 99,
        error: expect.objectContaining({ message: expect.stringContaining('gone') }),
      })
    );
  });

  it('routes cdp.request to the correct bridge socket by connId', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, maxTabs: 5 });
    const bridge1 = await h.openBridge();
    const bridge2 = await h.openBridge();

    await h.deliverLeaderMessage({
      type: 'bridge.cdp.request',
      connId: bridge2.connId,
      id: 42,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });

    const bridge2Received = bridge2.ws.received.map((msg) => JSON.parse(msg));
    const bridge1Received = bridge1.ws.received.map((msg) => JSON.parse(msg));
    expect(bridge2Received).toContainEqual(
      expect.objectContaining({ t: 'cdp.req', id: 42, method: 'Page.navigate' })
    );
    expect(bridge1Received).not.toContainEqual(expect.objectContaining({ t: 'cdp.req', id: 42 }));
  });
});
