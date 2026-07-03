import { describe, expect, it } from 'vitest';
import { makeTrayWithConnectedLeader } from './preview-bridge-harness.js';

const upgrade = { Upgrade: 'websocket', origin: 'https://x.sliccy.now', 'user-agent': 'UA' };

describe('handleBridgeWebSocket', () => {
  it('accepts a bridged token and notifies the leader', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, maxTabs: 2 });
    const res = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(res.status).toBe(101);
    expect(h.leaderSent.some((m) => m.type === 'bridge.connected')).toBe(true);
  });

  it('rejects a non-bridged token with 403', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: false });
    const res = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(res.status).toBe(403);
  });

  it('rejects over the maxTabs cap', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, maxTabs: 1 });
    const first = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(first.status).toBe(101);
    const second = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(second.status).toBe(429);
  });
});
