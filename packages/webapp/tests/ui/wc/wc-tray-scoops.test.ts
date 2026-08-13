import type { ScoopSummary } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { toFollowerSwitcherScoops, toScoopSummaries } from '../../../src/ui/wc/wc-tray-scoops.js';

const cone = {
  jid: 'cone',
  name: 'sliccy',
  folder: 'cone',
  isCone: true,
  assistantLabel: 'sliccy',
};

/** The six states the wire can carry, in the order a turn walks them. */
const WIRE_STATES: NonNullable<ScoopSummary['state']>[] = [
  'thinking',
  'working',
  'awaiting',
  'idle',
  'broken',
  'initializing',
];

describe('tray scoop tab adapters', () => {
  it('collapses the leader toolbar three-field model onto the wire state', () => {
    const collapse = (rendered: Record<string, unknown>): string | undefined =>
      toScoopSummaries([cone], [{ key: 'cone', fill: 64, ...rendered } as never])[0]?.state;

    // A tool call in flight is the only thing that squares the eyes up.
    expect(collapse({ state: 'working', phase: 'tool' })).toBe('working');
    expect(collapse({ state: 'working', phase: 'thinking' })).toBe('thinking');
    // An unset phase reads as thinking: a turn always opens in LLM-wait, which
    // is what the leader's own tabs render too.
    expect(collapse({ state: 'working' })).toBe('thinking');
    expect(collapse({ state: 'idle', awaiting: true })).toBe('awaiting');
    expect(collapse({ state: 'idle' })).toBe('idle');
    expect(collapse({ state: 'broken' })).toBe('broken');
    expect(collapse({ state: 'initializing' })).toBe('initializing');
  });

  it('broadcasts the leader toolbar lifecycle state and context fill', () => {
    expect(
      toScoopSummaries([cone], [{ key: 'cone', state: 'working', phase: 'tool', fill: 64 }])
    ).toEqual([expect.objectContaining({ jid: 'cone', state: 'working', fill: 64 })]);
    expect(toScoopSummaries([cone], [])).toEqual([
      expect.objectContaining({ jid: 'cone', state: 'idle', fill: 0 }),
    ]);
  });

  it('expands every wire state back into follower descriptor fields', () => {
    const expand = (state: ScoopSummary['state']): Record<string, unknown> => {
      const [descriptor] = toFollowerSwitcherScoops([{ ...cone, state, fill: 40 }]);
      return { state: descriptor?.state, phase: descriptor?.phase, awaiting: descriptor?.awaiting };
    };

    expect(expand('thinking')).toMatchObject({ state: 'working', phase: 'thinking' });
    expect(expand('working')).toMatchObject({ state: 'working', phase: 'tool' });
    expect(expand('awaiting')).toMatchObject({ state: 'idle', awaiting: true });
    expect(expand('idle')).toMatchObject({ state: 'idle' });
    expect(expand('broken')).toMatchObject({ state: 'broken' });
    expect(expand('initializing')).toMatchObject({ state: 'initializing' });
  });

  it('round-trips every state, so leader and follower render the same face', () => {
    for (const state of WIRE_STATES) {
      const [descriptor] = toFollowerSwitcherScoops([{ ...cone, state, fill: 40 }]);
      const [summary] = toScoopSummaries([cone], [descriptor as never]);
      expect(summary?.state, `round trip broke for ${state}`).toBe(state);
    }
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

  it('keeps the new states open-eyed rather than dead or eyeless', () => {
    const descriptors = toFollowerSwitcherScoops([
      { ...cone, state: 'thinking' },
      { ...cone, jid: 'b', state: 'awaiting' },
    ]);
    expect(descriptors.map((descriptor) => descriptor.eyes)).toEqual(['open', 'open']);
  });

  it('defaults lifecycle state and fill from an older leader payload', () => {
    const [descriptor] = toFollowerSwitcherScoops([cone]);
    expect(descriptor).toMatchObject({ state: 'idle', fill: 0, eyes: 'open' });
  });

  it('normalizes a state from a newer leader instead of leaking it to the DOM', () => {
    // The browser's equivalent of iOS's `ScoopLifecycle` → `.unknown`: a state
    // this build does not know reads as idle, never as an unmatched
    // `data-state` attribute.
    const [descriptor] = toFollowerSwitcherScoops([
      { ...cone, state: 'daydreaming' as never, fill: 10 },
    ]);
    expect(descriptor).toMatchObject({ state: 'idle', eyes: 'open', fill: 10 });
    expect(descriptor?.phase).toBeUndefined();
    expect(descriptor?.awaiting).toBeUndefined();
  });
});
