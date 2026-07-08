import { describe, expect, it } from 'vitest';
import { leaveTray, resolveAmbientLeaveTrayTransport } from '../../src/scoops/tray-leave.js';
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

  it('clears both storage keys when leaving entirely', async () => {
    const storage = makeStorage({
      [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
      [TRAY_WORKER_STORAGE_KEY]: 'https://x',
    });
    await leaveTray(
      {},
      {
        storage,
        wire: {
          kind: 'standalone-page',
          dispatchEvent: () => true,
        },
      }
    );
    expect(storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
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
        wire: {
          kind: 'standalone-page',
          dispatchEvent: () => true,
        },
      }
    );
    expect(storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://y');
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
    const events: Array<Event> = [];
    await leaveTray(
      {},
      {
        storage,
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
  });
});

describe('resolveAmbientLeaveTrayTransport — chrome-like context regression', () => {
  it('resolves standalone-page when window exists, even with chrome.runtime.id set', () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: 'fake-ext-id', sendMessage: () => {} },
    };
    try {
      const transport = resolveAmbientLeaveTrayTransport();
      if (typeof window !== 'undefined') {
        expect(transport.wire).not.toBeNull();
        expect(transport.wire!.kind).toBe('standalone-page');
      } else {
        expect(transport.wire).toBeNull();
      }
    } finally {
      if (origChrome === undefined) {
        delete (globalThis as Record<string, unknown>).chrome;
      } else {
        (globalThis as Record<string, unknown>).chrome = origChrome;
      }
    }
  });
});
