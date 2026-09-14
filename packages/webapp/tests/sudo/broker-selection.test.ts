import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { CapabilityBroker } from '../../src/work-unit/capability/index.js';

const sentinel = (id: string) => ({
  requestApproval: vi.fn(() => new Promise<never>(() => {})),
  __id: id,
});

vi.mock('../../src/sudo/capability-gesture-broker.js', () => ({
  createCapabilityGestureSudoBroker: vi.fn(() => sentinel('capability-gesture')),
}));

vi.mock('../../src/sudo/tray-first-broker.js', () => ({
  createTrayFirstSudoBroker: vi.fn(
    (inner: { __id: string; requestApproval: (...args: unknown[]) => unknown }) => ({
      requestApproval: (...args: unknown[]) => inner.requestApproval(...args),
      __id: inner.__id,
      __trayFirst: true,
    })
  ),
}));

import { USER_SUDO_TIMEOUT_MS } from '../../src/sudo/approval-timeout.js';
import { createCapabilityGestureSudoBroker } from '../../src/sudo/capability-gesture-broker.js';
import { createSudoBroker } from '../../src/sudo/index.js';
import { createTrayFirstSudoBroker } from '../../src/sudo/tray-first-broker.js';

function fakeBroker(adapter: CapabilityBroker['adapter']): CapabilityBroker {
  return { adapter } as CapabilityBroker;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createSudoBroker composition', () => {
  it('wraps the injected broker as the raw gesture leg, never constructing its own transport', () => {
    const broker = fakeBroker('node-rest');
    createSudoBroker(broker);
    expect(createCapabilityGestureSudoBroker).toHaveBeenCalledTimes(1);
    expect((createCapabilityGestureSudoBroker as Mock).mock.calls[0]?.[0]).toBe(broker);
  });

  it('tray-first-wraps node-rest (#2062 — the OS dialog can still be preempted)', () => {
    createSudoBroker(fakeBroker('node-rest'));
    expect(createTrayFirstSudoBroker).toHaveBeenCalledTimes(1);
    expect((createTrayFirstSudoBroker as Mock).mock.calls[0]?.[0]).toMatchObject({
      __id: 'capability-gesture',
    });
  });

  it('tray-first-wraps connect too — it has no privileged surface, so the raw leg always denies, but tray-first can still preempt it', () => {
    createSudoBroker(fakeBroker('connect'));
    expect(createTrayFirstSudoBroker).toHaveBeenCalledTimes(1);
  });

  it('does NOT tray-first-wrap extension-direct — it already relays to the panel where the modal lives', () => {
    const broker = fakeBroker('extension-direct');
    const result = createSudoBroker(broker);
    expect(createTrayFirstSudoBroker).not.toHaveBeenCalled();

    void result;
  });

  it('does NOT tray-first-wrap extension-delegate either', () => {
    createSudoBroker(fakeBroker('extension-delegate'));
    expect(createTrayFirstSudoBroker).not.toHaveBeenCalled();
  });

  it('tray-first-wraps when no broker was ever injected (defensive: a tray follower may still be reachable)', () => {
    createSudoBroker(null);
    expect(createCapabilityGestureSudoBroker).toHaveBeenCalledWith(null);
    expect(createTrayFirstSudoBroker).toHaveBeenCalledTimes(1);
  });

  it('wraps the composed broker so an unanswered prompt times out', async () => {
    vi.useFakeTimers();
    try {
      const pending = createSudoBroker(fakeBroker('node-rest')).requestApproval({
        kind: 'command',
        detail: 'git push',
      });
      await vi.advanceTimersByTimeAsync(USER_SUDO_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user-timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
