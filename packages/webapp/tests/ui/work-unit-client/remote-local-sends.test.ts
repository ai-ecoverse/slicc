/**
 * RemoteWorkUnitClient — a late wholesale snapshot must not drop this
 * follower's just-sent bubble (#3320).
 *
 * `createTranscriptWatch` / `createUnitWatcher` apply every snapshot via
 * `loadMessages`, which replaces the thread. The adapter reconciles first so
 * both follower mounts (wc-tray role and dedicated wc-follower) keep the
 * optimistic send until a snapshot that contains it arrives.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import {
  type FollowerCallbackSlice,
  RemoteWorkUnitClient,
} from '../../../src/ui/work-unit-client/remote.js';
import type {
  WorkUnitChatMessage,
  WorkUnitClientEvent,
} from '../../../src/work-unit/client/types.js';

function message(id: string, content = id): WorkUnitChatMessage {
  return { id, role: 'user', content, timestamp: 1 };
}

function idsOf(event: WorkUnitClientEvent | undefined): string[] {
  if (event?.type !== 'snapshot') return [];
  return event.snapshot.messages.map((entry) => entry.id);
}

function makeClient(accepted = true): {
  client: RemoteWorkUnitClient;
  emitSnapshot: (id: string, messages: WorkUnitChatMessage[]) => void;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(() => accepted);
  const sync = {
    selectScoop: vi.fn(),
    sendMessage,
    stop: vi.fn(() => true),
  } as unknown as FollowerSyncManager;
  const client = new RemoteWorkUnitClient({ getSync: () => sync });
  const options = client.wrapOptions({} as FollowerCallbackSlice);
  return {
    client,
    emitSnapshot: (id, messages) => {
      options.onSnapshot?.(messages as never, id);
    },
    sendMessage,
  };
}

describe('RemoteWorkUnitClient local-send reconcile (#3320)', () => {
  it('keeps an optimistic send when a stale snapshot lands after it', async () => {
    const { client, emitSnapshot } = makeClient();
    const events: WorkUnitClientEvent[] = [];
    emitSnapshot('cone_1', [message('old', 'hi')]);
    client.subscribe('cone_1', (event) => events.push(event));
    events.length = 0;

    await client.send('cone_1', { text: 'prompt', messageId: 'local-1' });
    emitSnapshot('cone_1', [message('old', 'hi')]);

    expect(idsOf(events.at(-1))).toEqual(['old', 'local-1']);
    const restored = events.at(-1);
    expect(restored?.type === 'snapshot' && restored.snapshot.messages.at(-1)).toMatchObject({
      id: 'local-1',
      role: 'user',
      content: 'prompt',
    });
  });

  it('does not duplicate once a later snapshot contains the prompt', async () => {
    const { client, emitSnapshot } = makeClient();
    const events: WorkUnitClientEvent[] = [];
    emitSnapshot('cone_1', [message('old', 'hi')]);
    client.subscribe('cone_1', (event) => events.push(event));

    await client.send('cone_1', { text: 'prompt', messageId: 'local-1' });
    emitSnapshot('cone_1', [message('old', 'hi')]);
    events.length = 0;
    emitSnapshot('cone_1', [message('old', 'hi'), message('local-1', 'prompt')]);

    expect(idsOf(events.at(-1))).toEqual(['old', 'local-1']);
  });

  it('survives resetSelection so a reconnect cannot drop the bubble', async () => {
    const { client, emitSnapshot } = makeClient();
    const events: WorkUnitClientEvent[] = [];
    emitSnapshot('cone_1', [message('old', 'hi')]);
    await client.send('cone_1', { text: 'prompt', messageId: 'local-1' });
    client.resetSelection();
    client.subscribe('cone_1', (event) => events.push(event));
    emitSnapshot('cone_1', [message('old', 'hi')]);

    expect(idsOf(events.at(-1))).toEqual(['old', 'local-1']);
  });

  it("does not put another unit's send onto this snapshot", async () => {
    const { client, emitSnapshot } = makeClient();
    const events: WorkUnitClientEvent[] = [];
    emitSnapshot('cone_1', [message('old')]);
    await client.send('cone_1', { text: 'for-1', messageId: 'for-1' });
    client.subscribe('cone_2', (event) => events.push(event));
    // Selecting B is what a tab click does; A's in-flight snapshot would be
    // dropped, and B's empty snapshot must not inherit A's unconfirmed send.
    void client.snapshot('cone_2').catch(() => undefined);
    emitSnapshot('cone_2', []);

    expect(idsOf(events.at(-1))).toEqual([]);
  });

  it('a refused send is still restored by a stale snapshot', async () => {
    const { client, emitSnapshot } = makeClient(false);
    const events: WorkUnitClientEvent[] = [];
    emitSnapshot('cone_1', [message('old')]);
    client.subscribe('cone_1', (event) => events.push(event));
    events.length = 0;

    await expect(client.send('cone_1', { text: 'nope', messageId: 'refused' })).rejects.toThrow(
      /refused the message/
    );
    emitSnapshot('cone_1', [message('old')]);

    expect(idsOf(events.at(-1))).toEqual(['old', 'refused']);
  });

  it('forgetLocalSends drops unconfirmed prompts so a new session stays empty', async () => {
    const { client, emitSnapshot } = makeClient();
    const events: WorkUnitClientEvent[] = [];
    emitSnapshot('cone_1', [message('old')]);
    await client.send('cone_1', { text: 'prompt', messageId: 'local-1' });
    client.forgetLocalSends();
    client.subscribe('cone_1', (event) => events.push(event));
    events.length = 0;
    emitSnapshot('cone_1', []);

    expect(idsOf(events.at(-1))).toEqual([]);
  });
});
