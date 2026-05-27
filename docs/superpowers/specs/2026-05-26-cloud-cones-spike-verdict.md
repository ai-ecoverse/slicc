# Plan C verdict — Workers + e2b SDK compatibility

**Date:** 2026-05-26
**Spike duration:** ~1 day (extraction prep in Plan A + spike route in Plan C)
**Decision:** PASS-WITH-CAVEATS

## Results by criterion

| #   | Criterion                                                                                            | Result     | Notes                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | `Sandbox.create` + `files.write` + `commands.run` + `pause`/`resume`/`kill` run in a Workers runtime | **PASS**   | All five spike ops returned successful JSON in `wrangler dev`. The exact `createSubstrate('e2b')` adapter Plan D uses worked end-to-end without modification. |
| C-2 | Worker bundle stays under CF size limit with e2b SDK included                                        | **PASS**   | Bundle 791 KB unminified / 147 KB gzipped — far under the 10 MiB compressed limit. wrangler dry-run reported no compat warnings.                              |
| C-3 | `Sandbox.create` round-trip completes within 60s                                                     | **PASS\*** | Confirmed locally via `wrangler dev`. \*Production Workers CPU + subrequest limits not yet measured — see Caveats.                                            |
| C-4 | `E2B_API_KEY` unreachable from the browser                                                           | **PASS**   | `grep` against `dist/index.js` finds zero hits for the secret. Spike module redacts the key from any error string before responding.                          |

## Timings observed

Local (wrangler dev): all five `/spike/*` operations completed without
exceeding the 60s threshold for create. Exact per-op numbers not preserved
across the validation session.

Staging (deployed): **not run.** No staging environment was available at
verdict time. The local timings are a strong indicator but do not enforce
CF Workers' production CPU / subrequest budgets.

## Decision: PASS-WITH-CAVEATS

Plan D proceeds against Workers + e2b SDK. Two adjustments fold into D's
design based on the spike outcome:

1. **D9 — `/start` adopts the async pattern.** Even though local timings
   passed the 60s budget, real Workers subrequest budgets vary by plan and
   geographic edge. Returning the sandboxId immediately (with the dashboard
   polling `/status`) is the defensive choice. It also improves UX: a 30s
   blocking POST is bad even when it succeeds.

2. **Defer staging validation until first deploy.** When the production
   sliccy.ai worker first deploys with cloud routes, validate real timings
   against the staging environment. If real-world create exceeds 30s,
   the async pattern from (1) already handles it. If create exceeds 60s
   consistently, escalate — that suggests the e2b SDK's `setEnvs`/`commands`
   flow has a Workers-runtime tax we haven't characterised.

## Spike cleanup

- [ ] `packages/cloudflare-worker/src/spike/cloud-spike.ts` remains in tree
      gated by `SPIKE_ENABLED=1`. Removed in Plan D's final cleanup task.
- [ ] `SPIKE_ENABLED` secret must NOT be set in production. Local
      `.dev.vars` already gitignored.
