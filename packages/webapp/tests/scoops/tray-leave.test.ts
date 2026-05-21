import { describe, it, expect } from 'vitest';
import { leaveTray } from '../../src/scoops/tray-leave.js';
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

describe('leaveTray — offscreen-hook transport', () => {
  it('clears both storage keys and calls the hook with both nulls when leaving entirely', async () => {
    const storage = makeStorage({
      [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
      [TRAY_WORKER_STORAGE_KEY]: 'https://x',
    });
    const calls: Array<[string | null, string | null]> = [];
    await leaveTray(
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
    expect(storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
    expect(calls).toEqual([[null, null]]);
  });

  it('rewrites the worker key when switching to leader on a new URL', async () => {
    const storage = makeStorage({
      [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
      [TRAY_WORKER_STORAGE_KEY]: 'https://x',
    });
    await leaveTray(
      { workerBaseUrl: 'https://y' },
      {
        storage,
        wire: { kind: 'offscreen-hook', setTrayRuntime: async () => {} },
      }
    );
    expect(storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://y');
  });
});

describe('leaveTray — extension-panel transport', () => {
  it('relays a refresh-tray-runtime envelope with joinUrl:null', async () => {
    const sent: unknown[] = [];
    await leaveTray(
      { workerBaseUrl: 'https://leader.example.com' },
      {
        storage: makeStorage(),
        wire: {
          kind: 'extension-panel',
          sendMessage: (msg) => {
            sent.push(msg);
          },
        },
      }
    );
    expect(sent).toEqual([
      {
        source: 'panel',
        payload: {
          type: 'refresh-tray-runtime',
          joinUrl: null,
          workerBaseUrl: 'https://leader.example.com',
        },
      },
    ]);
  });

  it('awaits the sendMessage promise', async () => {
    let resolved = false;
    await leaveTray(
      {},
      {
        storage: makeStorage(),
        wire: {
          kind: 'extension-panel',
          sendMessage: async () => {
            await new Promise<void>((r) => setTimeout(r, 5));
            resolved = true;
          },
        },
      }
    );
    expect(resolved).toBe(true);
  });
});

describe('leaveTray — standalone-worker transport (panel-RPC)', () => {
  it('calls panelRpcClient.call with the right op and payload', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    await leaveTray(
      { workerBaseUrl: 'https://w', requestId: 'req-1' },
      {
        storage: makeStorage(),
        wire: {
          kind: 'standalone-worker',
          panelRpcClient: {
            call: async (op, payload) => {
              calls.push({ op, payload });
              return undefined;
            },
          },
        },
      }
    );
    expect(calls).toEqual([
      { op: 'tray-leave', payload: { workerBaseUrl: 'https://w', requestId: 'req-1' } },
    ]);
  });

  it('forwards requestId on a leave-entirely call', async () => {
    const calls: Array<unknown> = [];
    await leaveTray(
      { requestId: 'corr-123' },
      {
        storage: makeStorage(),
        wire: {
          kind: 'standalone-worker',
          panelRpcClient: {
            call: async (_op, payload) => {
              calls.push(payload);
              return undefined;
            },
          },
        },
      }
    );
    expect(calls).toEqual([{ workerBaseUrl: null, requestId: 'corr-123' }]);
  });
});

describe('leaveTray — standalone-page transport (window event)', () => {
  it('dispatches a slicc:tray-leave event with detail', async () => {
    const events: Array<Event> = [];
    await leaveTray(
      { workerBaseUrl: null, requestId: 'r-7' },
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
    expect(event.type).toBe('slicc:tray-leave');
    expect(event.detail).toEqual({ workerBaseUrl: null, requestId: 'r-7' });
  });
});

describe('leaveTray — error and edge paths', () => {
  it('throws when transport.wire is null so worker callers see a clear error', async () => {
    await expect(leaveTray({}, { wire: null, storage: makeStorage() })).rejects.toThrow(
      /no transport available/
    );
  });

  it('still updates storage before throwing on no-transport (best-effort cleanup)', async () => {
    const storage = makeStorage({
      [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
      [TRAY_WORKER_STORAGE_KEY]: 'https://x',
    });
    await expect(leaveTray({}, { wire: null, storage })).rejects.toThrow();
    expect(storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
  });

  it('survives a sandboxed storage that throws on writes', async () => {
    const storage: FakeStorage = {
      data: new Map(),
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('storage denied');
      },
    };
    let hookCalled = false;
    await leaveTray(
      {},
      {
        storage,
        wire: {
          kind: 'offscreen-hook',
          setTrayRuntime: async () => {
            hookCalled = true;
          },
        },
      }
    );
    expect(hookCalled).toBe(true);
  });
});
