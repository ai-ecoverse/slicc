# Pre-push / PR validation

Most of this content lives in
[`.agents/skills/verifying-before-push/SKILL.md`](../.agents/skills/verifying-before-push/SKILL.md).
The stacked-PR CI contract is documented here so a search of `docs/` finds it.

## Stacked PRs

A stacked PR is one whose base is another topic branch, not `main`.
`ci.yml` uses `pull_request.branches-ignore: [no-comment]`. PRs based on
the `no-comment` benchmark mirror still get no CI. Every other base, including
topic-branch stacks, runs the workflow from the PR's merge commit.

### What runs

| Surface                                                        | On a stack              | On a `main`-based PR / merge queue             |
| -------------------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| Path-filtered ubuntu jobs (lint, typecheck, coverage, builds)  | yes                     | yes                                            |
| Cheap macOS `swift-*` + `ios-app` (lint / format / coverage)   | yes                     | yes (queue leader only)                        |
| `ios-app-tests` (4-way simulator matrix)                       | no                      | yes (queue leader only, when iOS paths change) |
| Aggregate check name                                           | `ci-stack`              | `ci`                                           |
| `ci.yml` `cloudflare-worker` local gates (build/dry-run/tests) | yes                     | yes                                            |
| Staging mutation (R2 / deploy / secrets / smoke)               | no                      | yes (trusted PRs; queue leader only)           |
| `worker-staging.yml` / screenshot workflows                    | no (`branches: [main]`) | yes, when their paths match                    |

Stacked runs never mutate staging. The deploy lives in `ci.yml`'s
`cloudflare-worker` job (`RUN_CLOUDFLARE_STAGING`), not only in
`worker-staging.yml`.

The aggregate must not be named `ci` on a stacked commit. Documented GitHub
behaviour is that a required check skipped by `if:` still satisfies branch
protection
([status checks](https://docs.github.com/en/pull-requests/reference/status-checks)).
This change does not rely on that: stacked runs never mint a check named `ci`.
The ruleset on `main` requires exactly one context, `ci`. A green or skipped
`ci` on a simulator-less stacked SHA would let a retargeted PR reach `main`
with the simulators never run anywhere — merge-queue non-leaders already skip
every macOS job and rely on the PR-level run.

### After you retarget to `main`

`edited` is not a `pull_request` type here. `concurrency.cancel-in-progress`
is `true`, so handling `edited` would cancel an in-flight run on a title/body
edit. `PATCH`ing the base to `main` therefore does not start CI.

Any later `synchronize` event (new commit, rebase, or force-push) starts the
full `main`-based run. Close + reopen is the recommended recipe when you have
no code change:

```bash
gh pr close <n> && gh pr reopen <n>
```

That run includes `ios-app-tests` (when iOS paths changed) and reports the
aggregate as `ci`.

### `delete_branch_on_merge`

The repo setting is `false` (owner decision; this change does not flip it).
GitHub will not auto-retarget a stacked child when its parent merges. Retarget
the child yourself, then close + reopen or push so the full `ci` set runs.
