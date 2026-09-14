import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/base/logger.js';
import { ThrottledErrorTracker } from '../../src/scoops/throttled-error-tracker.js';

function makeFakeLogger(): {
  logger: Logger;
  calls: { level: string; msg: string; data: unknown }[];
} {
  const calls: { level: string; msg: string; data: unknown }[] = [];
  const logger: Logger = {
    debug: (msg: string, data?: unknown) => calls.push({ level: 'debug', msg, data }),
    info: (msg: string, data?: unknown) => calls.push({ level: 'info', msg, data }),
    warn: (msg: string, data?: unknown) => calls.push({ level: 'warn', msg, data }),
    error: (msg: string, data?: unknown) => calls.push({ level: 'error', msg, data }),
  };
  return { logger, calls };
}

describe('ThrottledErrorTracker', () => {
  it('first reportFailure logs at error level immediately (passes -Infinity gate)', () => {
    const { logger, calls } = makeFakeLogger();
    const now = 100;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      now: () => now,
    });
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: 'error', msg: 'failed' });
    expect(calls[0].data).toMatchObject({ error: 'boom' });
  });

  it('subsequent failures within 60s are suppressed (throttle holds)', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 100;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      now: () => now,
    });
    tracker.reportFailure(new Error('boom-1'));
    now = 5_000;
    tracker.reportFailure(new Error('boom-2'));
    now = 30_000;
    tracker.reportFailure(new Error('boom-3'));
    now = 59_999;
    tracker.reportFailure(new Error('boom-4'));

    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({ error: 'boom-1' });
  });

  it('failure AFTER the sustained window logs again with sustained suffix', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      sustainedRelogMs: 100_000,
      now: () => now,
    });
    tracker.reportFailure(new Error('boom-1'));

    now = 61_000;
    tracker.reportFailure(new Error('mid'));
    expect(calls).toHaveLength(1);

    now = 101_000;
    tracker.reportFailure(new Error('boom-2'));
    expect(calls).toHaveLength(2);
    expect(calls[1].msg).toMatch(/sustained/);
    expect(calls[1].data).toMatchObject({ error: 'boom-2' });
  });

  it('reportSuccess when not in failing state is a no-op', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
    });
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    expect(calls).toHaveLength(0);
  });

  it('recovery requires N consecutive successes — fewer is not enough', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 5,
    });
    tracker.reportFailure(new Error('boom-1'));
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    expect(calls).toHaveLength(1);
    expect(calls.filter((c) => c.msg === 'recovered')).toHaveLength(0);
  });

  it('recovery log fires on the Nth consecutive success and resets the throttle', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 3,
      now: () => now,
    });
    tracker.reportFailure(new Error('boom-1'));
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    const recoveryLogs = calls.filter((c) => c.msg === 'recovered');
    expect(recoveryLogs).toHaveLength(1);
    expect(recoveryLogs[0].level).toBe('error');
    expect(recoveryLogs[0].data).toMatchObject({ kind: 'recovery' });

    now = 1_000;
    tracker.reportFailure(new Error('boom-2'));
    const failureLogs = calls.filter((c) => c.msg === 'failed');
    expect(failureLogs).toHaveLength(2);
    expect(failureLogs[1].data).toMatchObject({ error: 'boom-2' });
  });

  it('flapping (fail → succeed → fail → succeed) does NOT reset throttle until debounce window of successes', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 5,
      now: () => now,
    });

    tracker.reportFailure(new Error('boom-1'));

    tracker.reportSuccess();
    tracker.reportSuccess();
    now = 10_000;
    tracker.reportFailure(new Error('boom-2'));
    tracker.reportSuccess();
    now = 20_000;
    tracker.reportFailure(new Error('boom-3'));

    const failureLogs = calls.filter((c) => c.msg === 'failed');
    const recoveryLogs = calls.filter((c) => c.msg === 'recovered');
    expect(failureLogs).toHaveLength(1);
    expect(recoveryLogs).toHaveLength(0);
  });

  it('failure resets the consecutive-success counter (no half-recovery)', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 3,
    });
    tracker.reportFailure(new Error('boom-1'));
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportFailure(new Error('boom-2'));
    tracker.reportSuccess();
    tracker.reportSuccess();
    expect(calls.filter((c) => c.msg === 'recovered')).toHaveLength(0);
    tracker.reportSuccess();
    expect(calls.filter((c) => c.msg === 'recovered')).toHaveLength(1);
  });

  it('uses performance.now() by default (smoke-test that the default injection works)', () => {
    const { logger, calls } = makeFakeLogger();

    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
    });
    expect(() => tracker.reportFailure(new Error('first'))).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('non-Error rejections are coerced to string in the data field', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
    });
    tracker.reportFailure('a plain string rejection');
    expect(calls[0].data).toMatchObject({ error: 'a plain string rejection' });
  });

  it('emits a sustained-failure heartbeat on the sustainedRelogMs cadence, not throttleMs', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      sustainedRelogMs: 300_000,
      now: () => now,
    });

    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);
    expect(calls[0].msg).toBe('failed');

    now = 60_000;
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);

    now = 120_000;
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);

    now = 300_001;
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(2);
    expect(calls[1].msg).toMatch(/sustained/);
    expect(calls[1].level).toBe('error');
    expect(calls[1].data).toMatchObject({ error: 'boom' });
    expect((calls[1].data as { elapsedMs?: number }).elapsedMs).toBe(300_001);

    now = 600_002;
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(3);
    expect(calls[2].msg).toMatch(/sustained/);
  });

  it('uses the default sustainedRelogMs (5min) when not configured — 60s heartbeat does NOT fire', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',

      now: () => now,
    });
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);

    now = 60_001;
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);

    now = 300_002;
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(2);
    expect(calls[1].msg).toMatch(/sustained/);
  });

  it('clears the sustained suffix after recovery — next failure is fresh again', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 3,

      sustainedRelogMs: 100_000,
      now: () => now,
    });

    tracker.reportFailure(new Error('boom-1'));
    now = 120_000;
    tracker.reportFailure(new Error('boom-2'));
    expect(calls[1].msg).toMatch(/sustained/);

    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    expect(calls.find((c) => c.msg === 'recovered')).toBeTruthy();

    now = 121_000;
    tracker.reportFailure(new Error('boom-3'));
    const lastFailure = calls[calls.length - 1];
    expect(lastFailure.msg).toBe('failed');
    expect(lastFailure.data).toMatchObject({ error: 'boom-3' });
  });
});
