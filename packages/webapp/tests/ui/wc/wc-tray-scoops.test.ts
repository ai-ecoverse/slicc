import { describe, expect, it } from 'vitest';
import { toFollowerSwitcherScoops, toScoopSummaries } from '../../../src/ui/wc/wc-tray-scoops.js';

const cone = {
  jid: 'cone',
  name: 'sliccy',
  folder: 'cone',
  isCone: true,
  assistantLabel: 'sliccy',
};

describe('tray scoop tab adapters', () => {
  it('broadcasts the leader toolbar lifecycle state and context fill', () => {
    expect(toScoopSummaries([cone], [{ key: 'cone', state: 'working', fill: 64 }])).toEqual([
      expect.objectContaining({ jid: 'cone', state: 'working', fill: 64 }),
    ]);
    expect(toScoopSummaries([cone], [])).toEqual([
      expect.objectContaining({ jid: 'cone', state: 'idle', fill: 0 }),
    ]);
  });

  it('preserves lifecycle state and fill for follower and Cherry descriptors', () => {
    const descriptors = toFollowerSwitcherScoops([
      { ...cone, state: 'broken', fill: 82 },
      {
        ...cone,
        jid: 'research',
        name: 'research',
        isCone: false,
        state: 'initializing',
        fill: 12,
      },
    ]);

    expect(descriptors.map(({ state, fill, eyes }) => ({ state, fill, eyes }))).toEqual([
      { state: 'broken', fill: 82, eyes: 'dead' },
      { state: 'initializing', fill: 12, eyes: 'none' },
    ]);
  });

  it('defaults lifecycle state and fill from an older leader payload', () => {
    const [descriptor] = toFollowerSwitcherScoops([cone]);
    expect(descriptor).toMatchObject({ state: 'idle', fill: 0, eyes: 'open' });
  });
});
