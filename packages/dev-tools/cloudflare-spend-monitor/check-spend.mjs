#!/usr/bin/env node
/*
 * Cloudflare spend monitor — orchestrator (I/O).
 *
 * Queries the Cloudflare GraphQL Analytics API for the previous full UTC day,
 * asks `estimateDailySpend` (pure, unit-tested in `lib.mjs`) for the estimated
 * usage-based cost, and writes the result to $GITHUB_OUTPUT plus a Markdown
 * report file. The workflow opens/updates a GitHub issue when over threshold.
 * This file only does I/O.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN   token with **Account Analytics: Read**   (required)
 *   CLOUDFLARE_ACCOUNT_ID  Cloudflare account id                    (required)
 *   SPEND_THRESHOLD_USD    alert threshold in USD/day               (default 3)
 *   REPORT_FILE            path to write the Markdown report        (default cloudflare-spend-report.md)
 *
 * Exit 0 on a clean decision (over or under threshold); non-zero only on
 * missing env or an unexpected API/network failure.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import {
  activeTimeMicrosToGbSeconds,
  buildReport,
  DEFAULT_THRESHOLD_USD,
  daysInUtcMonth,
  estimateDailySpend,
  isOverThreshold,
  previousUtcDay,
  sumForDay,
} from './lib.mjs';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

const QUERY = `query AccountSpend($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjectsDuration: durableObjectsPeriodicGroups(
        limit: 1000
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [date_ASC]
      ) { dimensions { date } sum { activeTime } }
      durableObjectsRequests: durableObjectsInvocationsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [date_ASC]
      ) { dimensions { date } sum { requests } }
      workersRequests: workersInvocationsAdaptive(
        limit: 1000
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [date_ASC]
      ) { dimensions { date } sum { requests } }
    }
  }
}`;

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function fetchAccountUsage({ token, accountId, startISO, endISO }) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'slicc-cloudflare-spend-monitor',
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { account: accountId, start: startISO, end: endISO },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 401
        ? ' (the token likely needs the "Account Analytics: Read" permission)'
        : '';
    throw new Error(
      `Cloudflare GraphQL → ${res.status} ${res.statusText}${hint}: ${text.slice(0, 300)}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare GraphQL returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (payload.errors?.length) {
    throw new Error(`Cloudflare GraphQL errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
  }
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error(
      'Cloudflare GraphQL returned no account data (check the account id and token).'
    );
  }
  return account;
}

async function main() {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const thresholdUsd = Number(process.env.SPEND_THRESHOLD_USD) || DEFAULT_THRESHOLD_USD;
  const reportFile = (process.env.REPORT_FILE ?? '').trim() || 'cloudflare-spend-report.md';

  const { startISO, endISO, day } = previousUtcDay();
  const account = await fetchAccountUsage({ token, accountId, startISO, endISO });

  const durationGbSeconds = activeTimeMicrosToGbSeconds(
    sumForDay(account.durableObjectsDuration, day, 'activeTime')
  );
  const doRequests = sumForDay(account.durableObjectsRequests, day, 'requests');
  const workersRequests = sumForDay(account.workersRequests, day, 'requests');

  const estimate = estimateDailySpend(
    { durationGbSeconds, doRequests, workersRequests },
    { daysInMonth: daysInUtcMonth(day) }
  );
  const over = isOverThreshold(estimate.totalUsd, thresholdUsd);

  const report = buildReport({ day, thresholdUsd, estimate, accountId });
  writeFileSync(reportFile, `${report}\n`);

  setOutput('day', day);
  setOutput('estimated_usd', estimate.totalUsd.toFixed(2));
  setOutput('threshold_usd', thresholdUsd.toFixed(2));
  setOutput('over_threshold', over ? 'true' : 'false');
  setOutput('report_file', reportFile);

  console.log(
    `Cloudflare estimated spend for ${day} (UTC): $${estimate.totalUsd.toFixed(2)} (threshold $${thresholdUsd.toFixed(2)})`
  );
  for (const meter of estimate.breakdown) {
    console.log(
      `  - ${meter.label}: $${meter.usd.toFixed(2)} (${Math.round(meter.units).toLocaleString('en-US')} ${meter.unit})`
    );
  }
  console.log(over ? '⚠️  Over threshold — issue will be raised.' : '✅ Under threshold.');
}

main().catch((err) => {
  console.error(`❌ Cloudflare spend monitor failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
