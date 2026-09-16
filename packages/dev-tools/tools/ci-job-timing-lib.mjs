function timestampMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function elapsedMs(startedAt, completedAt, nowMs = Date.now()) {
  const start = timestampMs(startedAt);
  if (start === undefined) return undefined;
  const end = timestampMs(completedAt) ?? nowMs;
  return Math.max(0, end - start);
}

export function selectJob(jobs, jobName) {
  const exact = jobs.filter((job) => job.name === jobName);
  const candidates = exact.length > 0 ? exact : jobs.filter((job) => job.name?.endsWith(jobName));
  return candidates.sort(
    (left, right) =>
      (timestampMs(right.started_at) ?? timestampMs(right.created_at) ?? 0) -
      (timestampMs(left.started_at) ?? timestampMs(left.created_at) ?? 0)
  )[0];
}

export function buildTimingReport(job, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const excludedSteps = new Set(options.excludedSteps ?? []);
  const firstExcludedStepNumber = (job.steps ?? [])
    .filter((step) => excludedSteps.has(step.name))
    .reduce(
      (first, step) => Math.min(first, step.number ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY
    );
  const createdMs = timestampMs(job.created_at);
  const startedMs = timestampMs(job.started_at);

  return {
    schemaVersion: 1,
    observedAt: new Date(nowMs).toISOString(),
    job: {
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      queueMs:
        createdMs === undefined || startedMs === undefined
          ? undefined
          : Math.max(0, startedMs - createdMs),
      elapsedMs: elapsedMs(job.started_at, job.completed_at, nowMs),
    },
    steps: (job.steps ?? [])
      .filter(
        (step) =>
          !excludedSteps.has(step.name) &&
          (step.number ?? Number.POSITIVE_INFINITY) < firstExcludedStepNumber
      )
      .map((step) => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        durationMs: elapsedMs(step.started_at, step.completed_at, nowMs),
      })),
  };
}

export function hasUnsettledStepsBefore(job, stepNames) {
  const boundary = (job.steps ?? [])
    .filter((step) => stepNames.includes(step.name))
    .reduce(
      (first, step) => Math.min(first, step.number ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY
    );
  if (!Number.isFinite(boundary)) return false;
  return (job.steps ?? []).some(
    (step) => (step.number ?? Number.POSITIVE_INFINITY) < boundary && step.status !== 'completed'
  );
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;

  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function escapeTableCell(value) {
  return String(value ?? 'running')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

export function formatTimingSummary(report, title = 'CI phase timings') {
  const lines = [
    `## ${title}`,
    '',
    `Queue: ${formatDuration(report.job.queueMs)} · observed job time: ${formatDuration(report.job.elapsedMs)}`,
    '',
    '| Phase | Result | Duration |',
    '| --- | --- | ---: |',
  ];

  for (const step of report.steps) {
    lines.push(
      `| ${escapeTableCell(step.name)} | ${escapeTableCell(step.conclusion ?? step.status)} | ${formatDuration(step.durationMs)} |`
    );
  }

  return `${lines.join('\n')}\n`;
}
