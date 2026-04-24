import { describe, expect, it, vi } from 'vitest';

import {
  TabPersistenceGuard,
  type AudioContextLike,
  type LockManagerLike,
  type WindowLike,
} from '../../src/scoops/tab-persistence-guard.js';

function createFakeAudioContext() {
  const oscillator = { connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const gain = { connect: vi.fn(), gain: { value: 1 } };
  const ctx: AudioContextLike & { closed: boolean } = {
    state: 'running',
    closed: false,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async function (this: typeof ctx) {
      this.closed = true;
    }),
    createOscillator: () => oscillator,
    createGain: () => gain,
    destination: {},
  };
  return { ctx, oscillator, gain };
}

function createFakeLockManager() {
  const requests: Array<{ name: string; signal?: AbortSignal; resolved: boolean }> = [];
  const manager: LockManagerLike = {
    request: vi.fn().mockImplementation(async (name, options, callback) => {
      const entry = { name, signal: options.signal, resolved: false };
      requests.push(entry);
      try {
        await callback();
      } finally {
        entry.resolved = true;
      }
    }),
  };
  return { manager, requests };
}

function createFakeWindow(): WindowLike & { listeners: Array<() => void> } {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
}

describe('TabPersistenceGuard', () => {
  it('starts silent audio, holds a Web Lock, and registers beforeunload on activate', () => {
    const { ctx, oscillator, gain } = createFakeAudioContext();
    const { manager, requests } = createFakeLockManager();
    const win = createFakeWindow();

    const guard = new TabPersistenceGuard({
      audioContextFactory: () => ctx,
      lockManager: manager,
      windowRef: win,
    });

    guard.activate();

    expect(guard.isActive()).toBe(true);
    expect(oscillator.start).toHaveBeenCalledTimes(1);
    expect(gain.gain.value).toBe(0);
    expect(oscillator.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
    expect(requests).toHaveLength(1);
    expect(requests[0].name).toBe('slicc-tray-leader-active');
    expect(win.listeners).toHaveLength(1);
  });

  it('is idempotent — calling activate twice does not double up resources', () => {
    const { ctx, oscillator } = createFakeAudioContext();
    const { manager, requests } = createFakeLockManager();
    const win = createFakeWindow();

    const guard = new TabPersistenceGuard({
      audioContextFactory: () => ctx,
      lockManager: manager,
      windowRef: win,
    });

    guard.activate();
    guard.activate();

    expect(oscillator.start).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(win.listeners).toHaveLength(1);
  });

  it('releases all resources on deactivate', async () => {
    const { ctx, oscillator } = createFakeAudioContext();
    const { manager, requests } = createFakeLockManager();
    const win = createFakeWindow();

    const guard = new TabPersistenceGuard({
      audioContextFactory: () => ctx,
      lockManager: manager,
      windowRef: win,
    });

    guard.activate();
    guard.deactivate();

    // Allow microtasks to drain (lock release uses an abort signal).
    await Promise.resolve();
    await Promise.resolve();

    expect(guard.isActive()).toBe(false);
    expect(oscillator.stop).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(win.listeners).toHaveLength(0);
    expect(requests[0].signal?.aborted).toBe(true);
  });

  it('logs a warning and continues if AudioContext is unavailable', () => {
    const { manager } = createFakeLockManager();
    const win = createFakeWindow();
    const guard = new TabPersistenceGuard({
      audioContextFactory: () => null,
      lockManager: manager,
      windowRef: win,
    });

    expect(() => guard.activate()).not.toThrow();
    expect(guard.isActive()).toBe(true);
    expect(win.listeners).toHaveLength(1);
  });

  it('continues to function if Web Lock manager is unavailable', () => {
    const { ctx } = createFakeAudioContext();
    const win = createFakeWindow();
    const guard = new TabPersistenceGuard({
      audioContextFactory: () => ctx,
      lockManager: null,
      windowRef: win,
    });

    expect(() => guard.activate()).not.toThrow();
    expect(guard.isActive()).toBe(true);
    expect(win.listeners).toHaveLength(1);
  });

  it('deactivate() is safe when never activated', () => {
    const guard = new TabPersistenceGuard({
      audioContextFactory: () => null,
      lockManager: null,
      windowRef: null,
    });
    expect(() => guard.deactivate()).not.toThrow();
    expect(guard.isActive()).toBe(false);
  });

  it('releases the Web Lock immediately if the AbortSignal is already aborted when the callback runs', async () => {
    const { ctx } = createFakeAudioContext();

    // A LockManager that delays calling the callback by one microtask, giving
    // the test a window to abort the signal before the callback registers
    // its 'abort' listener. Without the already-aborted short-circuit in
    // acquireWebLock, the callback's promise would never resolve.
    const callbackInvoked = vi.fn();
    let callbackResolved = false;
    const manager: LockManagerLike = {
      request: async (_name, options, callback) => {
        await Promise.resolve();
        callbackInvoked();
        await callback();
        callbackResolved = true;
      },
    };

    const guard = new TabPersistenceGuard({
      audioContextFactory: () => ctx,
      lockManager: manager,
      windowRef: createFakeWindow(),
    });

    guard.activate();
    // Immediately deactivate — this aborts the controller before the
    // delayed manager callback runs.
    guard.deactivate();

    // Drain microtasks so the manager callback can run.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(callbackInvoked).toHaveBeenCalledTimes(1);
    expect(callbackResolved).toBe(true);
  });
});
