// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  setFollowerStalled,
  setFollowerTrayRuntimeStatus,
} from '../../../src/scoops/tray-follower-status.js';
import { setLeaderTrayRuntimeStatus } from '../../../src/scoops/tray-leader.js';
import { installFloatbarOnline } from '../../../src/ui/wc/wc-floatbar-online.js';

const INACTIVE_FOLLOWER = {
  state: 'inactive' as const,
  joinUrl: null,
  trayId: null,
  error: null,
  lastPingTime: null,
  reconnectAttempts: 0,
  attachAttempts: 0,
  lastAttachCode: null,
  connectingSince: null,
  lastError: null,
};

function followerStatus(state: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'error') {
  return { ...INACTIVE_FOLLOWER, state };
}

describe('installFloatbarOnline (#1707)', () => {
  let floatbar: HTMLElement;

  beforeEach(() => {
    // Reset both module-global statuses so test order can't leak state.
    setFollowerTrayRuntimeStatus(followerStatus('inactive'));
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
    floatbar = document.createElement('div');
  });

  it('seeds the current state on install (already-connected follower lights the dot)', () => {
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    const uninstall = installFloatbarOnline(floatbar);
    expect(floatbar.hasAttribute('online')).toBe(true);
    uninstall();
  });

  it('lights the dot when the follower connects and clears it on error/reconnecting', () => {
    const uninstall = installFloatbarOnline(floatbar);
    expect(floatbar.hasAttribute('online')).toBe(false);

    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    expect(floatbar.hasAttribute('online')).toBe(true);

    // The exact regression from #1707: a transient drop must read offline…
    setFollowerTrayRuntimeStatus(followerStatus('error'));
    expect(floatbar.hasAttribute('online')).toBe(false);
    setFollowerTrayRuntimeStatus(followerStatus('reconnecting'));
    expect(floatbar.hasAttribute('online')).toBe(false);

    // …and recovery must light it again without any manual action.
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    expect(floatbar.hasAttribute('online')).toBe(true);
    uninstall();
  });

  it('keeps the dot lit through a leader stall (stalled is still connected)', () => {
    const uninstall = installFloatbarOnline(floatbar);
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    setFollowerStalled(true);
    expect(floatbar.hasAttribute('online')).toBe(true);
    setFollowerStalled(false);
    expect(floatbar.hasAttribute('online')).toBe(true);
    uninstall();
  });

  it('lights the dot while leading a tray and clears it when the tray goes inactive', () => {
    const uninstall = installFloatbarOnline(floatbar);
    setLeaderTrayRuntimeStatus({ state: 'leader', session: null, error: null });
    expect(floatbar.hasAttribute('online')).toBe(true);
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
    expect(floatbar.hasAttribute('online')).toBe(false);
    uninstall();
  });

  it('either role alone keeps the dot lit (leader OR follower link)', () => {
    const uninstall = installFloatbarOnline(floatbar);
    setLeaderTrayRuntimeStatus({ state: 'leader', session: null, error: null });
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    // Dropping one role while the other is live must not clear the dot.
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
    expect(floatbar.hasAttribute('online')).toBe(true);
    uninstall();
  });

  it('uninstall stops driving the attribute', () => {
    const uninstall = installFloatbarOnline(floatbar);
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    expect(floatbar.hasAttribute('online')).toBe(true);
    uninstall();
    setFollowerTrayRuntimeStatus(followerStatus('error'));
    // No longer subscribed — attribute stays as-is after uninstall.
    expect(floatbar.hasAttribute('online')).toBe(true);
  });
});
