# Weekend CLAUDE.md Compactor

A weekly job that keeps the repo's machine-read instruction guides small. Every
Saturday night a deterministic Node step measures every **tracked** file named
`CLAUDE.md` and hands the oversized ones to `claude-code-action`, which rewrites
them and opens exactly **one** pull request. Nothing oversized → no branch, no
PR; silence is a valid outcome. Driven by
`.github/workflows/claude-md-compactor.yml`. Mirrors the
`packages/dev-tools/codebase-sins/` layout (pure logic + CLI + co-located tests
run by the `dev-tools` vitest project).

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

## Files

- `lib.mjs` — pure logic: the policy constants, the excluded-guide predicate,
  `measureGuides`, `selectOversized`, `formatReport` (the before/after markdown
  table), `buildBranchName`, `findExistingCompactionPr`, and `buildPrompt`. No
  I/O; unit-tested in `lib.test.mjs`.
- `measure-claude-guides.mjs` — CLI (I/O only): the `git ls-files` walk, the file
  reads, the open-PR query, `$GITHUB_OUTPUT` / `$GITHUB_STEP_SUMMARY` writes, and
  the `--check` post-compaction gate.

## Run it locally

```bash
# Measure only, no GitHub API calls (prints the table and the branch name)
REPO=ai-ecoverse/slicc SKIP_PR_CHECK=1 GH_TOKEN=x \
  node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs

# The post-compaction invariant: exit 1 if any tracked guide is still >= the
# limit, or if a guide that was handed to Claude came back above the target
WORKLIST=packages/foo/CLAUDE.md,packages/bar/CLAUDE.md \
  node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check

# Unit tests
npx vitest run --project dev-tools packages/dev-tools/claude-md-compactor/lib.test.mjs
```

### Environment variables

| Var                   | Default      | Meaning                                                            |
| --------------------- | ------------ | ------------------------------------------------------------------ |
| `REPO`                | _(required)_ | `owner/repo` for the open-PR dedup query                           |
| `GH_TOKEN`            | _(required)_ | Token for the GitHub API                                           |
| `MAX_CHARS`           | `10000`      | Oversized threshold override                                       |
| `TARGET_CHARS`        | `9500`       | Compaction target override                                         |
| `SKIP_PR_CHECK`       | _(unset)_    | `1` skips the dedup query (offline runs; `REPO`/`GH_TOKEN` unused) |
| `WORKLIST`            | _(unset)_    | `--check` only: the guides held to `TARGET_CHARS` (see below)      |
| `GITHUB_OUTPUT`       | _(unset)_    | Actions output file; results appended when set                     |
| `GITHUB_STEP_SUMMARY` | _(unset)_    | Actions summary file; the table appended when set                  |

`--check` needs only `WORKLIST`, and works without even that.

### Why `--check` needs the worklist

Two different invariants: every tracked guide must be under `MAX_CHARS`, and the
guides Claude was actually asked to rewrite must have reached `TARGET_CHARS` —
which is what the brief promised. Checking survivors against the max alone only
proves they left the oversized band, so a guide parked just under `MAX_CHARS`
would pass and then be re-selected the following week for nothing. The worklist
has to be carried in from the measuring run (its `worklist` output), because a
successfully rewritten guide no longer looks oversized to a fresh measurement.

### Outputs

`has_oversized`, `oversized_count`, `branch`, `existing_pr`, `worklist`, and the
multi-line `report` and `prompt`.

## Exit codes

`0` on a clean run (work found or not, including the no-op); `1` on a `--check`
violation or an unexpected API failure; `2` on missing required env.
