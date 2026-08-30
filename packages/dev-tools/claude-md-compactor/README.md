# Weekend CLAUDE.md Compactor

A weekly job that keeps the repo's machine-read instruction guides small. Every
Saturday night a deterministic Node step measures every **tracked** file named
`CLAUDE.md` and hands the **single largest** oversized guide to
`claude-code-action` (one file per run, same shape as the boy-scout dispatcher).
Claude rewrites it in the working tree (no git, no tests). A deterministic
workflow step then copies those files onto **one** branch from `origin/main`
and opens exactly **one** pull request from it (see
[Why Claude does not open the PR](#why-claude-does-not-open-the-pr)). Nothing
oversized → no branch, no PR; silence is a valid outcome. Driven by
`.github/workflows/claude-md-compactor.yml`. Handing Claude every oversized
guide at once made it spawn-and-wait for subagents and end the turn with zero
edits ([dispatch 33309651347](https://github.com/ai-ecoverse/slicc/actions/runs/33309651347)).
Mirrors the `packages/dev-tools/codebase-sins/` layout (pure logic + CLI +
co-located tests run by the `dev-tools` vitest project).

## Two budgets — do not confuse them

|             | Repo size **gate**                                                              | Compactor **policy**                                                                                |
| ----------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Limit       | 20,000 chars                                                                    | oversized at 10,000 chars, rewritten to ≤ 9,500                                                     |
| Scope       | `packages/*/CLAUDE.md` only                                                     | every tracked `CLAUDE.md` (root, `docs/`, all packages)                                             |
| Owner       | `packages/dev-tools/tools/check-doc-sizes-lib.mjs` (`PACKAGE_CLAUDE_MAX_CHARS`) | `packages/dev-tools/claude-md-compactor/lib.mjs` (`COMPACTOR_MAX_CHARS` / `COMPACTOR_TARGET_CHARS`) |
| Enforcement | hard CI failure via `npm run lint:docs`                                         | this workflow only                                                                                  |

The policy sits far below the gate and covers strictly more files: a guide at
12,000 chars passes `npm run lint:docs` but is compaction work. The compactor
never edits, reads around, or relaxes the gate — and the composed prompt says so
explicitly.

`packages/vfs-root/shared/CLAUDE.md` (the agent-facing runtime guide) is budgeted
at **3,000 bytes** by `packages/dev-tools/tools/check-doc-sizes.mjs` — stricter
than the policy and measured in bytes. It is excluded outright and can never be
selected for compaction.

## Measurement invariants

- Guides are discovered with `git ls-files`, so untracked and generated files can
  never be picked up.
- Size is JavaScript `text.length` (UTF-16 code units), matching the repo's own
  gate. Byte counts (`wc -c`, `Buffer.byteLength`) are **not** authoritative and
  differ for any non-ASCII guide.
- The threshold is inclusive: exactly 10,000 characters is oversized.

## Cross-run deduplication

GitHub-native: the CLI queries open PRs and reports the first whose head branch
starts with `automation/weekend-claude-compaction-` or whose title starts with
`chore(docs): compact CLAUDE.md guides`. The workflow then skips the Claude step.
No state file, no state branch, no Actions cache.

## Why Claude does not open the PR

Two phases, deliberately: **Claude only edits the worklist (and overflow under
`docs/`)**. The recover step copies those files onto a branch from `origin/main`,
synthesises `$PR_BODY_FILE` if Claude left it empty, and a later shell step opens
the PR with `GH_TOKEN: secrets.BOT_PAT`, using the `pr_title` output so the title
stays on the `COMPACTION_PR_TITLE` constant. The brief forbids `gh pr create`
and `git push`. A dispatch from a feature branch (the #2676 workflow PR) must
not leak that branch's YAML/docs into the compaction PR, and must not reopen a
closed same-day PR (#2677) — the branch name includes `GITHUB_RUN_ID`.

The reason is token identity. `claude-code-action` overrides `GH_TOKEN` for its
Bash tool with its own `github_token:` input, which this workflow sets to
`${{ github.token }}` (an OIDC → GitHub App exchange fails on this repo), so
Claude's `gh` is always `GITHUB_TOKEN`. A PR created with `GITHUB_TOKEN` is
authored by `github-actions[bot]`, and GitHub queues every workflow run for such a
PR as `action_required`: the PR sits at **zero checks** until a human clicks
"Approve and run". The deterministic step is the same shape
[`coverage-ratchet.yml`](../../../.github/workflows/coverage-ratchet.yml) uses.

Recover publishes after `--check` **or** a recovered partial: if `--check` fails
but the selected guides actually got smaller (and none grew), `--progress` still
opens the PR so the shrinkage is not discarded. A miss with no shrinkage (Claude
ran and left every selected guide at its pre-run size) still must not become a
PR. Hitting the target without writing `$PR_BODY_FILE` used to skip `gh pr
create`; `--progress` now synthesises a body whenever `openPr` is true. This
workflow applies no label, so it needs no second token — the
`BOT_PAT`/`GITHUB_TOKEN` split for create-vs-label only matters in the sibling
dispatchers
([boy-scout](../boy-scout-debt/README.md#why-claude-does-not-open-the-pr)),
where `BOT_PAT`'s missing `issues` permission forces the label into its own
`gh pr edit` call under `GITHUB_TOKEN`.

## Partial recovery

`--check` is the hard invariant and still fails the verify step when a selected
guide is above `TARGET_CHARS`. That used to skip the PR (Actions `success()`
gating; [run 33283868860](https://github.com/ai-ecoverse/slicc/actions/runs/33283868860)).
The verify step now `continue-on-error`s into `--progress`, which compares the
working tree to the measure step's `before_sizes` JSON:

- at least one worklist guide strictly smaller, none larger, none missing, no
  _new_ oversized guide off the worklist, **or** every selected guide hit the
  target → exit 0, synthesise a PR body if Claude left `$PR_BODY_FILE` empty,
  copy those files onto a new branch from `origin/main`, `git push --no-verify`
  (husky pre-push is a human gate; dispatch 33315681779 compacted then died
  there on dead anchors Claude left — CI on the PR still checks those), open
  the PR. Next Saturday skips while that PR is open.
- otherwise → exit 1, no PR, same as before.

## Files

- `lib.mjs` — pure logic: the policy constants, the excluded-guide predicate,
  `measureGuides`, `selectOversized`, `formatReport` (the before/after markdown
  table), `buildBranchName`, `findExistingCompactionPr`, `buildPrompt`,
  `assessCompactionProgress` / `formatProgressReport` / `buildPartialPrBody` /
  `buildCompactionPrBody` / `selectPublishPaths` (the failed-`--check` recovery
  path). No I/O; unit-tested in `lib.test.mjs`.
- `measure-claude-guides.mjs` — CLI (I/O only): the `git ls-files` walk, the file
  reads, the open-PR query, `$GITHUB_OUTPUT` / `$GITHUB_STEP_SUMMARY` writes, the
  `--check` post-compaction gate, `--progress` recovery, and `--publish-paths`.

## Run it locally

```bash
# Measure only, no GitHub API calls (prints the table and the branch name)
REPO=ai-ecoverse/slicc SKIP_PR_CHECK=1 GH_TOKEN=x \
  node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs

# The post-compaction invariant: exit 1 if any tracked guide is still >= the
# limit, or if a guide that was handed to Claude came back above the target
WORKLIST=packages/foo/CLAUDE.md,packages/bar/CLAUDE.md \
  node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check

# Recovery after a failed --check: exit 0 iff the worklist actually shrank
WORKLIST=packages/foo/CLAUDE.md BEFORE_SIZES='{"packages/foo/CLAUDE.md":19998}' \
  node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --progress

# Unit tests
npx vitest run --project dev-tools packages/dev-tools/claude-md-compactor/lib.test.mjs
```

### Environment variables

| Var                   | Default      | Meaning                                                               |
| --------------------- | ------------ | --------------------------------------------------------------------- |
| `REPO`                | _(required)_ | `owner/repo` for the open-PR dedup query                              |
| `GH_TOKEN`            | _(required)_ | Token for the GitHub API                                              |
| `MAX_CHARS`           | `10000`      | Oversized threshold override                                          |
| `TARGET_CHARS`        | `9500`       | Compaction target override                                            |
| `SKIP_PR_CHECK`       | _(unset)_    | `1` skips the dedup query (offline runs; `REPO`/`GH_TOKEN` unused)    |
| `WORKLIST`            | _(unset)_    | `--check`/`--progress`: the guides held to `TARGET_CHARS` (see below) |
| `BEFORE_SIZES`        | _(unset)_    | `--progress`: JSON object of path → pre-Claude char counts            |
| `PR_BODY_FILE`        | _(unset)_    | `--progress`: synthesise a PR body here if empty                      |
| `SHRUNK_PATHS_FILE`   | _(unset)_    | `--progress`: newline-separated paths that shrank                     |
| `ORIG_SHA`            | _(unset)_    | `--publish-paths`: pre-Claude checkout SHA (`github.sha`)             |
| `PUBLISH_PATHS_FILE`  | _(unset)_    | `--publish-paths`: guide and docs/ files to copy onto `origin/main`   |
| `GITHUB_RUN_ID`       | _(unset)_    | appended to the compaction branch name (set automatically in Actions) |
| `GITHUB_OUTPUT`       | _(unset)_    | Actions output file; results appended when set                        |
| `GITHUB_STEP_SUMMARY` | _(unset)_    | Actions summary file; the table appended when set                     |

`--check` needs only `WORKLIST`, and works without even that. `--progress` needs
`BEFORE_SIZES` (and `WORKLIST`) to know whether the working tree is actually
smaller than the pre-Claude measurement.

### Why `--check` needs the worklist

Two different invariants: every tracked guide must be under `MAX_CHARS`, and the
guides Claude was actually asked to rewrite must have reached `TARGET_CHARS` —
which is what the brief promised. Checking survivors against the max alone only
proves they left the oversized band, so a guide parked just under `MAX_CHARS`
would pass and then be re-selected the following week for nothing. The worklist
has to be carried in from the measuring run (its `worklist` output), because a
successfully rewritten guide no longer looks oversized to a fresh measurement.

### Outputs

`has_oversized`, `oversized_count`, `branch`, `pr_title` (the fixed
`COMPACTION_PR_TITLE`, consumed by the `gh pr create` step), `existing_pr`,
`worklist`, `before_sizes` (JSON path → pre-Claude char counts, consumed by
`--progress`), and the multi-line `report` and `prompt`. `--progress` adds
`recovered` and `open_pr`.

## Exit codes

`0` on a clean run (work found or not, including the no-op) and on a recovered
`--progress`; `1` on a `--check` violation, a `--progress` with no shrinkage, or
an unexpected API failure; `2` on missing required env.
