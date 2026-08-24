import { describe, expect, it } from 'vitest';
import {
  MONITOR_HISTORY_CAPACITY,
  MonitorHistory,
  type MonitorSample,
} from '../../../src/ui/wc/monitor-history.js';

function sample(at: number, overrides: Partial<MonitorSample> = {}): MonitorSample {
  return { at, burnRate: 1, workingUnits: 0, liveProcesses: 2, ...overrides };
}

describe('MonitorHistory', () => {
  it('returns no series below two points, so a sparkline never gets one', () => {
    const history = new MonitorHistory();
    expect(history.series('burnRate')).toBeUndefined();
    history.push(sample(1_000));
    expect(history.series('burnRate')).toBeUndefined();
    history.push(sample(6_000, { burnRate: 2 }));
    expect(history.series('burnRate')).toEqual([1, 2]);
  });

  it('keeps samples oldest-first', () => {
    const history = new MonitorHistory();
    history.push(sample(1_000, { workingUnits: 1 }));
    history.push(sample(6_000, { workingUnits: 3 }));
    history.push(sample(11_000, { workingUnits: 2 }));
    expect(history.series('workingUnits')).toEqual([1, 3, 2]);
  });

  it('evicts the oldest sample once full', () => {
    const history = new MonitorHistory(3);
    for (let i = 0; i < 5; i++) history.push(sample(i * 1_000, { liveProcesses: i }));
    expect(history.size).toBe(3);
    expect(history.series('liveProcesses')).toEqual([2, 3, 4]);
  });

  it('refuses a capacity that would make every series unplottable', () => {
    // A capacity below 2 can never satisfy `series()`, so a caller passing 0
    // would silently get a monitor with no sparklines and no explanation.
    const history = new MonitorHistory(0);
    history.push(sample(1_000));
    history.push(sample(6_000, { burnRate: 4 }));
    expect(history.series('burnRate')).toEqual([1, 4]);
  });

  it('reports the peak of a metric', () => {
    const history = new MonitorHistory();
    expect(history.peak('workingUnits')).toBeNull();
    history.push(sample(1_000, { workingUnits: 2 }));
    history.push(sample(6_000, { workingUnits: 5 }));
    history.push(sample(11_000, { workingUnits: 1 }));
    expect(history.peak('workingUnits')).toBe(5);
  });

  it('labels the span the samples ACTUALLY cover, not the capacity', () => {
    // The whole point: a panel opened 45 seconds ago has 45 seconds of
    // history, and a chart claiming "last 5 minutes" would be lying.
    const history = new MonitorHistory();
    expect(history.windowLabel()).toBeNull();
    history.push(sample(0));
    expect(history.windowLabel()).toBeNull();
    history.push(sample(45_000));
    expect(history.windowLabel()).toBe('last 45s');
    history.push(sample(300_000));
    expect(history.windowLabel()).toBe('last 5m');
  });

  it('switches from seconds to minutes at 90s', () => {
    const seconds = new MonitorHistory();
    seconds.push(sample(0));
    seconds.push(sample(89_000));
    expect(seconds.windowLabel()).toBe('last 89s');

    const minutes = new MonitorHistory();
    minutes.push(sample(0));
    minutes.push(sample(90_000));
    expect(minutes.windowLabel()).toBe('last 2m');
  });

  it('holds roughly five minutes at the panel refresh cadence', () => {
    // The capacity is chosen against wc-workbench's 5s monitor timer; if that
    // timer changes, this is the assertion that should make someone re-check.
    expect(MONITOR_HISTORY_CAPACITY * 5).toBe(300);
  });
});
