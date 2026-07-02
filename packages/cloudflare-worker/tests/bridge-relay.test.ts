import { describe, expect, it } from 'vitest';
import { makeTrayWithConnectedLeader } from './preview-bridge-harness.js';

describe('bridge role routing and relay', () => {
  it('relays cdp.request from leader to the right bridge socket and cdp.res back', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    // Leader → bridge: send a CDP request
    await h.deliverLeaderMessage({
      type: 'bridge.cdp.request',
      connId: bridgeWs.connId,
      id: 7,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
    });

    // Bridge socket should receive the CDP request
    const receivedMessages = bridgeWs.ws.received.map((msg) => JSON.parse(msg));
    expect(receivedMessages).toContainEqual(
      expect.objectContaining({ t: 'cdp.req', id: 7, method: 'Runtime.evaluate' })
    );

    // Bridge → leader: send a CDP response
    await h.deliverBridgeMessage(bridgeWs, {
      t: 'cdp.res',
      id: 7,
      result: { value: 1 },
    });

    // Leader should receive the CDP response
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.cdp.response',
        connId: bridgeWs.connId,
        id: 7,
        result: { value: 1 },
      })
    );
  });

  it('relays cdp.evt from bridge to leader', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    // Bridge → leader: send a CDP event
    await h.deliverBridgeMessage(bridgeWs, {
      t: 'cdp.evt',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: ['hello'] },
    });

    // Leader should receive the CDP event
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.cdp.event',
        connId: bridgeWs.connId,
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: ['hello'] },
      })
    );
  });

  it('emits bridge.disconnected on bridge socket close', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    await h.closeBridge(bridgeWs);

    // Leader should receive the disconnect notification
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

    // A bridged preview page is UNTRUSTED third-party content. A non-JSON frame
    // must be dropped, not thrown out of the hibernatable webSocketMessage handler
    // (which would reset the DO and tear down the tray + every other bridge tab).
    await expect(
      h.do.webSocketMessage(bridgeWs.serverWs as never, 'not-json{')
    ).resolves.toBeUndefined();

    // The socket survived: a subsequent valid cdp.res still relays to the leader.
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

  it('routes cdp.request to the correct bridge socket by connId', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, maxTabs: 5 });
    const bridge1 = await h.openBridge();
    const bridge2 = await h.openBridge();

    // Send request to bridge2
    await h.deliverLeaderMessage({
      type: 'bridge.cdp.request',
      connId: bridge2.connId,
      id: 42,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });

    // Only bridge2 should receive the request
    const bridge2Received = bridge2.ws.received.map((msg) => JSON.parse(msg));
    const bridge1Received = bridge1.ws.received.map((msg) => JSON.parse(msg));
    expect(bridge2Received).toContainEqual(
      expect.objectContaining({ t: 'cdp.req', id: 42, method: 'Page.navigate' })
    );
    expect(bridge1Received).not.toContainEqual(expect.objectContaining({ t: 'cdp.req', id: 42 }));
  });
});
