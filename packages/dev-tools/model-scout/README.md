# Bedrock Model Scout — weekly dead-model-ID canary

A weekly check that invokes every Bedrock model ID this repo's workflows can
reach and opens (or updates) a GitHub issue when one of them is genuinely
unusable. It exists because Bedrock model IDs are **mutable infrastructure**:
they are retired, renamed, and superseded without notice, and a repository
variable holding a dead ID takes down every scheduled agent silently.

That is not hypothetical. `us.anthropic.claude-opus-4-9` — an ID that does not
exist — sat in a repo variable, five scheduled agents failed on every run, and
nothing noticed until someone read run logs by hand. One Monday probe would have
caught it.

It is a **monitor, not an agent**: deterministic, no Claude in the loop, no PR,
and no writes to any variable or workflow.

## Flow

```
cron (Mon 05:13 UTC) ─▶ scan-models.mjs ─▶ has_invalid? ─▶ create-or-update GitHub issue
                            │
                            ├─ read .github/workflows/*.yml
                            ├─ extract vars.*_BEDROCK_MODEL + hardcoded model-ID defaults
                            ├─ resolve each variable's value from env (see below)
                            └─ one 1-token InvokeModel per distinct ID → ok / invalid / inconclusive
```

1. **Extract** — `extractModelReferences(files)` derives the model surface from
   the workflow sources rather than a hand-maintained list: every
   `vars.*_BEDROCK_MODEL` name (with the workflows that read it) and every
   hardcoded Anthropic model-ID literal in the `||` chains. A hardcoded list
   would go stale exactly like the thing being monitored.
2. **Resolve** — `resolveProbeTargets(...)` maps each variable to its current
   value and dedupes into the distinct set of IDs to probe.
3. **Probe** — one `InvokeModel` per ID with `max_tokens: 1`.
4. **Classify** — `classifyProbeResult(...)`, the heart of it (see below).
5. **Report** — `buildReport(...)` decides whether anything is worth filing and
   renders the issue body. The workflow writes `has_invalid` / `all_inconclusive`
   / counts to `$GITHUB_OUTPUT` and files one rolling issue deduped by the
   `bedrock-model-scout` label, closing it once every ID answers again.

## `invalid` vs `inconclusive` is the whole design

| Response                                                         | Classification |
| ---------------------------------------------------------------- | -------------- |
| 2xx                                                              | `ok`           |
| `ResourceNotFoundException`                                      | `invalid`      |
| `ValidationException` naming the model ID / the model identifier | `invalid`      |
| `AccessDeniedException` saying the model is not accessible       | `invalid`      |
| 403 IAM/quota denial, `ServiceQuotaExceededException`            | `inconclusive` |
| 429 / `ThrottlingException` / `ModelNotReadyException`           | `inconclusive` |
| 5xx, timeout, transport error                                    | `inconclusive` |
| anything unrecognised                                            | `inconclusive` |

An `inconclusive` result is **never** reported as a dead model. A throttled
Monday that opened an issue telling someone to change a working variable would
be the last of these issues anybody reads. Three protections stack:

- `classifyProbeResult` defaults to `inconclusive` for anything it does not
  positively recognise as a model verdict, and treats a 403 as a permission
  problem unless the body names the model itself. An IAM denial quotes the model
  ARN, so "the body mentions the model ID" is deliberately **not** the rule for
  `AccessDeniedException`.
- `scan-models.mjs` retries only `inconclusive` results (`PROBE_ATTEMPTS`, with
  doubling backoff) before accepting them.
- When **every** probe comes back `invalid`, the report blames the credential
  rather than the model IDs. Bedrock rejects a retired ID and an account that
  lost its entitlement identically, so one revoked or misprovisioned token fails
  every probe at once, while real model IDs die one family at a time. The issue
  is still filed — that is an outage — but it says to check
  `AWS_BEARER_TOKEN_BEDROCK`, the region, and model access first, and it does not
  list every variable in the repo as needing a new value.
- `buildReport` files only on `invalid`. When every probe was inconclusive it
  files nothing **and** the run logs a `BLIND RUN` warning plus an Actions
  warning annotation — a canary that cannot tell you it is blind is worse than
  none.
- The auto-close step requires `inconclusive_count == 0`, so an open issue is
  resolved only when **every** ID returned a definite `ok`. The case that makes
  the weaker "not entirely blind" test wrong is narrow and likely: the very ID the
  issue is about comes back throttled while the others answer, which would close
  a live outage report without ever retesting the thing it reports.
- Commented-out references are stripped before scanning, so a disabled variable
  cannot trip the unwatched-variable guard and a retired ID left in a comment
  cannot be probed and reported dead.

A healthy week files nothing at all. There is no weekly "all good" issue.

## Why the variable values arrive as env

A GitHub Actions token **cannot read repository variables through the API** — it
is a hard 403. `${{ vars.X }}` interpolation is the only way the script learns a
variable's current value, so `.github/workflows/model-scout.yml` passes every
`*_BEDROCK_MODEL` variable in as env. Since the variable list is derived from the
workflows, that env block is the one hand-maintained thing in this package, and
`scan-models.mjs` **fails the run** (exit 3) when a workflow references a
variable that is not in it. A new workflow variable therefore cannot silently
escape the canary.

A variable that is present but empty is simply unset in the repo: the `||` chain
falls through to the next entry, which is expected and logged, not an error.

## Out of scope

No discovery of _new_ models by probing invented IDs, and no replacement ID is
ever guessed. `suggestReplacement` only names an ID that was probed `ok` **in the
same run** and belongs to the same model family; otherwise the issue says plainly
that no verified replacement was found. Naming an unverified ID is how a "fix"
becomes the next outage.

## Run it locally

```bash
AWS_BEARER_TOKEN_BEDROCK=<ABSK… bedrock api key> \
AWS_REGION=us-east-1 \
BACKLOG_BEDROCK_MODEL= BOY_SCOUT_BEDROCK_MODEL= COMPACTOR_BEDROCK_MODEL= \
FLAKY_HUNTER_BEDROCK_MODEL= PATCH_RECONCILE_BEDROCK_MODEL= PR_FIX_BEDROCK_MODEL= \
PR_REVIEW_BEDROCK_MODEL= REVIEW_RESPONDER_BEDROCK_MODEL= RUM_BEDROCK_MODEL= \
SINS_BEDROCK_MODEL= \
  node packages/dev-tools/model-scout/scan-models.mjs

# Unit tests
node node_modules/vitest/vitest.mjs run --project dev-tools

# Probe-free dry run on GitHub (still calls Bedrock; skips issue writes)
gh workflow run model-scout.yml -f dry_run=true
```

Every `*_BEDROCK_MODEL` key must be present (empty is fine) or the run exits 3.

### Environment variables

| Var                        | Meaning                                     | Default                 |
| -------------------------- | ------------------------------------------- | ----------------------- |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key (bearer token)              | — (required)            |
| `AWS_REGION`               | Region to probe                             | `us-east-1`             |
| `<NAME>_BEDROCK_MODEL`     | Current value of each workflow variable     | — (key must exist)      |
| `WORKFLOWS_DIR`            | Directory to scan                           | `.github/workflows`     |
| `REPORT_FILE`              | Markdown report the workflow files as issue | `model-scout-report.md` |
| `PROBE_ATTEMPTS`           | Attempts per inconclusive ID                | `3`                     |
| `PROBE_BACKOFF_MS`         | First backoff, doubling                     | `2000`                  |

The workflow lives in `.github/workflows/model-scout.yml`. All extraction,
classification, and reporting rules are pure and unit-tested in `lib.test.mjs`
(the `dev-tools` vitest project).
