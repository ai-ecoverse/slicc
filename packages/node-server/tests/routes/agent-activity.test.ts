import { describe, expect, it } from 'vitest';
import { AGENT_ACTIVITY_WINDOW_MS, AgentActivityTracker } from '../../src/routes/agent-activity.js';

describe('AgentActivityTracker', () => {
  it('reports activity immediately and expires it after one minute', () => {
    let now = 1_700_000_000_000;
    const tracker = new AgentActivityTracker(() => now);

    expect(tracker.isActiveInLastMinute()).toBe(false);
    tracker.recordActivity();
    expect(tracker.isActiveInLastMinute()).toBe(true);

    now += AGENT_ACTIVITY_WINDOW_MS + 1;
    expect(tracker.isActiveInLastMinute()).toBe(false);
  });
});
