import type { ScoopSummary } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { toFollowerSwitcherScoops, toScoopSummaries } from '../../../src/ui/wc/wc-tray-scoops.js';

const cone = {
  jid: 'cone',
  name: 'sliccy',
  folder: 'cone',
  isCone: true,
  parentJid: null,
  assistantLabel: 'sliccy',
};

/** Every state/activity pair the wire can carry. */
const WIRE_PAIRS: Pick<ScoopSummary, 'state' | 'activity'>[] = [
  { state: 'working', activity: 'thinking' },
  { state: 'working', activity: 'tool' },
  { state: 'idle', activity: 'awaiting' },
  { state: 'idle' },
  { state: 'broken' },
  { state: 'initializing' },
];

describe('tray scoop tab adapters', () => {
  it('keeps `state` to the four values every shipped follower switches on', () => {
    // THE compatibility invariant. An older follower reads `state` and nothing
    // else; if a refinement ever leaked into this field it would reach that
    // build's `data-state` unmatched and silently cost a busy agent its
    // animation. Detail belongs in `activity`, which older builds never read.
    const legacy = ['working', 'broken', 'initializing', 'idle'];
    const rendered = [
      { key: 'cone', state: 'working', phase: 'thinking' },
      { key: 'cone', state: 'working', phase: 'tool' },
      { key: 'cone', state: 'idle', awaiting: true },
      { key: 'cone', state: 'idle' },
      { key: 'cone', state: 'broken' },
      { key: 'cone', state: 'initializing' },
    ] as const;

    for (const descriptor of rendered) {
      const [summary] = toScoopSummaries([cone], [descriptor as never]);
      expect(legacy, `state leaked a refinement for ${JSON.stringify(descriptor)}`).toContain(
        summary?.state
      );
    }
  });

  it('collapses the toolbar model onto a legacy state plus an activity refinement', () => {
    const collapse = (rendered: Record<string, unknown>): Record<string, unknown> => {
      const [summary] = toScoopSummaries([cone], [{ key: 'cone', fill: 64, ...rendered } as never]);
      return { state: summary?.state, activity: summary?.activity };
    };

    // Busy stays `working` on the legacy field either way — only the
    // refinement distinguishes a tool call from model wait.
    expect(collapse({ state: 'working', phase: 'tool' })).toEqual({
      state: 'working',
      activity: 'tool',
    });
    expect(collapse({ state: 'working', phase: 'thinking' })).toEqual({
      state: 'working',
      activity: 'thinking',
    });
    // An unset phase reads as thinking: a turn always opens in LLM-wait.
    expect(collapse({ state: 'working' })).toEqual({ state: 'working', activity: 'thinking' });
    // Waiting on the user stays `idle` on the legacy field.
    expect(collapse({ state: 'idle', awaiting: true })).toEqual({
      state: 'idle',
      activity: 'awaiting',
    });
    expect(collapse({ state: 'idle' })).toEqual({ state: 'idle', activity: undefined });
    expect(collapse({ state: 'broken' })).toEqual({ state: 'broken', activity: undefined });
    expect(collapse({ state: 'initializing' })).toEqual({
      state: 'initializing',
      activity: undefined,
    });
  });

  it('broadcasts the leader toolbar lifecycle state and context fill', () => {
    expect(
      toScoopSummaries([cone], [{ key: 'cone', state: 'working', phase: 'tool', fill: 64 }])
    ).toEqual([
      expect.objectContaining({ jid: 'cone', state: 'working', activity: 'tool', fill: 64 }),
    ]);
    expect(toScoopSummaries([cone], [])).toEqual([
      expect.objectContaining({ jid: 'cone', state: 'idle', fill: 0 }),
    ]);
  });

  it('expands every wire pair back into follower descriptor fields', () => {
    const expand = (pair: Pick<ScoopSummary, 'state' | 'activity'>): Record<string, unknown> => {
      const [descriptor] = toFollowerSwitcherScoops([{ ...cone, ...pair, fill: 40 }]);
      return { state: descriptor?.state, phase: descriptor?.phase, awaiting: descriptor?.awaiting };
    };

    expect(expand({ state: 'working', activity: 'thinking' })).toMatchObject({
      state: 'working',
      phase: 'thinking',
    });
    expect(expand({ state: 'working', activity: 'tool' })).toMatchObject({
      state: 'working',
      phase: 'tool',
    });
    expect(expand({ state: 'idle', activity: 'awaiting' })).toMatchObject({
      state: 'idle',
      awaiting: true,
    });
    expect(expand({ state: 'idle' })).toMatchObject({ state: 'idle' });
    expect(expand({ state: 'broken' })).toMatchObject({ state: 'broken' });
    expect(expand({ state: 'initializing' })).toMatchObject({ state: 'initializing' });
  });

  it('round-trips every pair, so leader and follower render the same face', () => {
    for (const pair of WIRE_PAIRS) {
      const [descriptor] = toFollowerSwitcherScoops([{ ...cone, ...pair, fill: 40 }]);
      const [summary] = toScoopSummaries([cone], [descriptor as never]);
      const label = JSON.stringify(pair);
      expect(summary?.state, `state round trip broke for ${label}`).toBe(pair.state);
      // A busy scoop always comes back with an explicit refinement, so the
      // absent-activity case below is only ever an OLDER leader.
      if (pair.activity) {
        expect(summary?.activity, `activity round trip broke for ${label}`).toBe(pair.activity);
      }
    }
  });

  it('treats an older leader’s bare `working` exactly as it did before', () => {
    // No `activity` at all — the pre-refinement wire. A busy scoop must still
    // read as thinking, which is what this follower already rendered.
    const [descriptor] = toFollowerSwitcherScoops([{ ...cone, state: 'working', fill: 30 }]);
    expect(descriptor).toMatchObject({ state: 'working', phase: 'thinking', eyes: 'open' });
    expect(descriptor?.awaiting).toBeUndefined();
  });

  it('ignores an activity from a newer leader and falls back to the state', () => {
    // The escape hatch the refinement field exists to provide: an unrecognised
    // value costs this build nothing, so the NEXT value added is free too.
    const [busy] = toFollowerSwitcherScoops([
      { ...cone, state: 'working', activity: 'daydreaming' as never, fill: 10 },
    ]);
    expect(busy).toMatchObject({ state: 'working', phase: 'thinking' });

    const [resting] = toFollowerSwitcherScoops([
      { ...cone, state: 'idle', activity: 'daydreaming' as never, fill: 10 },
    ]);
    expect(resting).toMatchObject({ state: 'idle' });
    expect(resting?.awaiting).toBeUndefined();
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

  it('keeps a refined scoop open-eyed rather than dead or eyeless', () => {
    const descriptors = toFollowerSwitcherScoops([
      { ...cone, state: 'working', activity: 'thinking' },
      { ...cone, jid: 'b', state: 'idle', activity: 'awaiting' },
    ]);
    expect(descriptors.map((descriptor) => descriptor.eyes)).toEqual(['open', 'open']);
  });

  it('defaults lifecycle state and fill from an older leader payload', () => {
    const [descriptor] = toFollowerSwitcherScoops([cone]);
    expect(descriptor).toMatchObject({ state: 'idle', fill: 0, eyes: 'open' });
  });
});
