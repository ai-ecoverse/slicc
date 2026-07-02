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
    // The real /__slicc/emit route forwards the raw sendBeacon text (a STRING),
    // e.g. window.slicc.emit('clicked', {id:3}) → '{"name":"clicked","detail":{"id":3}}'.
    // The cone's webhook lick must carry the parsed object, not the stringified blob.
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

  it('closes bridge sockets on revoke', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();
    await h.revokePreview(h.previewToken);
    expect(bridgeWs.closed).toBe(true);
  });
});
