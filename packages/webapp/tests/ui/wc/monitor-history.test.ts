import { describe, expect, it } from 'vitest';
import {
  MONITOR_HISTORY_CAPACITY,
  MONITOR_HISTORY_WINDOW_MS,
  MonitorHistory,
  type MonitorSample,
} from '../../../src/ui/wc/monitor-history.js';

function sample(at: number, overrides: Partial<MonitorSample> = {}): MonitorSample {
  return { at, burnRate: 1, workingUnits: 0, liveProcesses: 2, ...overrides };
}

function values(history: MonitorHistory, key: 'burnRate' | 'workingUnits' | 'liveProcesses') {
  return history.series(key)?.points.map((p) => p.value);
}

describe('MonitorHistory', () => {
  it('returns no series below two points, so a sparkline never gets one', () => {
    const history = new MonitorHistory();
    expect(history.series('burnRate')).toBeUndefined();
    history.push(sample(1_000));
    expect(history.series('burnRate')).toBeUndefined();
    history.push(sample(6_000, { burnRate: 2 }));
    expect(history.series('burnRate')).toEqual({
      points: [
        { at: 1_000, value: 1 },
        { at: 6_000, value: 2 },
      ],
      windowMs: MONITOR_HISTORY_WINDOW_MS,
    });
  });

  it('carries the timestamps, so the plot can space points by elapsed time', () => {
    const history = new MonitorHistory();
    history.push(sample(0, { burnRate: 1 }));
    history.push(sample(5_000, { burnRate: 2 }));
    history.push(sample(95_000, { burnRate: 3 }));
    expect(history.series('burnRate')?.points.map((p) => p.at)).toEqual([0, 5_000, 95_000]);
  });

  it('keeps samples oldest-first', () => {
    const history = new MonitorHistory();
    history.push(sample(1_000, { workingUnits: 1 }));
    history.push(sample(6_000, { workingUnits: 3 }));
    history.push(sample(11_000, { workingUnits: 2 }));
    expect(values(history, 'workingUnits')).toEqual([1, 3, 2]);
  });

  it('evicts by AGE — samples that fall out of the window are dropped', () => {
    const history = new MonitorHistory(10_000);
    for (let i = 0; i <= 20; i++) history.push(sample(i * 1_000, { liveProcesses: i }));
    expect(values(history, 'liveProcesses')).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('keeps a short history whole — a 40s buffer in a 1h window loses nothing', () => {
    const history = new MonitorHistory();
    for (let i = 0; i <= 8; i++) history.push(sample(i * 5_000, { liveProcesses: i }));
    expect(history.size).toBe(9);
    expect(history.series('liveProcesses')?.windowMs).toBe(MONITOR_HISTORY_WINDOW_MS);
  });

  it('caps retained samples so a fast feeder cannot grow the buffer without limit', () => {
    const history = new MonitorHistory(MONITOR_HISTORY_WINDOW_MS, 5);
    for (let i = 0; i < 20; i++) history.push(sample(i * 10, { liveProcesses: i }));
    expect(history.size).toBe(5);
    expect(values(history, 'liveProcesses')).toEqual([15, 16, 17, 18, 19]);
  });

  it('refuses a window or capacity that would make every series unplottable', () => {
    const history = new MonitorHistory(0, 0);
    history.push(sample(1_000));
    history.push(sample(1_000, { burnRate: 4 }));
    expect(values(history, 'burnRate')).toEqual([1, 4]);
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

  it('switches from minutes to hours at 90m', () => {
    const history = new MonitorHistory(3 * 60 * 60 * 1000);
    history.push(sample(0));
    history.push(sample(2 * 60 * 60 * 1000));
    expect(history.windowLabel()).toBe('last 2h');
  });

  it('holds an hour, with room for the panel cadence to spare', () => {
    expect(MONITOR_HISTORY_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(MONITOR_HISTORY_WINDOW_MS / 5_000).toBeLessThan(MONITOR_HISTORY_CAPACITY);
  });
});
