# BU Bench V2.1 Opus max recovery

Stage 2 run `36397375699` was pinned to `0a73b5a18`. This note records only
run metadata and synthetic live checks. It contains no upstream task text,
join URL, provider credential, or raw transcript.

## Live leader evidence

The local hosted leader used this checkout's node server and pinned webapp,
`bedrock-camp`, `claude-opus-5-5`, and `slicc thinking max`. The prompts were
independently written W3C WebDriver BiDi browsing tasks with delegated scoops.
Times below are Europe/Berlin on 2026-09-28. `SLICC_DEBUG=1` frame lines are
reduced to event type and anonymous unit; WebRTC addresses and IDs are omitted.

| Build  | Time              | Sanitized frame or observation                                                                                            |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pinned | 18:03:35          | cone `tool_use_start` twice, `tool_result` twice, then `content_done`                                                     |
| Pinned | 18:03:35–18:06:32 | no assistant event for 177 seconds; `scoops.list` continued every five seconds and `prompt --allsettled 2m` remained open |
| Pinned | 18:06:32          | two scoops `status ready`; cone immediately `status processing`                                                           |
| Pinned | 18:06:44          | SIGINT did not receive `abort_ack` within 12 seconds; CLI exited 1                                                        |
| Pinned | 18:06:34–18:08:01 | `cost --json --all` rose from $0.6311208 to $0.8063838 after abort                                                        |
| Fixed  | 18:27:30          | cone `status ready`; two delegated scoops continued working                                                               |
| Fixed  | 18:28:13          | SIGINT during the delegated work; CLI exited 130 after `abort_ack`                                                        |
| Fixed  | 18:28:37–18:29:41 | four cost readings all $0.8459000 and 552,759 tokens                                                                      |
| Fixed  | 18:32:05          | passive `wait` observed cone roster `working`                                                                             |
| Fixed  | 18:32:36          | `tool_use_start`; passive `wait` counted one pending cone tool                                                            |
| Fixed  | 18:35:06          | `tool_result`; pending cone tool count returned to zero after the 150-second shell call                                   |
| Fixed  | 18:35:30–18:37:30 | cone final answer, then `prompt --allsettled 2m` and passive `wait --allsettled 2m` both exited 0 after the quiet period  |
| Fixed  | 18:38:33          | a local file watcher lick, triggered after settlement, sent cone `status processing`                                      |
| Fixed  | 18:39:00          | the resumed cone emitted `message_start`, `content_delta`, `tool_use_start`, and `tool_result`                            |
| Fixed  | 18:39:39          | cone `status ready`; `session export`, started while it was processing, then completed successfully                       |
| Fixed  | 18:41:39          | passive `wait --allsettled 2m` exited 0 after the resumed turn's quiet period                                             |

The watcher was created and triggered only in this isolated leader, after the
first prompt had settled. It demonstrates the settle-then-resume race with an
explicit external event. The long shell call kept the cone's roster `working`
in this live run. Silent
thinking also did not make the first prompt exit early: the initial run stayed
open through the 177-second event gap. These observations do not reproduce an
early `allsettled` exit by themselves. They do confirm that a scoop completion
or watcher lick can restart the cone after a long gap, and that the old CLI did not account for
pending tools independently of `ready` statuses. `session export` waits for a
stable boundary across all scoops, so a continuation after the prompt's quiet
window can still leave export waiting. Export may also succeed after the new
turn finishes: the runner detects a final cone message absent from prompt
stdout in that case. The bench waits for the continuation and exports its
final transcript within the task's remaining timeout.

The abort failure is consistent with a child registered after the first stop
snapshot: the old confirmation waited for it but never signaled it. This is an
inference from the live no-ack/spend sequence and the leader's stop code; the
race is also exercised by a test that failed before the fix. The fixed leader
re-samples and stops late children before acknowledgment, drops a child whose
parent turn was aborted during creation, and cancels scheduled wait and
completion licks that could restart a stopped cone.

## Selective resume

`bench.yml` with `resume-run: 36397375699` downloads the matching source shard
artifact and calls `resumeAction()` for each planned run. A replay of the first
14 downloaded shard artifacts against the pinned `bu-v2` plan found 38 existing
error records selected as `run`, 480 scored records selected as `done`, zero
misclassifications, and 42 planned runs without a record also selected as
`run`. The remaining shards were still running at the time of inspection. Use
the same set, models, skills, repeats, and shard count on the fixed `main` ref;
dispatch only after the fix is merged.

The regression tests for pending tools, passive `wait`, late child abort, and
export-time recovery were each observed failing against the previous code
before their corresponding fixes. A run that never settles or lacks its final
transcript remains an unscored error.
