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

describe('joinTray — offscreen-hook transport', () => {
  it('persists both storage keys and drives setTrayRuntime(joinUrl, null)', async () => {
    const storage = makeStorage();
    const calls: Array<[string | null, string | null]> = [];
    await joinTray(
      JOIN_URL,
      {},
      {
        storage,
        wire: {
          kind: 'offscreen-hook',
          setTrayRuntime: async (joinUrl, workerBaseUrl) => {
            calls.push([joinUrl, workerBaseUrl]);
          },
        },
      }
    );
    // Symmetric to leaveTray's two-key touch: join URL plus derived worker base.
    expect(storage.data.get(TRAY_JOIN_STORAGE_KEY)).toBe(JOIN_URL);
    expect(storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://www.sliccy.ai');
    expect(calls).toEqual([[JOIN_URL, null]]);
  });
});

describe('joinTray — extension-panel transport', () => {
  it('relays a refresh-tray-runtime envelope with the join URL and null worker', async () => {
    const envelopes: unknown[] = [];
    await joinTray(
      JOIN_URL,
      {},
      {
        storage: makeStorage(),
        wire: {
          kind: 'extension-panel',
          sendMessage: (envelope) => {
            envelopes.push(envelope);
          },
        },
      }
    );
    expect(envelopes).toEqual([
      {
        source: 'panel',
        payload: { type: 'refresh-tray-runtime', joinUrl: JOIN_URL, workerBaseUrl: null },
      },
    ]);
  });
});

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
            // The worker wire is never resolved for joins; guard for exhaustiveness.
            panelRpcClient: { call: async () => undefined },
          } as never,
        }
      )
    ).rejects.toThrow(/panel-RPC tray-join/);
  });
});
