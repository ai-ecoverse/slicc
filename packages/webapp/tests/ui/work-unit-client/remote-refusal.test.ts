/**
 * `RemoteWorkUnitClient` over a data channel that REFUSES the frame (#2382).
 *
 * `TraySyncChannel.send` answers `false` for a closed or closing channel, and
 * `FollowerSyncManager` used to swallow that: the adapter resolved, so a
 * refused send looked exactly like a delivered one to the composer — which had
 * already rendered the bubble and cleared the input. There is no local
 * analogue (the kernel port is fire-and-forget behind an attached client), so
 * this lives outside the conformance suite.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import { RemoteWorkUnitClient } from '../../../src/ui/work-unit-client/remote.js';

function makeClient(accepted: boolean): {
  client: RemoteWorkUnitClient;
  sendMessage: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(() => accepted);
  const stop = vi.fn(() => accepted);
  const sync = { selectScoop: vi.fn(), sendMessage, stop } as unknown as FollowerSyncManager;
  return { client: new RemoteWorkUnitClient({ getSync: () => sync }), sendMessage, stop };
}

describe('RemoteWorkUnitClient over a refusing channel', () => {
  it('rejects a send the channel would not take', async () => {
    const { client, sendMessage } = makeClient(false);

    await expect(client.send('cone_1', { text: 'go' })).rejects.toThrow(/refused the message/);

    // The frame was attempted — the refusal is the transport's answer, not a
    // pre-flight guess about whether it would work.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a stop the channel would not take', async () => {
    const { client, stop } = makeClient(false);

    await expect(client.signal('cone_1', 'stop')).rejects.toThrow(/refused the abort/);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('resolves both once the channel accepts', async () => {
    const { client } = makeClient(true);

    await expect(client.send('cone_1', { text: 'go' })).resolves.toBeUndefined();
    await expect(client.signal('cone_1', 'stop')).resolves.toBeUndefined();
  });

  it('rejects a stop with no leader at all rather than reporting one', async () => {
    const client = new RemoteWorkUnitClient({ getSync: () => null });

    await expect(client.signal('cone_1', 'stop')).rejects.toThrow(/not connected/);
  });
});
