// @vitest-environment jsdom
import '@slicc/webcomponents';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerStalled,
  setFollowerTrayRuntimeStatus,
} from '../../../src/scoops/tray-follower-status.js';
import { setLeaderTrayRuntimeStatus } from '../../../src/scoops/tray-leader.js';
import {
  installFloatbarOnline,
  installFloatbarStatus,
  mergeTrayStatus,
} from '../../../src/ui/wc/wc-floatbar-online.js';

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

describe('mergeTrayStatus', () => {
  it('prefers leader role while leading', () => {
    expect(
      mergeTrayStatus({ state: 'leader', session: null, error: null }, followerStatus('inactive'))
    ).toEqual({ connection: 'live', trayRole: 'leader' });
  });

  it('maps follower stalled overlay to stalled connection', () => {
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    setFollowerStalled(true);
    expect(
      mergeTrayStatus(
        { state: 'inactive', session: null, error: null },
        getFollowerTrayRuntimeStatus()
      )
    ).toEqual({ connection: 'stalled', trayRole: 'follower' });
    setFollowerStalled(false);
  });
});

describe('installFloatbarStatus', () => {
  let floatbar: HTMLElement;

  beforeEach(() => {
    setFollowerTrayRuntimeStatus(followerStatus('inactive'));
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
    floatbar = document.createElement('slicc-floatbar');
  });

  it('sets float kind, label, and status beacon attrs on install', () => {
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    const uninstall = installFloatbarStatus(floatbar, { floatKind: 'npx' });
    expect(floatbar.getAttribute('label')).toBe('npx');
    expect(floatbar.getAttribute('float-kind')).toBe('npx');
    expect(floatbar.getAttribute('connection')).toBe('live');
    expect(floatbar.getAttribute('tray-role')).toBe('follower');
    expect(floatbar.hasAttribute('online')).toBe(true);
    uninstall();
  });

  it('updates connection and tray role on leader transitions', () => {
    const uninstall = installFloatbarStatus(floatbar, { floatKind: 'extension' });
    expect(floatbar.getAttribute('connection')).toBe('offline');
    expect(floatbar.hasAttribute('tray-role')).toBe(false);

    setLeaderTrayRuntimeStatus({ state: 'leader', session: null, error: null });
    expect(floatbar.getAttribute('connection')).toBe('live');
    expect(floatbar.getAttribute('tray-role')).toBe('leader');

    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
    expect(floatbar.getAttribute('connection')).toBe('offline');
    expect(floatbar.hasAttribute('tray-role')).toBe(false);
    uninstall();
  });

  it('maps follower error/reconnecting to offline beacon states', () => {
    const uninstall = installFloatbarStatus(floatbar, { floatKind: 'npx' });
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    expect(floatbar.getAttribute('connection')).toBe('live');

    setFollowerTrayRuntimeStatus(followerStatus('error'));
    expect(floatbar.getAttribute('connection')).toBe('error');
    expect(floatbar.hasAttribute('online')).toBe(false);

    setFollowerTrayRuntimeStatus(followerStatus('reconnecting'));
    expect(floatbar.getAttribute('connection')).toBe('reconnecting');

    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    expect(floatbar.getAttribute('connection')).toBe('live');
    uninstall();
  });

  it('keeps live connection through a follower stall', () => {
    const uninstall = installFloatbarStatus(floatbar, { floatKind: 'npx' });
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    setFollowerStalled(true);
    expect(floatbar.getAttribute('connection')).toBe('stalled');
    expect(floatbar.hasAttribute('online')).toBe(true);
    setFollowerStalled(false);
    expect(floatbar.getAttribute('connection')).toBe('live');
    uninstall();
  });

  it('uninstall stops driving attrs', () => {
    const uninstall = installFloatbarStatus(floatbar, { floatKind: 'npx' });
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    expect(floatbar.getAttribute('connection')).toBe('live');
    uninstall();
    setFollowerTrayRuntimeStatus(followerStatus('error'));
    expect(floatbar.getAttribute('connection')).toBe('live');
  });
});

describe('installFloatbarOnline (legacy)', () => {
  it('defaults float kind to standalone', () => {
    setFollowerTrayRuntimeStatus(followerStatus('connected'));
    const floatbar = document.createElement('slicc-floatbar');
    installFloatbarOnline(floatbar);
    expect(floatbar.getAttribute('float-kind')).toBe('standalone');
    expect(floatbar.hasAttribute('online')).toBe(true);
  });
});
