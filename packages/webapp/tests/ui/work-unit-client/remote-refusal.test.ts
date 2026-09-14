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
