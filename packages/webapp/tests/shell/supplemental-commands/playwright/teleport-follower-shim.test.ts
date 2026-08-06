import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectedFollowerInfo,
  setConnectedFollowersGetter,
} from '../../../../src/shell/supplemental-commands/host-command.js';
import {
  resolveConnectedFollowers,
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from '../../../../src/shell/supplemental-commands/playwright/teleport.js';
import {
  selectBestFollowerFromShim,
  wireTeleportSelectionFromShim,
} from '../../../../src/shell/supplemental-commands/playwright/teleport-follower-shim.js';

function follower(overrides: Partial<ConnectedFollowerInfo>): ConnectedFollowerInfo {
  return {
    runtimeId: 'runtime',
    bootstrapId: 'bootstrap',
    floatType: 'standalone',
    teleportEligible: true,
    lastActivity: 0,
    ...overrides,
  };
}

describe('selectBestFollowerFromShim', () => {
  it('returns null when no follower is teleport-eligible', () => {
    expect(selectBestFollowerFromShim([])).toBeNull();
    expect(
      selectBestFollowerFromShim([
        follower({ teleportEligible: false }),
        // Entries from older leaders lack the field entirely — not eligible.
        follower({ runtimeId: 'r2', bootstrapId: 'b2', teleportEligible: undefined }),
        // A malformed entry without bootstrapId cannot be addressed.
        follower({ runtimeId: 'r3', bootstrapId: undefined }),
      ])
    ).toBeNull();
  });

  it('prefers standalone floats and breaks ties by most recent activity', () => {
    const picked = selectBestFollowerFromShim([
      follower({
        runtimeId: 'ext',
        bootstrapId: 'b-ext',
        floatType: 'extension',
        lastActivity: 900,
      }),
      follower({ runtimeId: 'sa-old', bootstrapId: 'b-old', lastActivity: 10 }),
      follower({ runtimeId: 'sa-new', bootstrapId: 'b-new', lastActivity: 20 }),
    ]);
    expect(picked).toEqual({ runtimeId: 'sa-new', bootstrapId: 'b-new', floatType: 'standalone' });
  });

  it('falls back to non-standalone floats when no standalone follower exists', () => {
    const picked = selectBestFollowerFromShim([
      follower({ runtimeId: 'ext', bootstrapId: 'b-ext', floatType: 'extension', lastActivity: 5 }),
      follower({ runtimeId: 'ios', bootstrapId: 'b-ios', floatType: 'ios', lastActivity: 50 }),
    ]);
    expect(picked).toEqual({ runtimeId: 'ios', bootstrapId: 'b-ios', floatType: 'ios' });
  });
});

describe('wireTeleportSelectionFromShim', () => {
  const globalWithStorage = globalThis as { localStorage?: Pick<Storage, 'getItem'> };
  let savedLocalStorage: Pick<Storage, 'getItem'> | undefined;

  beforeEach(() => {
    savedLocalStorage = globalWithStorage.localStorage;
    setConnectedFollowersGetter(null);
  });

  afterEach(() => {
    globalWithStorage.localStorage = savedLocalStorage;
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
    setConnectedFollowersGetter(null);
  });

  it('serves follower selection from the localStorage shim in the worker realm', () => {
    const roster = [
      follower({ runtimeId: 'sa', bootstrapId: 'b-sa', lastActivity: 7 }),
      follower({
        runtimeId: 'cli',
        bootstrapId: 'b-cli',
        floatType: 'unknown',
        teleportEligible: false,
      }),
    ];
    globalWithStorage.localStorage = {
      getItem: vi.fn((key: string) =>
        key === 'slicc.leaderTrayFollowers' ? JSON.stringify(roster) : null
      ),
    };

    wireTeleportSelectionFromShim();

    const getFollowers = resolveConnectedFollowers();
    expect(getFollowers?.().map((f) => f.runtimeId)).toEqual(['sa', 'cli']);
  });
});
