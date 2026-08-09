# Dev-Tools Deep Reference

Rationale, gotchas, and non-obvious behavior for tools listed in
[`packages/dev-tools/CLAUDE.md`](../packages/dev-tools/CLAUDE.md). The
guide keeps entry commands; this page keeps the "why".

## ai-comment-detection

`packages/dev-tools/ai-comment-detection/` classifies PR/issue thread
contributions and applies `ai-generated` or `human-in-the-loop` labels.
The classifier is a cost-ordered cascade:

1. Account check
2. Markdown density
3. Similarity
4. Pangram API

The `human-in-the-loop` label is sticky — once applied it is never
removed. Pure logic lives in `lib.mjs` (vitest `dev-tools` project). See
its `README.md` for label semantics and workflow behavior.

## doc-dead-reference-gate

`check-doc-refs.mjs` (+ `check-doc-refs-lib.mjs`) skips globs,
angle-bracket templates, illustrative `my-*` paths, absolute VFS
runtime paths, and a small built-in allowlist for build artifacts,
external-repo refs, and spec/plan future files. TypeScript ESM
`.js`→`.ts` resolution is handled automatically. Chained after
`check-doc-sizes.mjs` in `lint:docs`.

## layer-back-edge-ratchet

`check-layer-back-edges.mjs` fails on any NEW import in
`packages/webapp/src/` that points up the stack
`fs → shell/git → cdp → tools → core → scoops → ui`
(e.g. `cdp/` → `scoops/`, or any layer → `ui/`).

Unranked directories (`kernel/`, `providers/`, `speech/`, …) rank just
below `ui/`: they may import ranked layers but not `ui/`, and are never
a back-edge target. Pre-existing back-edges are grandfathered per file
in `layer-back-edge-baseline.json` (one-way ratchet; regenerate after
paying debt down with `--update`). The baseline doubles as a debt list
for the boy-scout gate. Chained into `npm run lint`, `lint:ci`,
pre-commit (webapp-source commits), and the pre-push gate.

## record-string-unknown-ratchet

`check-record-string-unknown.mjs` fails on any NEW `Record<string, unknown>`
in non-test source. Detection is a Biome analyzer plugin
(`.biome-plugins/no-record-string-unknown.grit`), not a regex, so it matches
the real type node: line-wrapped occurrences count, `Record<string, string>`
does not, and `// biome-ignore lint/plugin: <reason>` suppresses a line the
same way it would any other Biome diagnostic.

The plugin cannot live in the root `biome.json`: at `severity = "error"` it
would fail `lint:ci` on all 604 pre-existing occurrences, and Biome's
`--skip=plugin` and `overrides[].plugins` are both group-level — there is no
per-plugin file exemption (`overrides[].plugins: []` is additive, not a
kill-switch). So `biome.record-gate.json` extends the root config, inheriting
`files.includes` verbatim (zero drift), and swaps in that one plugin; the
script runs it with `--only=plugin --reporter=json` and enforces the baseline.

Pre-existing occurrences are grandfathered per file in
`record-string-unknown-baseline.json` (one-way ratchet; regenerate after
paying debt down with `--update`). The baseline doubles as a debt list for
the boy-scout gate. Tests are out of scope — `(globalThis as Record<string,
unknown>).chrome = …` is idiomatic scaffolding, and `biome.json` already
exempts tests from `noExplicitAny` and the complexity rules for the same
reason. Chained into `npm run lint` and `lint:ci`.

## storybook-screenshots-upload

`storybook-screenshots-upload.mjs` (+ `storybook-screenshots-upload-lib.mjs`)
uploads the affected-story manifest to the `slicc-pr-screenshots` R2
bucket, content-hash deduplicated, with bounded concurrency
(`--concurrency`, default 4) via an injectable `r2` client so
`mapWithConcurrency`/dedup logic is testable without a real `wrangler`
process.

Sequential per-file `wrangler` subprocess spawns previously took ~4s per
file — timing out the CI job on large PRs (many affected stories). Each
shot retries up to 5 times with jittered exponential backoff, since R2
rate-limits upload bursts with `429` / code 971. Driven by the "Upload
screenshots to Cloudflare R2" step in
`.github/workflows/storybook-screenshots.yml`.

## knip-production-suffix-discipline

`npm run deadcode:production-files` runs `knip --production --include files`
to surface test-only dead files the default knip gate misses.

**Production-suffix discipline**: every workspace `entry`/`project`
glob in the production graph MUST be `!`-suffixed;
`knip --production` keeps only suffixed patterns. Test-only fixtures
are excluded via negated `project` patterns in `knip.json`, **not**
`ignoreFiles`. See the
[verifying-before-push skill](../.agents/skills/verifying-before-push/SKILL.md)
§ "Knip fixture exclusion" for why `ignoreFiles` is wrong and the
correct approach.

## swift-coverage-retry

`swift-coverage-check.sh` sources `swift-coverage-runner-retry.sh` in
`--xcodebuild` mode to retry once when the UI-test runner dies at
initialization. This is an infrastructure failure
`-retry-tests-on-failure` cannot see (the runner never gets far enough
to report per-test results); tested by
`swift-coverage-runner-retry.test.mjs`. Set `SLICC_IOS_SIM_UDID` to a
worktree-owned simulator UDID to override automatic selection locally;
when unset or empty, existing SDK-runtime selection remains unchanged.

## fresh-dev-harnesses

Five harness scripts bring up isolated dev environments on distinct
ports so they can run concurrently. Port-selection, reaping, and
LaunchServices lifecycle are covered in
[`docs/development.md`](development.md) § "Fresh Dev Harness Details".

Reaping semantics (also enforced in the harness scripts):

- The standalone harness fails if its selected bridge port is occupied
  by default.
- `SLICC_FRESH_REAP=1` opts into reaping a confirmed stale harness on
  that port.
- Forced reaping of the documented production bridge `:5710` is always
  refused.
- The harness never reaps Chrome CDP (`:9222` production, per-harness
  `:9224`/`:9225`/`:9226`/`:9333` dev).
- Other harness cleanup remains strictly port-scoped, never by process
  name.

Labeled Chrome bundle clones (`clone-labeled-chrome.sh`) provide
distinct ⌘-Tab entries.
