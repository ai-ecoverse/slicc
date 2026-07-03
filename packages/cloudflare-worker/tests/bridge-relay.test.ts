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

  it('replays bridge.connected to a reconnected leader (survives leader reload)', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    // Leader reloads: its in-memory bridge map is gone, but the bridge socket
    // stays open. On reconnect the DO must replay bridge.connected so the tab is
    // driveable again.
    const replayed = await h.reconnectLeader();

    expect(replayed).toContainEqual(
      expect.objectContaining({ type: 'bridge.connected', connId: bridgeWs.connId })
    );
  });

  it('closes the bridge socket and notifies the leader on bridge.close', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();

    // Leader issued Target.closeTarget on the preview target.
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

  it('synthesizes an error cdp.response when the target bridge connection is gone', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    // No bridge socket exists for this connId (tab already closed / revoked).
    await h.deliverLeaderMessage({
      type: 'bridge.cdp.request',
      connId: 'ghost-conn',
      id: 99,
      method: 'Runtime.evaluate',
      params: {},
    });
    // The leader gets an immediate error instead of burning the full CDP timeout.
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
