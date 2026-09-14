import { describe, expect, it } from 'vitest';
import { makeTrayWithConnectedLeader } from './preview-bridge-harness.js';

describe('/internal/preview/emit and revocation socket close', () => {
  it('forwards /internal/preview/emit to the leader as webhook.event', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    await h.stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        body: JSON.stringify({
          previewToken: h.previewToken,
          body: { name: 'clicked', detail: { id: 3 } },
        }),
      })
    );
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'webhook.event',
        webhookId: 'wh1',
        body: { name: 'clicked', detail: { id: 3 } },
      })
    );
  });

  it('parses a JSON-string beacon body into an object before forwarding', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    await h.stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        body: JSON.stringify({
          previewToken: h.previewToken,
          body: JSON.stringify({ name: 'clicked', detail: { id: 3 } }),
        }),
      })
    );
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'webhook.event',
        webhookId: 'wh1',
        body: { name: 'clicked', detail: { id: 3 } },
      })
    );
  });

  it('keeps a non-JSON beacon body as a raw string', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    await h.stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        body: JSON.stringify({ previewToken: h.previewToken, body: 'plain text' }),
      })
    );
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({ type: 'webhook.event', webhookId: 'wh1', body: 'plain text' })
    );
  });

  it('rejects emit with 400 when the preview has no webhookId (non-bridged)', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: false });
    const res = await h.stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        body: JSON.stringify({ previewToken: h.previewToken, body: '{}' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('rejects emit with 404 for an unknown preview token', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    const res = await h.stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        body: JSON.stringify({ previewToken: 'nope.nonexistent', body: '{}' }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('routes an over-WS emit as an attributed webhook.event (connId + token headers)', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    const bridgeWs = await h.openBridge();
    await h.deliverBridgeMessage(bridgeWs, {
      t: 'emit',
      name: 'clicked',
      detail: { from: 'button' },
    });
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'webhook.event',
        webhookId: 'wh1',
        headers: expect.objectContaining({
          'x-slicc-preview-conn': bridgeWs.connId,
          'x-slicc-preview-token': h.previewToken,
        }),
        body: { name: 'clicked', detail: { from: 'button' } },
      })
    );
  });

  it('drops an over-WS emit (no webhook.event) when the bridged preview has no webhookId', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();
    await h.deliverBridgeMessage(bridgeWs, {
      t: 'emit',
      name: 'clicked',
      detail: { id: 3 },
    });
    const webhookEvents = h.leaderSent.filter(
      (m) => (m as { type?: string }).type === 'webhook.event'
    );
    expect(webhookEvents).toHaveLength(0);
  });

  it('closes bridge sockets on revoke', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();
    await h.revokePreview(h.previewToken);
    expect(bridgeWs.closed).toBe(true);
  });

  it('notifies the leader with bridge.disconnected on revoke (server-initiated close)', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();
    await h.revokePreview(h.previewToken);
    expect(h.leaderSent).toContainEqual(
      expect.objectContaining({ type: 'bridge.disconnected', connId: bridgeWs.connId })
    );
  });

  it('rate-limits window.slicc.emit() frames from one bridge connection', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    const bridgeWs = await h.openBridge();
    for (let i = 0; i < 25; i += 1) {
      await h.deliverBridgeMessage(bridgeWs, { t: 'emit', name: 'spam', detail: i });
    }
    const events = h.leaderSent.filter((m) => (m as { type?: string }).type === 'webhook.event');

    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(20);
  });

  it('drops an over-sized window.slicc.emit() frame', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
    const bridgeWs = await h.openBridge();
    await h.deliverBridgeMessage(bridgeWs, {
      t: 'emit',
      name: 'big',
      detail: 'x'.repeat(20_000),
    });
    const events = h.leaderSent.filter((m) => (m as { type?: string }).type === 'webhook.event');
    expect(events).toHaveLength(0);
  });
});
