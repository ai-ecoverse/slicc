# Flake ledger

Surfaces tests that **failed and then passed on retry** in CI, so a retry leaves a paper trail instead of a green build and silence.

`vitest.config.ts` gives the `node-server` and `chrome-extension` projects `retry: 1` in CI. That absorbs a single infrastructure hiccup — and it also hides genuine nondeterminism, because vitest reports only the final state of a test. The ledger reads it back out of the test-timing artifacts CI already uploads and files one GitHub issue per flaky test.

## How a retried test appears in vitest 4.1.10

vitest's built-in `json` reporter has **no** retry field: `assertionResults` entries carry only `ancestorTitles`, `fullName`, `status`, `title`, `duration`, `failureMessages`, `location`, `meta`, and `tags`.

The retry evidence survives anyway. vitest appends every attempt's errors to `task.result.errors` and reports only the last state, so a retried pass is a `passed` assertion **with a non-empty `failureMessages` array**:

```json
{
  "fullName": "flake probe passes only on the second attempt",
  "status": "passed",
  "failureMessages": [
    "AssertionError: probe attempt 1 is deliberately failing: expected 1 to be greater than 1"
  ]
}
```

A test that failed _every_ attempt is `"status": "failed"` with one message per attempt — a real failure, not a flake. A clean pass and an `it.fails` expected failure both carry an empty `failureMessages`, so neither is a false positive. (Verified empirically with a probe test under `--retry=1`.)

`flake-reporter.mjs` is an optional precision upgrade: vitest's reporter API _does_ expose the real number via `TestCase.diagnostic().retryCount`, so the reporter writes an exact `test-timing/flakes.json`. It is not wired into `vitest.config.ts` — the ledger works without it. To enable:

```ts
reporters: isCI
  ? ['default', 'json', './packages/dev-tools/flake-ledger/flake-reporter.mjs']
  : ['default'],
```

Note that `diagnostic().flaky` is `true` for every `it.fails` test (vitest retries the throwing body, then flips the state to pass), which is why the reporter skips `options.fails`.

## Layout

| File                 | Role                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `lib.mjs`            | Pure logic: parsing both artifact shapes, aggregation, fingerprints, issue rendering |
| `lib.test.mjs`       | Unit tests (`vitest run --project dev-tools`)                                        |
| `flake-reporter.mjs` | Optional vitest reporter recording the exact `retryCount`                            |
| `sweep-flakes.mjs`   | Orchestrator: downloads artifacts with `gh`, files/updates issues                    |

## Running the sweep locally

```bash
# dry run against the last day of CI runs on main — prints, files nothing
FLAKE_DRY_RUN=1 node packages/dev-tools/flake-ledger/sweep-flakes.mjs
```

Env: `SINCE_DAYS` (default 1), `RUN_LIMIT` (default 40), `WORKFLOW` (default `ci.yml`), `BRANCH` (default `main`), `FLAKE_LABEL` (default `debt:flake`), `FLAKE_DRY_RUN`, `OUTPUT_PATH`.

## Why it never fails a build

A flake ledger that turns every flake red is just the retry removed. The sweep runs in its own nightly workflow, not in `ci.yml`, and only ever writes issues. Policy: see `docs/operational-telemetry.md`.
