import { describe, expect, it } from 'vitest';
import { joinTray } from '../../src/scoops/tray-join.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';

interface FakeStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  data: Map<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

const JOIN_URL = 'https://www.sliccy.ai/join/tray123.s3cr3t';

describe('joinTray — standalone-page transport (window event)', () => {
  it('dispatches a slicc:tray-join event with detail', async () => {
    const events: Array<Event> = [];
    await joinTray(
      JOIN_URL,
      { requestId: 'r-9' },
      {
        storage: makeStorage(),
        wire: {
          kind: 'standalone-page',
          dispatchEvent: (event) => {
            events.push(event);
            return true;
          },
        },
      }
    );
    expect(events).toHaveLength(1);
    const event = events[0] as CustomEvent;
    expect(event.type).toBe('slicc:tray-join');
    expect(event.detail).toEqual({ joinUrl: JOIN_URL, requestId: 'r-9' });
  });

  it('persists both storage keys', async () => {
    const storage = makeStorage();
    await joinTray(
      JOIN_URL,
      {},
      {
        storage,
        wire: {
          kind: 'standalone-page',
          dispatchEvent: () => true,
        },
      }
    );
    expect(storage.data.get(TRAY_JOIN_STORAGE_KEY)).toBe(JOIN_URL);
    expect(storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://www.sliccy.ai');
  });
});

describe('joinTray — error and edge paths', () => {
  it('throws when transport.wire is null so worker callers see a clear error', async () => {
    await expect(joinTray(JOIN_URL, {}, { wire: null, storage: makeStorage() })).rejects.toThrow(
      /no transport available/
    );
  });

  it('still persists both storage keys before throwing on no-transport', async () => {
    const storage = makeStorage();
    await expect(joinTray(JOIN_URL, {}, { wire: null, storage })).rejects.toThrow();
    expect(storage.data.get(TRAY_JOIN_STORAGE_KEY)).toBe(JOIN_URL);
    expect(storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://www.sliccy.ai');
  });

  it('throws on the standalone-worker wire (must route via panel-RPC)', async () => {
    await expect(
      joinTray(
        JOIN_URL,
        {},
        {
          storage: makeStorage(),
          wire: {
            kind: 'standalone-worker',
            panelRpcClient: { call: async () => undefined },
          } as never,
        }
      )
    ).rejects.toThrow(/panel-RPC tray-join/);
  });
});
