import { describe, expect, it } from 'vitest';
import {
  buildTimingReport,
  elapsedMs,
  formatDuration,
  formatTimingSummary,
  selectJob,
} from './ci-job-timing-lib.mjs';

const job = {
  id: 42,
  name: 'cloudflare-worker',
  status: 'in_progress',
  conclusion: null,
  created_at: '2026-09-16T10:00:00.000Z',
  started_at: '2026-09-16T10:00:05.000Z',
  completed_at: null,
  steps: [
    {
      number: 1,
      name: 'Build webapp for worker static assets',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-09-16T10:00:10.000Z',
      completed_at: '2026-09-16T10:01:15.500Z',
    },
    {
      number: 2,
      name: 'Archive assets to R2 (staging)',
      status: 'completed',
      conclusion: 'skipped',
      started_at: null,
      completed_at: null,
    },
    {
      number: 3,
      name: 'Publish Cloudflare timing diagnostics',
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-09-16T10:01:16.000Z',
      completed_at: null,
    },
  ],
};

describe('CI job timing diagnostics', () => {
  it('selects the newest exact job match before using a suffix fallback', () => {
    const selected = selectJob(
      [
        { ...job, id: 1, started_at: '2026-09-16T09:00:00.000Z' },
        { ...job, id: 2 },
        { ...job, id: 3, name: 'matrix / cloudflare-worker' },
      ],
      'cloudflare-worker'
    );
    expect(selected.id).toBe(2);
  });

  it('computes queue, completed-phase, and in-progress durations', () => {
    const nowMs = Date.parse('2026-09-16T10:01:20.000Z');
    const report = buildTimingReport(job, {
      nowMs,
      excludedSteps: ['Publish Cloudflare timing diagnostics'],
    });

    expect(report.job.queueMs).toBe(5000);
    expect(report.job.elapsedMs).toBe(75_000);
    expect(report.steps).toEqual([
      expect.objectContaining({
        name: 'Build webapp for worker static assets',
        durationMs: 65_500,
      }),
      expect.objectContaining({ name: 'Archive assets to R2 (staging)', durationMs: undefined }),
    ]);
    expect(elapsedMs(undefined, undefined, nowMs)).toBeUndefined();
  });

  it('renders a scan-friendly Markdown phase table', () => {
    const report = buildTimingReport(job, {
      nowMs: Date.parse('2026-09-16T10:01:20.000Z'),
      excludedSteps: ['Publish Cloudflare timing diagnostics'],
    });
    const summary = formatTimingSummary(report, 'Cloudflare worker timings');

    expect(formatDuration(65_500)).toBe('1m 06s');
    expect(formatDuration(119_999)).toBe('2m 00s');
    expect(summary).toContain('## Cloudflare worker timings');
    expect(summary).toContain('Queue: 5.0s · observed job time: 1m 15s');
    expect(summary).toContain('| Build webapp for worker static assets | success | 1m 06s |');
    expect(summary).toContain('| Archive assets to R2 (staging) | skipped | — |');
  });
});
