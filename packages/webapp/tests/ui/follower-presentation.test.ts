/**
 * The shared follower vocabulary used by the Monitor panel, the floatbar HUD
 * and the sync dialog's Status tab. Pure — `now` is injected so the elapsed
 * formatting doesn't race the clock.
 */

import { describe, expect, it } from 'vitest';
import type { ConnectedFollowerInfo } from '../../src/shell/supplemental-commands/host-command.js';
import {
  elapsedSince,
  followerCapabilities,
  followerDetail,
  followerIcon,
  followerMeta,
  followerStatus,
  followerTitle,
  followerTypeLabel,
  shortFollowerId,
  toFollowerHudRows,
} from '../../src/ui/follower-presentation.js';

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function follower(overrides: Partial<ConnectedFollowerInfo> = {}): ConnectedFollowerInfo {
  return {
    runtimeId: 'follower-abcdef012345678',
    health: 'live',
    peerState: 'connected',
    ...overrides,
  };
}

describe('shortFollowerId', () => {
  it('drops the follower- prefix', () => {
    expect(shortFollowerId('follower-abc')).toBe('abc');
  });

  it('truncates anything longer than 12 characters', () => {
    expect(shortFollowerId('follower-abcdef012345678')).toBe('abcdef01…');
  });

  it('leaves an exactly-12-character id intact', () => {
    expect(shortFollowerId('follower-abcdef012345')).toBe('abcdef012345');
  });
});

describe('followerTypeLabel', () => {
  it('names each browser-ish float type', () => {
    expect(followerTypeLabel(follower({ floatType: 'ios' }))).toBe('iOS');
    expect(followerTypeLabel(follower({ floatType: 'electron' }))).toBe('Electron');
    expect(followerTypeLabel(follower({ floatType: 'extension' }))).toBe('Extension');
    expect(followerTypeLabel(follower({ floatType: 'standalone' }))).toBe('Standalone');
  });

  it('recognises the CLI from its runtime tag, which derives no float type', () => {
    expect(followerTypeLabel(follower({ runtime: 'slicc-cli' }))).toBe('CLI');
  });

  it('falls back to a generic name for an unknown runtime', () => {
    expect(followerTypeLabel(follower({ runtime: 'something-else' }))).toBe('Follower');
    expect(followerTypeLabel(follower())).toBe('Follower');
  });
});

describe('followerIcon', () => {
  it('gives each kind its own glyph', () => {
    expect(followerIcon(follower({ floatType: 'ios' }))).toBe('smartphone');
    expect(followerIcon(follower({ floatType: 'electron' }))).toBe('monitor');
    expect(followerIcon(follower({ floatType: 'standalone' }))).toBe('monitor');
    expect(followerIcon(follower({ floatType: 'extension' }))).toBe('blocks');
    expect(followerIcon(follower({ runtime: 'slicc-cli' }))).toBe('terminal');
    expect(followerIcon(follower())).toBe('radio');
  });
});

describe('elapsedSince', () => {
  it('scales the unit with the age', () => {
    expect(elapsedSince(ago(5_000), NOW)).toBe('5s');
    expect(elapsedSince(ago(4 * 60_000), NOW)).toBe('4m');
    expect(elapsedSince(ago(3 * 3_600_000), NOW)).toBe('3h');
    expect(elapsedSince(ago(2 * 86_400_000), NOW)).toBe('2d');
  });

  it('clamps a future timestamp to zero rather than printing a negative age', () => {
    expect(elapsedSince(new Date(NOW + 60_000).toISOString(), NOW)).toBe('0s');
  });

  it('returns null for a missing or unparseable timestamp', () => {
    expect(elapsedSince(undefined, NOW)).toBeNull();
    expect(elapsedSince('not a date', NOW)).toBeNull();
  });
});

describe('followerStatus', () => {
  it('flags a stalled follower as a warning even while its peer reads connected', () => {
    expect(followerStatus(follower({ health: 'stalled' }))).toBe('warn');
  });

  it('treats a handshaking peer as idle', () => {
    expect(followerStatus(follower({ peerState: 'connecting' }))).toBe('idle');
  });

  it('is active only when the peer is connected and the channel is live', () => {
    expect(followerStatus(follower())).toBe('active');
    expect(followerStatus(follower({ health: undefined }))).toBe('idle');
  });
});

describe('followerMeta', () => {
  it('pairs the state with the age', () => {
    expect(followerMeta(follower({ connectedAt: ago(4 * 60_000) }), NOW)).toBe('connected 4m');
    expect(followerMeta(follower({ health: 'stalled', connectedAt: ago(60_000) }), NOW)).toBe(
      'stalled 1m'
    );
    expect(followerMeta(follower({ peerState: 'connecting' }), NOW)).toBe('connecting');
  });
});

describe('followerCapabilities', () => {
  it('leads with the one that grants code execution', () => {
    expect(followerCapabilities(follower({ exec: true, cdp: true }))).toEqual([
      'can run commands',
      'hosts tabs',
    ]);
  });

  it('claims nothing for a plain follower', () => {
    expect(followerCapabilities(follower())).toEqual([]);
  });
});

describe('followerTitle / followerDetail', () => {
  it('joins the kind and the short id', () => {
    expect(followerTitle(follower({ floatType: 'ios', runtimeId: 'follower-phone1' }))).toBe(
      'iOS · phone1'
    );
  });

  it('prefers the advertised MOTD over the runtime tag', () => {
    expect(followerDetail(follower({ runtime: 'slicc-cli', motd: 'lars@build-box' }))).toBe(
      'lars@build-box'
    );
    expect(followerDetail(follower({ runtime: 'slicc-cli' }))).toBe('slicc-cli');
    expect(followerDetail(follower())).toBeUndefined();
  });
});

describe('toFollowerHudRows', () => {
  it('maps the roster onto presentational rows keyed by runtime id', () => {
    const rows = toFollowerHudRows(
      [
        follower({
          runtimeId: 'follower-cli1',
          runtime: 'slicc-cli',
          exec: true,
          motd: 'lars@build-box',
          connectedAt: ago(120_000),
        }),
      ],
      NOW
    );
    expect(rows).toEqual([
      {
        id: 'follower-cli1',
        icon: 'terminal',
        title: 'CLI · cli1',
        detail: 'lars@build-box',
        state: 'active',
        stateText: 'connected 2m',
        chips: ['can run commands'],
      },
    ]);
  });

  it('maps an empty roster to no rows', () => {
    expect(toFollowerHudRows([], NOW)).toEqual([]);
  });
});
