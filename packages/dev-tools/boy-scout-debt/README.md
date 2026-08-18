# Boy Scout Debt Dispatcher — daily one-file debt payoff

A daily job that selects **exactly one** tractable file currently on the
repository's boy-scout debt lists and hands a focused refactor brief to
claude-code-action, which cleans the file and pushes a branch — a deterministic
workflow step then opens the pull request (see
[Why Claude does not open the PR](#why-claude-does-not-open-the-pr)).
Where [`codebase-sins/`](../codebase-sins/README.md) _files issues_ about
qualitative debt, this pays down debt the repo already tracks mechanically.

Layout mirrors `codebase-sins/`: pure logic + CLI + co-located tests run by the
`dev-tools` vitest project.

## The six debt lists

Authoritative procedure:
[`.agents/skills/verifying-before-push/SKILL.md`](../../../.agents/skills/verifying-before-push/SKILL.md).
Gate: [`../tools/check-touched-exemptions.mjs`](../tools/check-touched-exemptions.mjs).

| Category id             | Source                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `function-size`         | `biome.json` override → `complexity.noExcessiveLinesPerFunction: "off"`                        |
| `cognitive-complexity`  | `biome.json` override → `complexity.noExcessiveCognitiveComplexity: "off"`                     |
| `floating-promise`      | `biome.json` override → `nursery.noFloatingPromises: "off"`                                    |
| `misused-promise`       | `biome.json` override → `nursery.noMisusedPromises: "off"`                                     |
| `layer-back-edge`       | [`../tools/layer-back-edge-baseline.json`](../tools/layer-back-edge-baseline.json)             |
| `record-string-unknown` | [`../tools/record-string-unknown-baseline.json`](../tools/record-string-unknown-baseline.json) |

Biome globs are parsed with `extractExemptionGlobsFor` from
[`../tools/size-exemption-lib.mjs`](../tools/size-exemption-lib.mjs), which by
construction matches only overrides whose **sole** rule customization is the one
named rule set to `"off"`. The multi-rule test-file-wide override is blanket
policy, not boy-scout debt, and is therefore never a candidate.

## Selection rules

1. Every debt entry must resolve to **one concrete tracked file**. A glob that
   matches many files (e.g. `**/*.test.ts`) is policy, not a per-file debt item,
   and is dropped; so is a glob or baseline key that matches nothing (stale).
2. Generated, vendored, minified, lockfile, and generated-vector paths are never
   candidates (`isExcludedPath`).
3. Candidates are scored **smallest-first**, scaled by how many debt lists the
   file is on — every applicable category must be paid off in the same PR, so a
   multi-category file is more work than its byte count suggests. Ties break by
   path, so the pick is deterministic.
4. Files touched by a currently **open** pull request are skipped. That is the
   only cross-run dedup: no state file, no Actions cache. A still-open PR from a
   previous run takes its file out of the pool instead of blocking the routine.
5. A `FILE_OVERRIDE` (the `workflow_dispatch` input) wins outright, but must
   still be a tractable candidate.
6. No unclaimed candidate → **no-op**, exit 0, no Claude run. A quiet day is a
   valid result.

## Files

- `lib.mjs` — pure logic: `DEBT_CATEGORIES` (the six descriptors, each carrying
  the exact remediation instruction), `resolveGlobToSingleFile`, `buildDebtMap`,
  `isExcludedPath`, `scoreCandidate`, `buildCandidates`, `slugForFile`,
  `selectDebtFile`, and `buildPrompt`. No I/O; unit-tested in `lib.test.mjs`.
- `select-debt-file.mjs` — CLI (I/O only): reads `biome.json` and both
  baselines, resolves globs against `git ls-files`, stats file sizes, fetches
  the claimed-file set from open PRs over the REST API, then writes
  `has_candidate`, `file`, `categories`, `slug`, and the multi-line `prompt` to
  `$GITHUB_OUTPUT` (plus a job-summary table).

Driven by
[`.github/workflows/boy-scout-debt-dispatcher.yml`](../../../.github/workflows/boy-scout-debt-dispatcher.yml)
(daily at 02:17 UTC). That workflow checks out with `secrets.BOT_PAT`, because
GitHub suppresses workflow runs for `GITHUB_TOKEN`-authored pushes and the
cleanup PR must get the full check suite.

## Why Claude does not open the PR

Two phases, deliberately: **Claude pushes the branch and writes the PR body to
`$PR_BODY_FILE`; a deterministic shell step opens the PR.** The brief forbids
`gh pr create` outright.

The reason is token identity. `claude-code-action` overrides `GH_TOKEN` for its
Bash tool with its own `github_token:` input, which this workflow deliberately
sets to `${{ github.token }}` (an OIDC → GitHub App exchange fails on this repo),
so Claude's `gh` is always `GITHUB_TOKEN`. A PR created with `GITHUB_TOKEN` is
authored by `github-actions[bot]`, and GitHub queues every workflow run for such
a PR as `action_required` — the PR sits at **zero checks** until a human clicks
"Approve and run". For a change whose entire purpose is to satisfy
`check-touched-exemptions.mjs`, that is worthless. The deterministic step is the
same shape [`coverage-ratchet.yml`](../../../.github/workflows/coverage-ratchet.yml)
uses, and those PRs pick up the full suite unattended.

The step is a clean no-op (never a failure) when Claude pushed nothing, when the
branch is not ahead of `origin/main`, or when no body file was written — which is
what the brief's "if the honest fix is prohibited, report instead" escape hatch
produces. It also skips creation when an open PR for the head already exists.

Two tokens, because `BOT_PAT` is scoped to **contents + pull-requests only**:

| Call                                         | Token          | Why                                                        |
| -------------------------------------------- | -------------- | ---------------------------------------------------------- |
| `gh pr create`                               | `BOT_PAT`      | The author's events must trigger CI.                       |
| `gh label create` / `gh pr edit --add-label` | `GITHUB_TOKEN` | Labels are an Issues API write; `BOT_PAT` has no `issues`. |

Passing `--label` to `gh pr create` under `BOT_PAT` would 403 and lose the PR, so
the label is always a separate `gh pr edit` call.

## Run it locally

```bash
# Full offline dry run — enumerate the debt lists and pick a file, no network
SKIP_CLAIMED=1 GITHUB_OUTPUT=/tmp/out.txt \
  node packages/dev-tools/boy-scout-debt/select-debt-file.mjs

# With real open-PR dedup
REPO=ai-ecoverse/slicc GH_TOKEN=$(gh auth token) \
  node packages/dev-tools/boy-scout-debt/select-debt-file.mjs

# Unit tests
npx vitest run --project dev-tools packages/dev-tools/boy-scout-debt/lib.test.mjs
```

### Environment variables

| Var                   | Default         | Meaning                                                         |
| --------------------- | --------------- | --------------------------------------------------------------- |
| `REPO`                | _(required)_    | `owner/repo` for the open-PR dedup reads                        |
| `GH_TOKEN`            | _(required)_    | Token with `pull-requests: read`                                |
| `FILE_OVERRIDE`       | _(auto-select)_ | `workflow_dispatch` override: exact repo-relative path          |
| `SKIP_CLAIMED`        | _(unset)_       | `1` skips the open-PR reads — offline runs; dedup disabled      |
| `GITHUB_OUTPUT`       | _(unset)_       | Actions output file; the CLI appends results when set           |
| `GITHUB_STEP_SUMMARY` | _(unset)_       | Actions job summary; the CLI appends a candidate table when set |

Exit codes: `0` on a pick **and** on a clean no-op; non-zero only on missing env
or an unexpected GitHub API failure.
