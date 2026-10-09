# CLAUDE.md

Benchmark runner. Developer/architecture map; usage, task format, report guide: [`README.md`](./README.md).

## Scope

Runs task sets on a SLICC leader across **models** and **skills**, judges each run against the task's rubric, writes result files and a report. Answers what skills and models change.

- **One task format**, shared with browser-use's BU Bench V2: `{ benchmark, tasks[] }`, per task `{ id, task, rubric, weights }` (weights sum 100). Optional `slicc` object (`website`, `skills`, `files`, `timeoutSeconds`, `requires`). Schema: [`README.md`](./README.md).
- **Public sets by reference.** `bu-v1`/`bu-v2` from browser-use/benchmark at the pin in `scripts/upstream.mjs` (`bu-v2` = BU Bench V2.1, 200 tasks), decrypted in memory. Records carry `upstream` (tag, commit, file sha256). **No licence; task text must never be published** — not committed; traces holding it are Fernet-encrypted before leaving the runner.
- **Judge**: upstream findings (met / violated / not_assessable + evidence); `score()` from weights. Bedrock Converse, forced tool use, default `global.openai.gpt-5.6-luna`; up to `JUDGE_ATTEMPTS` (3) repair turns, then fallback (`--judge-fallback-model`, default `global.openai.gpt-5.6-sol`; `none` off). [Internals](../../docs/bench-runner.md#judge).
- Not an npm workspace (like `github-workflow/`): `scripts/` is dependency-free (Node built-ins + `gh-io.mjs`). Tests: `bench` project.

## Layout

| Path                         | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `scripts/format.mjs`         | Validation, `outcome()` (pass/partial/fail), BU V1 + skill convert  |
| `scripts/upstream.mjs`       | Pinned upstream: Fernet decrypt/encrypt, set load, judge-spec       |
| `scripts/judge.mjs`          | Findings judge over Converse: request, validate, `score()`, retry   |
| `scripts/slicc-adapter.mjs`  | Prompt, skills staging, `runTask` (setup→…→teardown), trace         |
| `scripts/lifecycle.mjs`      | Restart CI leader via start/stop scripts; journal; redaction        |
| `scripts/executors.mjs`      | Go `slicc` CLI vs join URL, dial retries, prompt interrupt          |
| `scripts/results.mjs`        | Records → result files, paired skill/model deltas, md report        |
| `scripts/charts.mjs`         | report.html: ranking, score vs. cost (quadrant, Pareto), tool use   |
| `scripts/backfill-tools.mjs` | Add tool-use metrics to records from traces                         |
| `scripts/html.mjs`           | Records → `report.html`: cards, table, deltas, matrix, time×cost    |
| `scripts/merge.mjs`          | Merge shards' out dirs: records (judged wins), traces, journals     |
| `scripts/publish.mjs`        | Stage run for HF `ai-ecoverse/slicc-bench`: enc traces/sets, report |
| `dataset/README.md`          | Dataset card template; `publish.mjs` fills `<!-- report -->`        |
| `scripts/run.mjs`            | CLI: plan, run, judge, resume; writes records/traces/results/report |
| `scripts/leak-check.mjs`     | Fail when a plaintext out-dir file quotes task text (pre-upload)    |
| `arms/arms.json`             | Arms: a skill's driver runs each task instead of the cone prompt    |
| `tasks/smoke.json`           | Two short live tasks; PR smoke run uses the first                   |
| `tasks/subsets/*.json`       | Frozen task-id lists for `--tasks @name` (explore-20 ⊂ -40; ids)    |

## How a run works

Driven from outside through the Go `slicc` CLI against the leader's join URL; nothing bench-specific runs on the leader. Each task mimics a person: new chat, pick a model, type.

1. `run.mjs` stages `/workspace/skills` for the condition with `slicc exec`; builtin skills stash in `/workspace/.bench-skills-builtin`. Conditions: `none`, `builtin`, or either `+` extras under `/workspace/bench-skills/<name>/`. **`none` = no bundled skills** via `flags set no-default-skills` — [details](../../docs/bench-runner.md#none-skills-condition).
2. Per task, `runTask` stages files, closes tabs, runs `slicc new-session --<action>` (`--new-session erase|save|skip`; default `erase` drops conversation **and** memories; `save` extracts memories then clears the chat), `slicc model <alias>`, and for `alias@level` `slicc thinking <level>` (`config.thinking` = request, `config.thinking_effective` = what ran; mismatch errors), then `slicc prompt --allsettled 2m -` ([details](../../docs/slicc-cli-details.md#prompt---allsettled)) with the task plus upstream's `FINAL ANSWER:` instruction. Skills check after `new-session`. For `save`, setup seeds a widened `/etc/MEMORY.md` (curator `visiblePaths` + `/tmp/` + `/etc/`, restored at teardown — that frontmatter is what becomes the curator sudoers grant). Teardown waits for durable CLAUDE.md progress (`MEMORY_SETTLE_MS`, default 180s) via `memorySettleProgressed` — Auto-extracted growth, cleared seed placeholders `(Add preferences here)`, or non-seed bytes/sha without reintroducing placeholders. A wipe back to the seed must not count as settle. Sessions ledger: freeze skipped with an empty store fails; freeze skipped with retained prior memory succeeds; archive settled with unchanged empty CLAUDE.md → extract empty; still pending at timeout → curator/enrichment still running. The CLI alone returns when the chat is empty, before enrichment. Prove with `tasks/memory-smoke.json`. Timeout → SIGINT; exits 130 only after `abort_ack` (exit 1 if unconfirmed in 12s; SIGKILL at 20s). [Interrupt](../../docs/bench-runner.md#interrupt-and-spend).
3. While the cone works: poll `playwright-cli tab-list`, screenshot on tab change (or every 15 s). Spend = `cost --json --all` delta (authoritative vs `session export`). Judge trajectory from `session export` (chunked past 8 MiB — [transcript](../../docs/bench-runner.md#transcript-collection)). After interrupt, read spend until flat or 3 min; giving up → `leader_down` + lane restart. Loop order: skills → repeat → task → model.
4. **Arm mode** (`--arm <name>`, `arms/arms.json`): instead of the cone prompt, `runTask` writes the task to `/tmp/bench/<run>/goal.txt` and execs the arm's driver (`intent-arm … --private --goal-file`), so the task stays off the command line and the driver prints numbers only. The arm's skills are the extra set `arm` (skills `builtin+arm`); its `setup` runs once per staged leader. The answer is the scoop's last message; the driver's files (`files`, which hold task text) are read into the trace only, which is encrypted for upstream sets. Records name the arm in the condition (`builtin+arm.intent-budget`, so paths, keys and resume never pool two arms) and in `config.arm`. [Details](../../docs/bench-runner.md#arm-mode-and-the-leak-check).
5. `resumeAction()` from stored digests/judge — `done`; `rejudge` (changed judge/rubric/weights); `run` (agent failed, task text changed, or `config.default_skills` mismatch). Errored runs are reported but exit 1 so CI can't green on missing runs. Scores: judged only; time/cost: every finish.

## Leader lifecycle and diagnostics

Leaders can stop accepting `slicc` connections (`tray connect timed out`) with Chrome up. Mechanics: [`docs/bench-runner.md`](../../docs/bench-runner.md#leader-lifecycle-and-diagnostics). Rules:

- **Leader-down is an error, never a fail.** Dial retries use `SLICC_DEBUG=1`; never-dialed → `leaderDown`. `--fresh-leader-every N` (CI: `BENCH_LEADER_SCRIPTS`) restarts; unreachable → restart once + retry; `--leader-down-limit` consecutive stops the job for resume.
- **Task isolation needs a fresh profile.** `new-session --erase` resets only the cone conversation; scoops in Chrome's profile (`<home>/profile`) carry over unless wiped. Recycler wipes between stop/start; `bench.yml` defaults `fresh-leader-every: 1`. Memory accumulation (`--new-session save`, `fresh-leader-every: 0`) keeps that profile on purpose — cookies/logins confound memory; pair against an erase arm with the same single-leader layout. Leader-down recovery on save/skip passes `keepProfile` so the memory chain is not wiped; `--fresh-leader-every` still wipes. Resume of save/skip replays done tasks unless `BENCH_MEMORY_RESTORED=1` (profile checkpoint restored).
- **A prompt returning while the agent still works waits again.** On `slicc prompt` exit 0 with empty answer, `runTask` reads spend twice `BUSY_PROBE_MS` (20 s) apart; rising spend or export timeout triggers passive `slicc wait --allsettled 2m` + re-export. A final cone message absent from prompt stdout proves a continuation at flat spend: scored, marked `metrics.resumed_after_settle`. At timeout or cost cap, `slicc abort` must confirm cone+scoops stopped and spend flat before the final transcript exports; failed abort, post-abort spend, or missing transcript is an unscored error.
- **Lanes** (`--leaders N`): one home/port/`<home>/join.json` per leader, shared queue; still share `/slicc/cone-config.json` (locked boots). Published node-server shares `/tmp/slicc-join.json`.
- **Harness drift** is recorded, not prevented: hosted leaders load the webapp from production; `leader.slicc_version`/`slicc_versions` flag a mix; `pin-webapp` overrides.
- **Guardrails** (`guardrails()`): no new run past deadline or `--max-cost`; `watchSpend` aborts past `--max-task-cost`. Cost null on failed/backward counters (`cost_unknown`). Journal redacts join tokens; no task text.

## Publishing

`report.{md,json,html}` written every run (from `reportData()`). `bench.yml` shards upload out dirs, the `Report` job merges them (`merge.mjs`), and a dispatch run publishes to [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench) via `publish.mjs`. Artifacts, pin-rollover: [`README.md`](./README.md), [`docs/bench-runner.md`](../../docs/bench-runner.md#publishing-pipeline).

**Safety-critical:** encryption is browser-use's — a `.enc` file is base64 of a Fernet token keyed by `sha256(<benchmark>)`; our sets → `tasks/<benchmark>.enc`, traces → `runs/<run>/traces/…`. **Upstream sets publish scores only** (no traces; rubric ids reduced to status counts). Published records never carry `metrics.tabs` (tabs can name the site or query).

## Build and Test

```bash
npx vitest run --project bench
npm run test:coverage:bench
actionlint .github/workflows/bench.yml .github/workflows/bench-reaper.yml
```

Live check against a local dev harness (build the CLI; run `run.mjs` with `SLICC_CLI`, `SLICC_JOIN_URL`, `AWS_BEARER_TOKEN_BEDROCK`): [`README.md`](./README.md#run-it-locally).

## Design Rules

- **Never commit or print upstream task text.** Load with `loadUpstreamSet`, keep in memory, encrypt traces with `encryptJson`. `records/`/`results/` hold ids, scores and metrics only.
- **The judge never scores.** Weights stay out of its prompt; `score()` is upstream's arithmetic (met weight / total, worst-wins duplicates; canary leak or suspected reward hacking zeroes it).
- **Executors never throw on non-zero status** (callers decide; dials retry, executions don't). **Drive the leader only through its public surface** — CLI verbs and shell a person could type. **Pure vs I/O split**: decisions live in exported functions with injected `leader`, `fetchImpl`, `judge`, `loadUpstream`, `now`.

## Related

- [`README.md`](./README.md) — usage, inputs, task format, report guide, adding skill evals
- [`docs/bench-runner.md`](../../docs/bench-runner.md) — judge, none-skills, interrupt/spend, transcript, lifecycle, publishing
- `packages/github-workflow/CLAUDE.md` — the leader and CLI this runs on
- `.github/workflows/bench.yml` (plan → shard matrix → report, + PR smoke) · `bench-reaper.yml` (cancels stuck runs)
