# RUM Error Triage — the error-to-insight pipeline

SLICC has no Sentry. Operational errors are reported through RUM (Real User
Monitoring) as `error` checkpoints in the helix BigQuery `cluster` table (see
`packages/webapp/src/ui/telemetry.ts`). This tool turns those errors into
actionable GitHub issues, automatically, every night.

## Flow

```
nightly cron ─▶ triage-rum-errors.mjs ─▶ rum-error-candidates.json ─▶ claude-code-action ─▶ issues (+ draft PRs)
                  │                          ▲
                  ├─ bq query (RUM errors)   │ deduped vs. existing rum-fp markers
                  └─ gh issue list (dedup) ──┘
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
3. **Classify + file** — new candidates are written to
   `rum-error-candidates.json`, and `anthropics/claude-code-action` reads them,
   investigates each against the codebase, and opens an issue (and, when the fix
   is clear and low-risk, a draft PR) for the genuine bugs — embedding the
   `rum-fp` marker so the next run recognises it.

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

## Required secrets (GitHub Actions)

| Secret              | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `RUM_BQ_SA_KEY`     | GCP service-account JSON with **BigQuery Job User** + **Data Viewer** on `helix-225321`. |
| `ANTHROPIC_API_KEY` | Key for `claude-code-action` (classification + issue/PR authoring).                      |

Workload Identity Federation is the preferred long-term replacement for the
service-account key — see `google-github-actions/auth`.

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
