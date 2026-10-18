# CLAUDE.md

Benchmark runner — developer/architecture map. Usage, task format, report guide: [`README.md`](./README.md). Full mechanics: [`docs/bench-runner.md`](../../docs/bench-runner.md).

## Scope

Runs task sets on a SLICC leader across **models** and **skills**, judges each run against the task's rubric, writes result files and a report — measuring what skills and models change.

- **One task format** (shared with browser-use's BU Bench V2): `{ benchmark, tasks[] }`, per task `{ id, task, rubric, weights }` (weights sum 100), optional `slicc` object. [Schema](./README.md).
- **Public sets by reference.** `bu-v1`/`bu-v2` from browser-use/benchmark at the pin in `scripts/upstream.mjs` (`bu-v2` = BU Bench V2.1, 200 tasks), decrypted in memory; records carry `upstream` (tag, commit, sha256). **No licence; task text must never be published** — not committed; traces are Fernet-encrypted before leaving.
- **Judge**: upstream findings (met / violated / not_assessable + evidence); `score()` from weights. Bedrock Converse, forced tool use; `JUDGE_ATTEMPTS` repair turns then `--judge-fallback-model`. [Internals](../../docs/bench-runner.md#judge).
- Not an npm workspace (like `github-workflow/`): `scripts/` is dependency-free; tests under `bench`.

## Layout

- `scripts/run.mjs` — CLI: plan, run, judge, resume; writes records/traces/results/report
- `scripts/format.mjs` — validation, `outcome()` (pass/partial/fail), BU V1 + skill convert
- `scripts/upstream.mjs` — pinned upstream: Fernet decrypt/encrypt, set load, judge-spec
- `scripts/judge.mjs` — findings judge over Converse: request, validate, `score()`, retry
- `scripts/slicc-adapter.mjs` — prompt, skills staging, `runTask` (setup→…→teardown), trace
- `scripts/lifecycle.mjs` — restart CI leader via start/stop scripts; journal; redaction
- `scripts/executors.mjs` — Go `slicc` CLI vs join URL; dial retries; prompt interrupt
- `scripts/results.mjs` — records → result files, paired skill/model deltas, report
- `scripts/html.mjs` + `charts.mjs` — records → `report.html` (cards, deltas, matrix, cost Pareto); `--records` skips corrupt
- `scripts/backfill-tools.mjs` — tool-use metrics from traces; corrupt skipped
- `scripts/merge.mjs` — merge shards' out dirs: records (judged wins), traces, journals
- `scripts/publish.mjs` — stage run for HF `ai-ecoverse/slicc-bench`: enc traces/sets, report
- `scripts/leak-check.mjs` — fail if a plaintext out-dir file quotes task text; `--scrub memory/` rewrites checkpoints
- `dataset/README.md` — dataset card; `publish.mjs` fills `<!-- report -->`
- `arms/arms.json` — arms: a skill's driver runs each task instead of the cone
- `tasks/smoke.json` — two short live tasks; PR smoke uses the first
- `tasks/subsets/*.json` — frozen task-id lists for `--tasks @name` (explore-20 ⊂ -40)

## How a run works

Driven through the Go `slicc` CLI against the leader's join URL; nothing bench-specific runs on the leader. Each task mimics a person (new chat, pick model, type). Loop: skills → repeat → task → model.

1. **Stage skills.** `run.mjs` stages `/workspace/skills` (`slicc exec`); builtins stash in `/workspace/.bench-skills-builtin`. Conditions: `none`, `builtin`, or either `+` extras under `/workspace/bench-skills/<name>/`. **`none` = no bundled skills** (`flags set no-default-skills`). [Details](../../docs/bench-runner.md#none-skills-condition).
2. **Run the task.** `runTask` stages files, closes tabs, runs `slicc new-session --<action>` (`erase|save|skip`; `erase` default drops conversation **and** memories, `save` extracts memories then clears the chat), `slicc model <alias>`, `slicc thinking <level>` for `alias@level` (`config.thinking` requested vs `config.thinking_effective`; mismatch errors), then [`slicc prompt --allsettled 2m -`](../../docs/slicc-cli-details.md#prompt---allsettled) with task + upstream's `FINAL ANSWER:`.
3. **Memory (`save`)**: setup seeds a widened `/etc/MEMORY.md`; teardown waits for durable CLAUDE.md progress (`MEMORY_SETTLE_MS`, 180s) via `memorySettleProgressed` — a wipe to the seed must **not** count as settle (`tasks/memory-smoke.json`).
4. **Watch.** Poll `playwright-cli tab-list`, screenshot on tab change (or every 15 s). Spend = `cost --json --all` delta (authoritative over `session export`); judge trajectory from `session export` (chunked past 8 MiB). Timeout → SIGINT, exit 130 only after `abort_ack`; `slicc abort` must confirm cone+scoops stopped and spend flat before export, else unscored error. [More](../../docs/bench-runner.md#interrupt-and-spend).
5. **Arm mode** (`--arm <name>`): `runTask` execs the arm's driver on a goal file (`--private --goal-file`), keeping task text off the command line. Skills = extra set `arm` (`builtin+arm`, required); answer = scoop's last message; `config.arm` names it. [Arm + leak check](../../docs/bench-runner.md#arm-mode-and-the-leak-check).
6. **Resume.** `resumeAction()` from stored digests/judge: `done`; `rejudge` (judge/rubric/weights changed); `run` (agent failed, task text or `config.default_skills` changed). Errored runs exit 1 so CI can't green on missing runs. Scores: judged only; time/cost: every finish.

## Leader lifecycle and diagnostics

Leaders can stop accepting `slicc` connections (`tray connect timed out`) with Chrome up. Mechanics: [`docs/bench-runner.md`](../../docs/bench-runner.md#leader-lifecycle-and-diagnostics); invariants:

- **Leader-down is an error, never a fail.** Dials retry; never-dialed → `leaderDown`. `--fresh-leader-every N` (CI: `BENCH_LEADER_SCRIPTS`) restarts; unreachable → restart once + retry; `--leader-down-limit` consecutive stops the job. Boots retried twice (`bootTwice`).
- **Task isolation needs a fresh profile.** `new-session --erase` clears only the cone conversation; profile scoops (`<home>/profile`) carry over unless the recycler wipes them (`bench.yml` default `fresh-leader-every: 1`). Memory runs (`save`, `fresh-leader-every: 0`) keep it; leader-down recovery passes `keepProfile`. Each save/skip run stashes `/workspace/CLAUDE.md` → `<out>/memory/CLAUDE.md`, restored next boot (`BENCH_MEMORY_RESTORED=1`) so cross-job chains keep the store (`bench-memory-chain.yml`).
- **Scoops run the configured model only.** `model <m>` writes `/etc/models` denying every other catalogue id (aborts unless it reads back; restored at teardown; `metrics.model_pin`). Covers arms.
- **A prompt returning while the agent still works waits again.** `slicc prompt` exit 0 + empty answer → reprobe spend `BUSY_PROBE_MS` (20 s) apart; still rising → `slicc wait --allsettled 2m` + re-export (`resumed_after_settle`).
- **Lanes** (`--leaders N`): one home/port/`<home>/join.json` per leader, shared queue; share `/slicc/cone-config.json` (locked boots).
- **Cloud Run shard loss auto-resumes once.** `auto-resume.mjs` re-dispatches `resume-run=<run>` when every failed shard was host-maintenance-killed (new run carries `auto-resumed-from`). Mixed kill+real-failure → hand resume named in the summary.
- **Harness drifts; records say so.** Hosted leaders load the webapp from production; `leader.slicc_version`/`slicc_versions` flag a mix; `pin-webapp=true` serves the pinned npm package, a commit/tag/branch builds a detached checkout and runs its `dist/node-server` + `dist/ui`.
- **Guardrails** (`guardrails()`): no new run past deadline or `--max-cost`; `watchSpend` aborts past `--max-task-cost`. Deadline-with-runs-left and `state.errors > 0` emit _distinct_ `::error::` lines. Cost null on failed/backward counters (`cost_unknown`); journals redact join tokens and hold no task text.

## Publishing

`report.{md,json,html}` written every run (`reportData()`). `bench.yml` shards upload out dirs, the `Report` job merges them (`merge.mjs`), a dispatch run publishes to [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench) (`publish.mjs`). Pipeline, pin-rollover: [bench-runner.md](../../docs/bench-runner.md#publishing-pipeline).

**Safety-critical:** encryption is browser-use's (Fernet keyed by `sha256(<benchmark>)`). **Upstream sets publish scores only** (no traces). Published records never carry `metrics.tabs` (names the site/query).

## Build and Test

```bash
npx vitest run --project bench
npm run test:coverage:bench
actionlint .github/workflows/bench.yml .github/workflows/bench-reaper.yml
```

Live check vs a local harness (`run.mjs` with `SLICC_CLI`/`SLICC_JOIN_URL`/`AWS_BEARER_TOKEN_BEDROCK`): [`README.md`](./README.md#run-it-locally).

## Design Rules

- **Never commit or print upstream task text.** `loadUpstreamSet` → in memory → `encryptJson` traces. `records/`/`results/` hold ids, scores and metrics only.
- **The judge never scores.** Weights stay out of its prompt; `score()` is upstream's arithmetic (met weight / total, worst-wins duplicates; canary leak or reward hacking → 0).
- **Executors never throw on non-zero status** (callers decide; dials retry, executions don't). Drive the leader only through its public CLI surface. Decisions live in exported pure functions with injected `leader`/`fetchImpl`/`judge`/`now`.

## Related

- [`README.md`](./README.md) — usage, inputs, task format, report guide, adding skill evals
- [`docs/bench-runner.md`](../../docs/bench-runner.md) — judge, none-skills, interrupt/spend, transcript, lifecycle, publishing
- `packages/github-workflow/CLAUDE.md` — the leader and CLI this runs on
- `.github/workflows/bench.yml` (plan → shards → report + PR smoke) · `bench-reaper.yml` (cancels stuck)
