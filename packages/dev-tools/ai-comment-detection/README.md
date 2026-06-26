# AI Comment Detection

Labels PR and issue threads by who is actually talking, so human contributions
don't drown in bot/AI chatter:

- **`ai-generated`** — every contribution on the thread is bot/AI.
- **`human-in-the-loop`** — at least one human has contributed.

A "thread" is, for a PR, the PR body plus every issue comment, review comment,
and non-empty review; for an issue, the issue body plus every comment.

## How it classifies

Each contribution runs through a **cost-ordered cascade** (`lib.mjs`), stopping
at the first signal that fires:

1. **Account (cheap)** — GitHub user `type === 'Bot'`, a comment posted through a
   GitHub App token, or a bot-looking login (`*[bot]`, `*-bot`, `*-ci`, or a
   known bot in `DEFAULT_BOT_LOGINS`).
2. **Markdown density (medium)** — count of markdown features (headings, bullets,
   bold, code, links, tables, …) per word. Heavily formatted prose above
   `MARKDOWN_DENSITY_THRESHOLD` reads as machine-generated.
3. **Similarity (expensive)** — max Jaccard similarity of the contribution's word
   set against its sibling contributions. A near-duplicate above
   `SIMILARITY_THRESHOLD` is a templated/boilerplate post.
4. **Pangram (fallback)** — only when nothing above fired and the text is long
   enough, the [Pangram](https://docs.pangram.com) async detection API is asked.

When Pangram is unconfigured, the text is too short, or the call fails, the
contribution **defaults to human** — a thread is never labelled `ai-generated`
on a missing signal. The thread label is then `human-in-the-loop` if any
contribution is human, else `ai-generated` (`decideLabels`).

## Files

| File                         | Purpose                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `lib.mjs`                    | Pure classification + labelling logic (no I/O). Unit-tested.                                   |
| `lib.test.mjs`               | Vitest suite (runs in the `dev-tools` vitest project).                                         |
| `detect-comment-authors.mjs` | Driver: reads the GitHub event, gathers the thread via `gh`, calls Pangram, applies the label. |

## Run locally

The driver reads the Actions event payload, so point it at a sample event:

```bash
GITHUB_REPOSITORY=ai-ecoverse/slicc \
GITHUB_EVENT_PATH=/path/to/event.json \
GH_TOKEN=$(gh auth token) \
PANGRAM_API_KEY=… \
node packages/dev-tools/ai-comment-detection/detect-comment-authors.mjs
```

`event.json` needs either `pull_request.number` (PR / review events) or
`issue.number` (the `issues` event, or an `issue_comment` on a PR or issue —
`issue.pull_request` present means a PR, absent means a plain issue).
`PANGRAM_API_KEY` is optional — omit it to run the cheap + medium heuristics
only.

## Tests

```bash
npm run test            # full suite
npx vitest run --project dev-tools packages/dev-tools/ai-comment-detection
```

## CI

`.github/workflows/ai-comment-detection.yml` runs the driver on `pull_request`,
`issues`, `issue_comment`, `pull_request_review`, and
`pull_request_review_comment` events, serialized per thread. It ensures the two
labels exist, then classifies and labels the thread. The optional
`PANGRAM_API_KEY` repository secret enables the fallback tier; without it the
workflow still runs (cheap + medium heuristics).

## Configuration

| Env                | Default                                 | Purpose                                                  |
| ------------------ | --------------------------------------- | -------------------------------------------------------- |
| `PANGRAM_API_KEY`  | _(unset)_                               | Pangram `x-api-key`; skips the fallback tier when unset. |
| `PANGRAM_BASE_URL` | `https://text.external-api.pangram.com` | Pangram API base URL.                                    |

Thresholds (`MARKDOWN_DENSITY_THRESHOLD`, `SIMILARITY_THRESHOLD`) and the bot
login set (`DEFAULT_BOT_LOGINS`) live in `lib.mjs`.
