/*
 * Cloudflare spend monitor — pure logic.
 *
 * Estimates one UTC day of usage-based Cloudflare Workers Platform spend from
 * the GraphQL Analytics API and decides whether it crosses an alert threshold.
 * Cloudflare has no per-day billing API, so this is a deliberate *estimate*
 * across the meters that actually drive cost on this account — the same
 * Durable Objects duration meter behind the $12.50/day incident this monitor
 * was created to catch (see packages/cloudflare-worker/src/session-tray.ts).
 *
 * This module is intentionally free of I/O so it can be unit-tested in
 * isolation; the GraphQL/GitHub calls live in `check-spend.mjs`.
 */

const MICROS_PER_SECOND = 1_000_000;
// Each Durable Object instance is billed at 128 MB of memory for the wall-clock
// time it is active; duration is metered in GB-seconds.
const DO_MEMORY_GB = 128 / 1024;

/**
 * Billable meters with public Workers Paid unit prices and the monthly free
 * allocations included with the plan. Prices in USD. Keep this table in sync
 * with https://developers.cloudflare.com/workers/platform/pricing/ and
 * https://developers.cloudflare.com/durable-objects/platform/pricing/.
 * @type {Record<string, {label: string, unit: string, usdPerMillion: number, freeUnitsPerMonth: number}>}
 */
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

/**
 * Convert the `activeTime` sum from `durableObjectsPeriodicGroups`
 * (microseconds of wall-clock active time) into billable GB-seconds.
 * @param {number} activeTimeMicros
 * @returns {number}
 */
export function activeTimeMicrosToGbSeconds(activeTimeMicros) {
  const micros = Number(activeTimeMicros) || 0;
  return (micros / MICROS_PER_SECOND) * DO_MEMORY_GB;
}

/**
 * Number of days in the UTC month of an ISO `YYYY-MM-DD` day. Used to prorate
 * the monthly free allocations onto a single day.
 * @param {string} day
 * @returns {number}
 */
export function daysInUtcMonth(day) {
  const [year, month] = String(day)
    .split('-')
    .map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return 30;
  }
  // Date.UTC months are 0-based, so `month` (1-based) is next month; day 0 backs
  // up to the last day of the intended month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The previous complete UTC day relative to `now`. A complete day avoids the
 * partial-day undercount you would get from a trailing-24h window mid-day.
 * @param {Date} [now]
 * @returns {{startISO: string, endISO: string, day: string}}
 */
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

/**
 * Sum a numeric `sum.<field>` across the rows of a GraphQL `*Groups` series
 * that match `day`. Tolerant of null/missing shapes.
 * @param {Array<{dimensions?: {date?: string}, sum?: Record<string, unknown>}>|null|undefined} groups
 * @param {string} day
 * @param {string} field
 * @returns {number}
 */
export function sumForDay(groups, day, field) {
  if (!Array.isArray(groups)) {
    return 0;
  }
  return groups
    .filter((group) => group?.dimensions?.date === day)
    .reduce((total, group) => total + (Number(group?.sum?.[field]) || 0), 0);
}

/**
 * Estimate the billable cost of a single meter for one day, prorating the
 * monthly free allocation across the month.
 * @param {number} units
 * @param {{label: string, unit: string, usdPerMillion: number, freeUnitsPerMonth: number}} meter
 * @param {number} daysInMonth
 * @returns {{label: string, unit: string, units: number, freeUnitsPerDay: number, billableUnits: number, usd: number}}
 */
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

/**
 * Estimate total usage-based spend for one day across all tracked meters.
 * @param {{durationGbSeconds?: number, doRequests?: number, workersRequests?: number}} usage
 * @param {{daysInMonth?: number}} [options]
 * @returns {{totalUsd: number, breakdown: ReturnType<typeof estimateMeterCost>[]}}
 */
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

/**
 * Decide whether estimated spend crosses the threshold.
 * @param {number} totalUsd
 * @param {number} thresholdUsd
 * @returns {boolean}
 */
export function isOverThreshold(totalUsd, thresholdUsd) {
  return (Number(totalUsd) || 0) > (Number(thresholdUsd) || 0);
}

const USD = (value) => `$${(Number(value) || 0).toFixed(2)}`;
const NUM = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');

/** Marker used to find this monitor's existing issue for deduplication. */
export const ISSUE_MARKER = '<!-- cloudflare-spend-monitor -->';

/**
 * Render a Markdown report body for the alert issue / comment.
 * @param {{day: string, thresholdUsd: number, estimate: ReturnType<typeof estimateDailySpend>, accountId?: string}} input
 * @returns {string}
 */
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
