# PR Review Gate — the "does this PR still need a review?" check

Codex/Copilot reviews are _personal_ reviewers: they only run on PRs opened by
the account owner. PRs opened by anyone else get no automated review. This gate
lets a Claude Code review fill that gap without double-reviewing the author's
own PRs.

## Flow

```
PR opened ─▶ sleep 300 ─▶ check-pr-review-gate.mjs ─▶ should_review? ─▶ claude-code-action (inline comments + summary)
                            │
                            ├─ GET /pulls/{n}            (state, draft)
                            └─ GET /pulls/{n}/comments   (inline review comments)
```

1. **Wait** — the workflow sleeps 5 minutes after the PR is opened, giving
   personal/human reviewers time to leave inline comments first.
2. **Gate** — `check-pr-review-gate.mjs` reads the PR state/draft flag and the
   PR's inline review comments from the GitHub REST API, then calls the pure
   `decideReview(...)` logic in `lib.mjs`. It writes `should_review=<bool>` and
   `reason=<text>` to `$GITHUB_OUTPUT`.
3. **Review** — only when `should_review == 'true'` does
   `anthropics/claude-code-action` run, posting inline comments via
   `mcp__github_inline_comment__create_inline_comment` plus a top-level summary
   via `gh pr comment`.

This produces the desired split: on the author's own PR, Codex/Copilot leave
inline comments within 5 minutes → Claude skips; on someone else's PR, no
personal review exists → Claude reviews.

The workflow lives in `.github/workflows/claude-pr-review.yml`.

## Design notes

- **Pure logic is isolated and tested.** `lib.mjs` contains the decision logic
  (`decideReview`, `countInlineReviewComments`) with no I/O, unit-tested in
  `lib.test.mjs` (run via the `dev-tools` vitest project in `npm test`).
  `check-pr-review-gate.mjs` only talks to the GitHub REST API and
  `$GITHUB_OUTPUT`.
- **Skip rules.** The gate skips when the PR is not `open`, is a draft, or
  already has any inline review comment. Otherwise it reviews.

## Required secrets / variables (GitHub Actions)

These are shared with `rum-error-triage` — no new secrets are required.

| Name                       | Kind     | Purpose                                                                                                            |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `AWS_BEARER_TOKEN_BEDROCK` | secret   | Amazon Bedrock API key (Adobe CAMP `ABSK...` bearer token) used by `claude-code-action` (`use_bedrock`).           |
| `RUM_AWS_REGION`           | variable | Optional. Bedrock region for the CAMP key (default `us-east-1`).                                                   |
| `PR_REVIEW_BEDROCK_MODEL`  | variable | Optional. Bedrock model for reviews; falls back to `RUM_BEDROCK_MODEL`, then `global.anthropic.claude-sonnet-4-6`. |

## Run it locally

Requires a `GH_TOKEN` with read access to the repo.

```bash
REPO=owner/repo PR_NUMBER=123 GH_TOKEN=$(gh auth token) \
  node packages/dev-tools/pr-review-gate/check-pr-review-gate.mjs

# Unit tests
npx vitest run --project dev-tools
```

### Environment variables

| Var         | Meaning                                  |
| ----------- | ---------------------------------------- |
| `REPO`      | `owner/repo` of the pull request         |
| `PR_NUMBER` | The pull request number to gate          |
| `GH_TOKEN`  | Token used for the GitHub REST API reads |
