# RUM Error Triage — the error-to-insight pipeline

SLICC has no Sentry. Operational errors are reported through RUM (Real User
Monitoring) as `error` checkpoints in the helix BigQuery `cluster` table (see
`packages/webapp/src/ui/telemetry.ts`). This tool turns those errors into
actionable GitHub issues, automatically, every night.

## Flow

```
nightly cron ─▶ triage-rum-errors.mjs ─▶ rum-error-candidates.json ─▶ claude-code-action (phase 1) ─▶ issues
                  │                          ▲                                                          │
                  ├─ bq query (RUM errors)   │ deduped vs. existing rum-fp markers      label fixable: │
                  └─ gh issue list (dedup) ──┘                                          rum-fix-ready   ▼
                                                            claude-code-action (phase 2) ◀── gate: gh issue list --label rum-fix-ready
                                                                       │
                                                                       └─▶ draft PR (Closes #N) + relabel rum-fix-ready ─▶ rum-fix-pr-open
```

1. **Query** — `triage-rum-errors.mjs` runs a BigQuery query (`buildErrorQuery`
   in `lib.mjs`) for `error` checkpoints in SLICC sessions over the look-back
   window. SLICC sessions are identified by the telemetry fingerprint
   (`generation LIKE 'slicc-%'` for the extension, or a `navigate` checkpoint
   with `target IN ('cli','electron')` for the CLI/Electron floats). Vite HMR
   dev-client noise is excluded.
2. **Group + dedup** — raw rows are normalised into stable signatures and
   fingerprinted (`md5`). Each fingerprint that already appears in an existing
   issue (as a `<!-- rum-fp:... -->` marker) is dropped, so the same error is
   filed only once.
3. **Classify + file (phase 1)** — new candidates are written to
   `rum-error-candidates.json`, and `anthropics/claude-code-action` reads them,
   investigates each against the codebase, and opens an issue for the genuine
   bugs — embedding the `rum-fp` marker so the next run recognises it. When (and
   only when) the proposed fix is small, clear, and low-risk it labels that
   issue `rum-fix-ready`. Phase 1 never touches code or opens a PR; the label is
   the only handshake it leaves behind.
4. **Open draft PRs (phase 2)** — a gate step lists the open `rum-fix-ready`
   issues (`gh issue list --label rum-fix-ready --state open`) and, if any
   exist, a second `claude-code-action` run implements each fix on its own
   branch, opens a **draft** PR linked with `Closes #N`, then moves the label
   from `rum-fix-ready` to `rum-fix-pr-open` so the next night doesn't reprocess
   it. Splitting phase 2 out gives each run its own turn budget, so an issue is
   never filed promising a PR that a turn-exhausted run fails to open. Both
   phases (and the gate) are skipped on a `dry_run` dispatch.

The workflow lives in `.github/workflows/rum-error-triage.yml`.

## Design notes

- **Pure logic is isolated and tested.** `lib.mjs` contains all normalisation,
  fingerprinting, noise filtering, dedup, and query building, with no I/O. It is
  unit-tested in `lib.test.mjs` (run via the `dev-tools` vitest project in
  `npm test`). `triage-rum-errors.mjs` only shells out to `bq` and `gh`.
- **Dedup key.** The `rum-fp:<fingerprint>` marker embedded in each filed issue
  body is the dedup contract — keep it intact when editing issue templates.
- **Noise.** `isNoise()` drops Vite HMR frames and contentless errors. Extend
  `NOISE_PATTERNS` as new dev-only noise appears.

## Required secrets / variables (GitHub Actions)

| Name                       | Kind     | Purpose                                                                                                                                                                                                                     |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUM_BQ_SA_KEY`            | secret   | GCP service-account JSON for BigQuery. Provisioned: `rum-error-triage@helix-225321.iam.gserviceaccount.com` — `bigquery.jobUser` (project) + `bigquery.dataViewer` scoped by IAM condition to the `helix_rum` dataset only. |
| `AWS_BEARER_TOKEN_BEDROCK` | secret   | Amazon Bedrock API key (the Adobe CAMP `ABSK...` bearer token) used by `claude-code-action` (`use_bedrock: true`).                                                                                                          |
| `RUM_AWS_REGION`           | variable | Optional. Bedrock region for the CAMP key (default `us-east-1`).                                                                                                                                                            |
| `RUM_BEDROCK_MODEL`        | variable | Optional. Bedrock model / inference profile (default `global.anthropic.claude-sonnet-4-6`).                                                                                                                                 |
| `ANTHROPIC_API_KEY`        | secret   | Only if you switch off the Bedrock path (see the commented `anthropic_api_key` fallback in the workflow).                                                                                                                   |

The BigQuery service account is intentionally minimal: read-only, single
dataset (enforced by an IAM condition), single purpose. Workload Identity
Federation is the preferred long-term replacement for the key — see
`google-github-actions/auth`.

## Run it locally

Requires the `bq` CLI (authenticated to `helix-225321`) and the `gh` CLI.

```bash
# Look back 7 days; write candidates to a temp file
SINCE_DAYS=7 OUTPUT_PATH=/tmp/candidates.json \
  node packages/dev-tools/rum-error-triage/triage-rum-errors.mjs

# Unit tests
npx vitest run --project dev-tools
```

### Environment variables

| Var               | Default                                      | Meaning                          |
| ----------------- | -------------------------------------------- | -------------------------------- |
| `SINCE_DAYS`      | `1`                                          | Look-back window in days         |
| `SLICC_RUM_HOSTS` | `localhost,akjjllgokmbgpbdbmafpiefnhidlmbgf` | Hostnames carrying SLICC traffic |
| `RUM_BQ_PROJECT`  | `helix-225321`                               | BigQuery billing/project id      |
| `TRIAGE_LABEL`    | `rum-error`                                  | Label used for dedup and filing  |
| `OUTPUT_PATH`     | `rum-error-candidates.json`                  | Where to write the candidates    |
