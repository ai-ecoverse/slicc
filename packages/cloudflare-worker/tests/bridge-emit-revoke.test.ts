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

  it('closes bridge sockets on revoke', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true });
    const bridgeWs = await h.openBridge();
    await h.revokePreview(h.previewToken);
    expect(bridgeWs.closed).toBe(true);
  });
});
