const MICROS_PER_SECOND = 1_000_000;

const DO_MEMORY_GB = 128 / 1024;

export const METERS = {
  durableObjectsDuration: {
    label: 'Durable Objects duration',
    unit: 'GB-s',
    usdPerMillion: 12.5,
    freeUnitsPerMonth: 400_000,
  },
  durableObjectsRequests: {
    label: 'Durable Objects requests',
    unit: 'requests',
    usdPerMillion: 0.15,
    freeUnitsPerMonth: 1_000_000,
  },
  workersRequests: {
    label: 'Workers requests',
    unit: 'requests',
    usdPerMillion: 0.3,
    freeUnitsPerMonth: 10_000_000,
  },
};

export const DEFAULT_THRESHOLD_USD = 3;

export function activeTimeMicrosToGbSeconds(activeTimeMicros) {
  const micros = Number(activeTimeMicros) || 0;
  return (micros / MICROS_PER_SECOND) * DO_MEMORY_GB;
}

export function daysInUtcMonth(day) {
  const [year, month] = String(day)
    .split('-')
    .map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return 30;
  }

  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function previousUtcDay(now = new Date()) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    day: start.toISOString().slice(0, 10),
  };
}

export function sumForDay(groups, day, field) {
  if (!Array.isArray(groups)) {
    return 0;
  }
  return groups
    .filter((group) => group?.dimensions?.date === day)
    .reduce((total, group) => total + (Number(group?.sum?.[field]) || 0), 0);
}

export function estimateMeterCost(units, meter, daysInMonth) {
  const used = Math.max(0, Number(units) || 0);
  const safeDays = Number(daysInMonth) > 0 ? Number(daysInMonth) : 30;
  const freeUnitsPerDay = meter.freeUnitsPerMonth / safeDays;
  const billableUnits = Math.max(0, used - freeUnitsPerDay);
  const usd = (billableUnits / 1_000_000) * meter.usdPerMillion;
  return {
    label: meter.label,
    unit: meter.unit,
    units: used,
    freeUnitsPerDay,
    billableUnits,
    usd,
  };
}

export function estimateDailySpend(usage = {}, options = {}) {
  const daysInMonth = options.daysInMonth ?? 30;
  const breakdown = [
    estimateMeterCost(usage.durationGbSeconds, METERS.durableObjectsDuration, daysInMonth),
    estimateMeterCost(usage.doRequests, METERS.durableObjectsRequests, daysInMonth),
    estimateMeterCost(usage.workersRequests, METERS.workersRequests, daysInMonth),
  ];
  const totalUsd = breakdown.reduce((total, meter) => total + meter.usd, 0);
  return { totalUsd, breakdown };
}

export function isOverThreshold(totalUsd, thresholdUsd) {
  return (Number(totalUsd) || 0) > (Number(thresholdUsd) || 0);
}

const USD = (value) => `$${(Number(value) || 0).toFixed(2)}`;
const NUM = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');

export const ISSUE_MARKER = '<!-- cloudflare-spend-monitor -->';

export function buildReport({ day, thresholdUsd, estimate, accountId }) {
  const rows = estimate.breakdown
    .map(
      (meter) =>
        `| ${meter.label} | ${NUM(meter.units)} ${meter.unit} | ${NUM(meter.billableUnits)} ${meter.unit} | ${USD(meter.usd)} |`
    )
    .join('\n');
  const account = accountId ? `\n- **Account:** \`${accountId}\`` : '';
  return [
    ISSUE_MARKER,
    `## Cloudflare daily spend over ${USD(thresholdUsd)}`,
    '',
    `Estimated usage-based spend for **${day} (UTC)** was **${USD(estimate.totalUsd)}**, above the ${USD(thresholdUsd)}/day alert threshold.${account}`,
    '',
    '| Meter | Used | Billable (after prorated free tier) | Est. cost |',
    '| ----- | ---- | ----------------------------------- | --------- |',
    rows,
    `| **Total** | | | **${USD(estimate.totalUsd)}** |`,
    '',
    '<sub>Estimated from the Cloudflare GraphQL Analytics API across the usage meters that drive cost on this account (Durable Objects duration & requests, Workers requests); monthly free allocations are prorated per day. This is an estimate, not the billed amount. Durable Objects duration is the meter behind past overspend — check for non-hibernating WebSockets or alarm loops first.</sub>',
  ].join('\n');
}
