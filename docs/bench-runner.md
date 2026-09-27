# Benchmark runner — internals

Extended reference for `packages/bench/CLAUDE.md`. Deep notes only; see the
package `CLAUDE.md` for scope, layout, the run model, and the top-level map.

## Judge

Upstream's findings method. The judge reports met / violated / not_assessable
per rubric item with evidence; code scores from the weights. The system prompt
and truncation caps are read from upstream's `findings_judge.py` at the pinned
commit (V2.1 has no task or rubric cap). Since V2.1 every `not_assessable`
finding carries `not_assessable_reason` (`missing_evidence` or `absent_scope`),
and `met`/`violated` carry null; the trace never passes the agent's reasoning to
the judge, as V2.1 requires. It runs over Bedrock Converse with forced tool use,
default `global.openai.gpt-5.6-luna` (a non-Claude judge, as #3180 prefers). A
judgement that fails validation is answered with a repair turn (its own tool
call answered with a result naming each problem; no `status` field, which
Bedrock supports for Claude and Nova only), up to `JUDGE_ATTEMPTS` (3) in all;
the record's `judge.repairs` counts them. A judgement still invalid after those
attempts goes to a fallback judge (`--judge-fallback-model`, default
`global.openai.gpt-5.6-sol`; `bench.yml` input `judge-fallback-model`, `none`
turns it off): the record's `judge.model` names the judge that scored, with
`fallback_from` and `fallback_reason`, and a resume keeps it. Only invalid
judgements fall back; a failed request is the same for either judge. In the
V2.1 pilot of 2026-09-27, the primary judge stayed invalid on 9 of 72 runs.
Plain re-asking was not enough: in the V2.1 pilot the judge omitted
`not_assessable_reason` twice in a row on 5 of 28 runs.

## Transcript collection

While the cone works, the runner polls `playwright-cli tab-list` and screenshots
a tab whose address changed, or every 15 s, because agents close their tabs when
done. Cost, tokens and turns are the delta of `cost --json --all` across the
prompt: the cone plus every scoop it spawned, dropped ones included. The judge's
trajectory comes from `session export`; its per-message model ids fill
`modelsUsed`, which shows when scoops ran on another model.

- **Never `cat` a large file over one `exec`.** The leader sends an exec's whole
  stdout as one tray message, and a message over 8 MiB (about 6.3 MB of output
  once base64-encoded) is dropped without an error. The CLI then exits 0 with
  empty stdout. So `exportTranscript` exports, unzips and `split`s
  transcript.json on the leader in one call (10 min timeout, retried once unless
  it timed out). It then reads the parts back with `base64`, 3 MiB at a time.
  Each part is checked against the `sha256sum` listing and read again, up to 3
  times, when it arrives short, corrupted or not at all. The whole file is
  checked too. All of it shares `TRANSCRIPT_BUDGET_MS` (15 min): each call gets
  at most what is left, and a run out of time is recorded without a transcript
  (`stage: 'budget'`). Before this, one run spent 113 minutes collecting.
- The outcome (`ok`, `bytes`, `parts`, `exports`, `reads`, `ms`, and on failure
  `stage` and `reason`) goes into the task event as `transcript` and into the
  record as `metrics.transcript`; only the event keeps the leader's stderr tail
  (`detail`). A run without a transcript says why in its log line and its judge
  trace.

## Leader lifecycle and diagnostics

The first BU V1 dispatch lost 4 of 5 leaders about 70 minutes into their jobs.
Each lost leader stopped accepting `slicc` connections (`tray connect timed
out`), while its Chrome kept running. The cause is not known yet, so the runner
defends against it and records what the next occurrence needs:

- Every call has a timeout (`DEFAULT_CALL_TIMEOUT_MS`), dial retries run with
  `SLICC_DEBUG=1`, and a result that never dialed carries `leaderDown`.
  `runTask` throws such runs; they are errors, never fails.
- `--fresh-leader-every N` (CI: `BENCH_LEADER_SCRIPTS`) restarts the leader every
  N tasks with the github-workflow scripts; an unreachable leader is restarted
  once and the run retried (also when it fails while skills are staged, and when
  a call's connection closes mid-call: `io: read/write on closed pipe` or
  `connection closed`, seen on 6.190.0 and on 6.191.0 with #3479). A run whose
  transcript was lost to an unreachable leader is retried the same way, never
  judged from its final answer alone; `--leader-down-limit` consecutive
  leader-down runs stop the job for a resume. Skills are staged again on every
  new leader.
- **Task isolation needs a fresh profile.** The webapp keeps its VFS, sessions
  and scoops in Chrome's profile, which start-leader reuses (`<home>/profile`),
  and `new-session --erase` resets only the cone's conversation. In the first
  full BU V1 run, GPT-5.6 Sol's scoops carried over from task to task and across
  restarts: they kept working, billed later tasks (7.7M tokens in a 92 s run),
  filled the judge's transcript with other tasks' work, and wedged the leader
  (`terminal-open timed out`). The recycler therefore wipes the old profile
  between stop and start, and `bench.yml` restarts before every task by default
  (`fresh-leader-every: 1`, about 15–40 s each). A terminal-open timeout counts
  as the leader being down.
- Journal in the out dir: `calls.jsonl`, `events.jsonl` (per task: phases,
  leader generation and age, `uptime`/`meminfo`/`ps` before and after),
  `diagnostics/`; with `BENCH_LEADER_LOG`, events are also marked in the
  leader's log, and `bench.yml` keeps its infrastructure lines as
  `leader-infra.log`. All redacted of join tokens; none holds task text.
- **Lanes** (`--leaders N`, `bootLane` in lifecycle.mjs): one home and port per
  leader, one shared queue. Every leader writes the same
  `/slicc/cone-config.json` (stop-leader deletes it) and node-server posts its
  join URL to the fixed `/tmp/slicc-join.json`, so boots, restarts and stops
  share one lock (`createLock`), and `claims` rejects a join URL another lane
  holds. A lane stops after `--leader-down-limit`; the others go on.
- **The harness drifts; the records say so.** A hosted leader loads its webapp
  (the agent) from production, so it runs the release that is live when it boots;
  the `sliccy` version `bench.yml` pins covers node-server only, and
  `config.harness` names that pin. Every record carries `leader.slicc_version`
  (what its leader reported at boot); result files, `report.json` and both
  reports count runs per version (`slicc_versions`) and flag a mix. Drift is
  accepted by default (resume keeps runs of any version); `backfill-tools.mjs`
  stamps older records from `events.jsonl`. Found on 2026-09-26: one V2.1 pilot
  shard ran 6.194.1 then 6.194.2 while its records all said 6.194.1.
- **A prompt that returns while the agent still works is not judged.** In the
  V2.1 pilot, `slicc prompt` exited 0 after about 5 s with no answer in 32 of 80
  runs while the cone kept working (root cause under investigation). When
  `prompt` exits 0 with an empty answer, `runTask` reads spend twice,
  `BUSY_PROBE_MS` (20 s) apart, before touching tabs or collecting; still rising
  means the run is recorded as an error (`err.stillWorking`), never scored from
  an empty or half-done run.
- **Boots are tried twice** (`bootTwice` in run.mjs), for a lane's first leader
  and every restart: on 2026-09-26 one restart of many never reported a join URL
  and its lane stopped. A failed boot's full start-leader output goes to
  `diagnostics/boot-L<lane>-<ms>.log` (redacted), and a `leader-boot-failed`
  event points to it. Lanes whose leaders the runner booted are not restored at
  the end (they are stopped), so a lane that lost its leader doesn't wait on it.
- **The webapp is production unless `pin-webapp` is set.** `plan` pins the
  `sliccy` npm version for node-server. Chrome still loads
  `https://www.sliccy.ai`, which serves the latest release, so a publish mid-run
  changes the agent. `pin-webapp: true` serves that package's `dist/ui`. A
  commit, tag, or branch is fetched into a detached worktree and built the way
  the local node harness runs one checkout (`node dist/node-server` against that
  tree's `dist/ui`, tray on production). Worker routes the page loads from the
  loopback origin, including `/api/flags` and the model catalogue, are proxied to
  production so the pin differs in the webapp build only. Each boot, including a
  restart, reports that version as `leader.slicc_version`. The build happens once
  per shard; restarts reuse it.
- **Guardrails** (`guardrails()` in run.mjs): no new run once `now +
effectiveTimeout + RUN_OVERHEAD_MS` passes the deadline (effective timeout is
  the next task's `slicc.timeoutSeconds`, else `--timeout`), none once the
  invocation has spent `--max-cost`; `watchSpend` polls `cost --json --all` every
  30 s and aborts a prompt past `--max-task-cost` (the record carries
  `metrics.cost_capped`). The wave-1 jobs of 2026-09-25 ran into the 355-minute
  job limit mid-run and lost their publish step; bench.yml now gives the run step
  a limit below the job's, and bench-reaper.yml cancels stale runs.
- Cost is null when a `cost` reading fails or the counters went backwards; means,
  totals and pairs skip unknown values, and result files count them
  (`cost_unknown`).

## Publishing pipeline

`report.md`, `report.json` and `report.html` are written with every run;
`reportData()` is the source of all three. In `bench.yml`, each shard (a matrix
job on a GCP self-hosted runner, `--shard K/N`) uploads its out dir as
`bench-<run>-shard-<k>`; the `Report` job merges them with `merge.mjs`, uploads
the report with `results/` as `bench-report-<run>` and everything as
`bench-<run>`. A dispatch run then publishes to
[ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench)
with the repo's `HF_TOKEN` secret. It downloads the dataset's `records/`, stages
this run over them with `publish.mjs`, and sends one `hf upload` commit.

- The encryption is browser-use's: a `.enc` file is the base64 of a Fernet token
  whose key is `sha256(<benchmark>)`.
- Our own task sets go to `tasks/<benchmark>.enc`, and their traces to
  `runs/<run>/traces/…`, encrypted.
- Upstream sets publish scores only: no traces, and their rubric item ids reduced
  to status counts.
- Published records never carry `metrics.tabs`, because open tabs can name the
  site or the search.
- Advancing the upstream pin (`UPSTREAM` in `upstream.mjs`) drops the previous
  pin's records for that benchmark from the staged `records/` tree so a partial
  shard does not mix revised tasks with old scores in the combined report.
  `bench.yml` uploads with `--delete 'records/**'` so the Hub matches.
