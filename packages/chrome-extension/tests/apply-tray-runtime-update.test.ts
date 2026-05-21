import { describe, it, expect } from 'vitest';
import { applyTrayRuntimeUpdate } from '../src/apply-tray-runtime-update.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../webapp/src/scoops/tray-runtime-config.js';

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

interface TestDeps {
  storage: FakeStorage;
  stopCalls: number;
  resetCalls: number;
  syncCalls: number;
  spec: Parameters<typeof applyTrayRuntimeUpdate>[2];
}

function makeDeps(initial: Record<string, string> = {}): TestDeps {
  const storage = makeStorage(initial);
  const deps: TestDeps = {
    storage,
    stopCalls: 0,
    resetCalls: 0,
    syncCalls: 0,
    // `spec` references the deps object itself so mutations from
    // `applyTrayRuntimeUpdate` flow back to the test-visible counters.
    spec: {
      storage,
      stopTrayRuntime: () => {
        deps.stopCalls += 1;
      },
      resetTrayRuntimeKey: () => {
        deps.resetCalls += 1;
      },
      syncTrayRuntime: async () => {
        deps.syncCalls += 1;
      },
    },
  };
  return deps;
}

describe('applyTrayRuntimeUpdate', () => {
  describe('leave-entirely short-circuit (both args null)', () => {
    it('clears both storage keys and calls stopTrayRuntime WITHOUT awaiting syncTrayRuntime', async () => {
      // Regression test: letting `syncTrayRuntime` re-run when both
      // keys are cleared causes `resolveTrayRuntimeConfig` to fall back
      // to `defaultWorkerBaseUrl` and silently re-enter leader mode on
      // the default worker. The short-circuit prevents that.
      const deps = makeDeps({
        [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
        [TRAY_WORKER_STORAGE_KEY]: 'https://x',
      });
      await applyTrayRuntimeUpdate(null, null, deps.spec);
      expect(deps.storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
      expect(deps.storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
      // syncTrayRuntime MUST NOT run on a full clear.
      expect(deps.syncCalls).toBe(0);
      // stop ran exactly once, key was reset.
      expect(deps.stopCalls).toBe(1);
      expect(deps.resetCalls).toBe(1);
    });
  });

  describe('selective update semantics', () => {
    it('writes a non-empty join URL and falls through to syncTrayRuntime', async () => {
      const deps = makeDeps();
      await applyTrayRuntimeUpdate('https://x/join/abc', undefined, deps.spec);
      expect(deps.storage.data.get(TRAY_JOIN_STORAGE_KEY)).toBe('https://x/join/abc');
      // workerBaseUrl is undefined → key untouched.
      expect(deps.storage.data.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
      // Not a full-clear, so sync runs.
      expect(deps.syncCalls).toBe(1);
      expect(deps.stopCalls).toBe(0);
    });

    it('writes a worker URL on its own without clearing the join key', async () => {
      const deps = makeDeps({ [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc' });
      await applyTrayRuntimeUpdate(undefined, 'https://new.example', deps.spec);
      // Join key preserved.
      expect(deps.storage.data.get(TRAY_JOIN_STORAGE_KEY)).toBe('https://x/join/abc');
      expect(deps.storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://new.example');
      expect(deps.syncCalls).toBe(1);
    });

    it('clears the join key when joinUrl=null but workerBaseUrl=undefined (worker key untouched)', async () => {
      const deps = makeDeps({
        [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
        [TRAY_WORKER_STORAGE_KEY]: 'https://x',
      });
      await applyTrayRuntimeUpdate(null, undefined, deps.spec);
      expect(deps.storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
      // Worker key MUST stay — only the joint (null, null) case clears it.
      expect(deps.storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://x');
      expect(deps.syncCalls).toBe(1);
      // No short-circuit because workerBaseUrl wasn't null.
      expect(deps.stopCalls).toBe(0);
    });

    it('joinUrl=null + workerBaseUrl=string is the role-switch case (clear join, set worker)', async () => {
      const deps = makeDeps({
        [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc',
        [TRAY_WORKER_STORAGE_KEY]: 'https://x',
      });
      await applyTrayRuntimeUpdate(null, 'https://new.example', deps.spec);
      expect(deps.storage.data.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
      expect(deps.storage.data.get(TRAY_WORKER_STORAGE_KEY)).toBe('https://new.example');
      // Not a full-clear; sync runs to start the new leader.
      expect(deps.syncCalls).toBe(1);
      expect(deps.stopCalls).toBe(0);
    });

    it('empty-string joinUrl is treated as "leave untouched", not as a write', async () => {
      const deps = makeDeps({ [TRAY_JOIN_STORAGE_KEY]: 'https://x/join/abc' });
      await applyTrayRuntimeUpdate('', undefined, deps.spec);
      // Empty string fails the `typeof === 'string' && joinUrl` guard
      // and doesn't match `=== null`, so key is untouched.
      expect(deps.storage.data.get(TRAY_JOIN_STORAGE_KEY)).toBe('https://x/join/abc');
    });
  });

  describe('async error propagation', () => {
    it('rejects when syncTrayRuntime rejects so callers can log the failure', async () => {
      const storage = makeStorage();
      let stopCalls = 0;
      let resetCalls = 0;
      await expect(
        applyTrayRuntimeUpdate(undefined, 'https://x', {
          storage,
          stopTrayRuntime: () => {
            stopCalls += 1;
          },
          resetTrayRuntimeKey: () => {
            resetCalls += 1;
          },
          syncTrayRuntime: async () => {
            throw new Error('resolver down');
          },
        })
      ).rejects.toThrow(/resolver down/);
      // Stop / reset should NOT have run on the non-leave path.
      expect(stopCalls).toBe(0);
      expect(resetCalls).toBe(0);
    });
  });
});
