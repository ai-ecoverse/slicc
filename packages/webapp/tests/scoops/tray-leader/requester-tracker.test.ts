import { describe, expect, it } from 'vitest';
import { RequesterTracker } from '../../../src/scoops/tray-leader/requester-tracker.js';

describe('RequesterTracker', () => {
  it('starts with no known origin', () => {
    expect(new RequesterTracker().get()).toBeNull();
  });

  it('tracks the most recent origin across leader and follower messages', () => {
    const tracker = new RequesterTracker();
    tracker.noteFollowerUserMessage('boot-1', 'runtime-1');
    expect(tracker.get()).toEqual(
      expect.objectContaining({ kind: 'follower', bootstrapId: 'boot-1', runtimeId: 'runtime-1' })
    );

    tracker.noteLeaderUserMessage();
    expect(tracker.get()).toEqual(expect.objectContaining({ kind: 'leader' }));

    // runtimeId may be unknown when the follower has not advertised yet.
    tracker.noteFollowerUserMessage('boot-2');
    expect(tracker.get()).toEqual(
      expect.objectContaining({ kind: 'follower', bootstrapId: 'boot-2', runtimeId: undefined })
    );
  });

  it('records a timestamp with each origin', () => {
    const tracker = new RequesterTracker();
    const before = Date.now();
    tracker.noteFollowerUserMessage('boot-1');
    const origin = tracker.get();
    expect(origin?.at).toBeGreaterThanOrEqual(before);
    expect(origin?.at).toBeLessThanOrEqual(Date.now());
  });

  it('clears a follower origin when that follower disconnects', () => {
    const tracker = new RequesterTracker();
    tracker.noteFollowerUserMessage('boot-1');
    tracker.handleFollowerRemoved('other-boot');
    expect(tracker.get()).toEqual(expect.objectContaining({ bootstrapId: 'boot-1' }));
    tracker.handleFollowerRemoved('boot-1');
    expect(tracker.get()).toBeNull();
  });

  it('keeps a leader origin when followers disconnect', () => {
    const tracker = new RequesterTracker();
    tracker.noteLeaderUserMessage();
    tracker.handleFollowerRemoved('boot-1');
    expect(tracker.get()).toEqual(expect.objectContaining({ kind: 'leader' }));
  });
});
