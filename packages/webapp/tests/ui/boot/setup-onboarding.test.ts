// @vitest-environment jsdom
/**
 * Focused tests for the `runFirstRunDetection()` boot stage. The
 * detection internals (`detectWelcomeFirstRun`) have their own
 * coverage under `tests/scoops/welcome-detection.test.ts`; these
 * tests pin the stage-level contract:
 *
 *   - No-op when a tray-join URL is stored (follower instance).
 *   - On first-run, the dedup ledger is mutated AND persisted AND
 *     the orchestrator's `handleFirstRun()` is invoked.
 *   - A `'first-run'` entry already in the dedup ledger suppresses re-fire
 *     (trust the ledger over install-state — prevents restart re-welcomes).
 *   - A non-first-run detection result is a no-op against the
 *     orchestrator and the ledger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRAY_JOIN_STORAGE_KEY } from '../../../src/scoops/tray-runtime-config.js';
import { runFirstRunDetection } from '../../../src/ui/boot/setup-onboarding.js';
import type { OnboardingSetupDeps } from '../../../src/ui/boot/types.js';

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeFakeVfs(opts: { welcomedExists?: boolean }): OnboardingSetupDeps['vfs'] {
  return {
    exists: vi.fn(async (path: string) =>
      path === '/shared/.welcomed' ? (opts.welcomedExists ?? false) : false
    ),
  } as unknown as OnboardingSetupDeps['vfs'];
}

function makeFakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(() => {
  // Mock indexedDB.open so the chat-history check inside
  // `hasWelcomeLickInHistory` resolves to "no history" quickly.
  // jsdom ships a working IndexedDB but we want a deterministic
  // empty result here.
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const req: {
        onsuccess: ((this: unknown, ev: Event) => unknown) | null;
        onerror: ((this: unknown, ev: Event) => unknown) | null;
        onupgradeneeded: ((this: unknown, ev: Event) => unknown) | null;
        result: { transaction: () => unknown; close: () => void };
        error: null;
      } = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: {
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const r: {
                  onsuccess: ((this: unknown, ev: Event) => unknown) | null;
                  onerror: ((this: unknown, ev: Event) => unknown) | null;
                  result: null;
                } = { onsuccess: null, onerror: null, result: null };
                queueMicrotask(() => r.onsuccess?.call(r, {} as Event));
                return r;
              },
            }),
          }),
          close: () => {},
        },
        error: null,
      };
      queueMicrotask(() => req.onsuccess?.call(req, {} as Event));
      return req;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runFirstRunDetection', () => {
  it('is a no-op when a tray-join URL is stored', () => {
    const storage = makeFakeStorage({ [TRAY_JOIN_STORAGE_KEY]: 'https://tray.example/join' });
    const handleFirstRun = vi.fn();
    const persist = vi.fn();

    runFirstRunDetection({
      vfs: makeFakeVfs({}),
      storage,
      firedWelcomeActions: new Set(),
      persistFiredWelcomeActions: persist,
      getOrchestrator: () => ({ handleFirstRun }),
      log: silentLog,
    });

    // No detection promise — no observable side-effects.
    expect(handleFirstRun).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('records first-run + invokes the orchestrator on a fresh boot', async () => {
    const handleFirstRun = vi.fn();
    const persist = vi.fn();
    const set = new Set<string>();

    runFirstRunDetection({
      vfs: makeFakeVfs({ welcomedExists: false }),
      storage: makeFakeStorage(),
      firedWelcomeActions: set,
      persistFiredWelcomeActions: persist,
      getOrchestrator: () => ({ handleFirstRun }),
      log: silentLog,
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(set.has('first-run')).toBe(true);
    expect(persist).toHaveBeenCalledWith(set);
    expect(handleFirstRun).toHaveBeenCalledTimes(1);
  });

  it('suppresses re-fire when first-run is already in the dedup ledger', async () => {
    const handleFirstRun = vi.fn();
    const persist = vi.fn();
    // Simulate a restart: localStorage already has 'first-run' from the previous boot.
    const set = new Set<string>(['first-run']);

    runFirstRunDetection({
      vfs: makeFakeVfs({ welcomedExists: false }),
      storage: makeFakeStorage(),
      firedWelcomeActions: set,
      persistFiredWelcomeActions: persist,
      getOrchestrator: () => ({ handleFirstRun }),
      log: silentLog,
    });

    await new Promise((r) => setTimeout(r, 30));
    // The ledger entry was already present — no re-fire, no persist mutation.
    expect(handleFirstRun).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(set.has('first-run')).toBe(true); // entry untouched
  });

  it('no-ops the orchestrator + ledger when the welcomed marker exists', async () => {
    const handleFirstRun = vi.fn();
    const persist = vi.fn();
    const set = new Set<string>();

    runFirstRunDetection({
      vfs: makeFakeVfs({ welcomedExists: true }),
      storage: makeFakeStorage(),
      firedWelcomeActions: set,
      persistFiredWelcomeActions: persist,
      getOrchestrator: () => ({ handleFirstRun }),
      log: silentLog,
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(handleFirstRun).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(set.size).toBe(0);
  });
});
