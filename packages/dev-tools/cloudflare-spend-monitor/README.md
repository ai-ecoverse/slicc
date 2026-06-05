# Cloudflare Spend Monitor — daily overspend tripwire

A nightly check that estimates the previous UTC day's usage-based Cloudflare
spend from the GraphQL Analytics API and opens (or updates) a GitHub issue when
it exceeds a threshold (default **$3/day**). It exists to catch cost regressions
like the Durable Objects duration blow-up that was costing ~$12.50/day (see
`packages/cloudflare-worker/src/session-tray.ts` and the WebSocket hibernation
fix).

## Flow

```
cron (daily) ─▶ check-spend.mjs ─▶ over_threshold? ─▶ create-or-update GitHub issue
                   │
                   └─ one GraphQL POST returning three meters:
                        • durableObjectsPeriodicGroups            (duration → GB-s)
                        • durableObjectsInvocationsAdaptiveGroups (DO requests)
                        • workersInvocationsAdaptive              (Workers requests)
```

1. **Window** — `previousUtcDay()` selects the last _complete_ UTC day (avoids
   the partial-day undercount of a trailing-24h window).
2. **Query** — `check-spend.mjs` runs one GraphQL query for the three meters
   that drive cost on this account.
3. **Estimate** — `estimateDailySpend(...)` (pure, in `lib.mjs`) prices each
   meter using public Workers Paid rates, subtracting the monthly free
   allocation prorated per day, and sums to a daily total.
4. **Alert** — the workflow writes `over_threshold` / `estimated_usd` /
   `day` to `$GITHUB_OUTPUT` and a Markdown report; when over threshold it
   creates a single rolling issue (deduped by a marker) or comments on the
   existing one. When spend returns below threshold it comments and closes it.

## What "spend" means here

Cloudflare exposes **no per-day billing API**, so this is a deliberate
**estimate** from analytics, not the invoiced amount. It covers the meters that
actually drive cost on this account:

| Meter                    | Rate                  | Monthly free allocation |
| ------------------------ | --------------------- | ----------------------- |
| Durable Objects duration | $12.50 / million GB-s | 400,000 GB-s            |
| Durable Objects requests | $0.15 / million       | 1,000,000               |
| Workers requests         | $0.30 / million       | 10,000,000              |

Free allocations are prorated by the number of days in the month. The Workers
Paid base fee (~$5/month) is intentionally ignored — this is a _usage-spike_
tripwire. Durable Objects duration (128 MB × wall-clock active time) is the
meter behind past overspend; it is the first thing to inspect in an alert.

## Design notes

- **Pure logic is isolated and tested.** `lib.mjs` has all cost math
  (`estimateDailySpend`, `estimateMeterCost`, `activeTimeMicrosToGbSeconds`,
  `daysInUtcMonth`, `previousUtcDay`, `sumForDay`, `buildReport`) with no I/O,
  unit-tested in `lib.test.mjs` (run via the `dev-tools` vitest project in
  `npm test`). `check-spend.mjs` only talks to the Cloudflare GraphQL API and
  `$GITHUB_OUTPUT`.

The workflow lives in `.github/workflows/cloudflare-spend-monitor.yml`.

## Required secrets / variables (GitHub Actions)

Reuses the existing Cloudflare credentials — **no new secret is required**, but
the token must carry one extra permission:

| Name                    | Kind     | Purpose                                                                       |
| ----------------------- | -------- | ----------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | secret   | Cloudflare API token. **Must include `Account Analytics: Read`** for GraphQL. |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Cloudflare account id (already used by the worker deploy workflows).          |

> If the existing `CLOUDFLARE_API_TOKEN` lacks `Account Analytics: Read`, the
> run fails fast with a clear message; add the permission to that token (or
> swap in one that has it) in the Cloudflare dashboard.

## Run it locally

```bash
CLOUDFLARE_API_TOKEN=<token-with-analytics-read> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
SPEND_THRESHOLD_USD=3 \
  node packages/dev-tools/cloudflare-spend-monitor/check-spend.mjs

# Unit tests
npx vitest run --project dev-tools
```

### Environment variables

| Var                     | Meaning                                            | Default                      |
| ----------------------- | -------------------------------------------------- | ---------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Token with `Account Analytics: Read`               | — (required)                 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id                              | — (required)                 |
| `SPEND_THRESHOLD_USD`   | Alert threshold, USD/day                           | `3`                          |
| `REPORT_FILE`           | Path for the Markdown report the workflow comments | `cloudflare-spend-report.md` |
