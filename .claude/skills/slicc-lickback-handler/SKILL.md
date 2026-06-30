---
name: slicc-lickback-handler
description: |
  Use this skill to answer the human typing in a running SLICC cup's CHAT PANEL — when
  the operator says "answer / handle my SLICC chat", or "be the brain for my SLICC" with
  nothing to do beyond answering chat. A cup runs no internal cone, so its chat panel has
  no responder; this skill discovers the cup, claims its chat channel, and answers the
  human's messages in a background subagent (run on Sonnet). All discovery, session, claim,
  drain, lease/409, and reply plumbing is handled by bundled scripts — no ports, UUIDs,
  curl, or HTTP status codes are surfaced to the operator. This skill is ONLY the
  chat-answer loop; STEERING the cup (leading a tray, joining, driving the browser, running
  commands, getting a join URL) is the `slicc-cup` skill — load that for anything beyond
  answering chat.
---

# slicc-lickback-handler

A **cup** SLICC instance runs no internal cone, so the browser's chat panel and
the cone's lick inbox have no responder. **You are that responder** — the
external Claude brain that answers the human typing in the cup's chat panel.

**Only available for the standalone CLI cup float** (spec §11) — the extension has
no node-server. If no cup is running, the setup step below **brings one up**
(`cup-up.mjs`) rather than stopping — it only gives up if a cup never comes up.

The scripts referenced below live in the `scripts/` directory next to this
SKILL.md (this skill's base directory, shown to you when the skill loads). Set
`SCRIPTS` to that absolute path once.

## Routing — read this FIRST

<HANDLER-ROUTING>
- **If you are the top-level / interactive session** (the operator is talking to you
  directly):
  1. **"Be the brain" means be sliccy in full — steer AND lead by default.** Unless the
     operator said *only* "answer my chat", the steering is the **`slicc-cup`** skill: load
     it and do it yourself, in THIS session, FIRST — bring up the cup and `host lead`
     (leading is the default, not opt-in — see slicc-cup), plus any drive / navigate /
     command they asked for, and hand the human the join URL. Do **not** punt steering to
     the chat handler, and do **not** grep the project — `slicc-cup` has the commands. (To
     lead: exec `host lead` on the cup, then poll `host` for the `join_url:` line — slicc-cup
     "Tray membership".)
  2. For the chat-answer loop, **dispatch the `slicc-lickback-handler` AGENT TYPE in the
     background** (`subagent_type: "slicc-lickback-handler"`, `run_in_background: true`) with
     the instruction *"be the lick-back handler for the running SLICC cup"*. That agent pins
     **Sonnet** via its frontmatter — the Agent tool's inline `model` arg is silently dropped
     (anthropics/claude-code#31027), so do **not** pass `model:`; dispatch by type. Tell the
     operator **"Answering your SLICC chat in the background."** and continue (don't block —
     you stay free to steer). **Dispatch it EARLY** — it claims + waits on the chat channel
     independently, so kicking it off before (or while) you lead + bootstrap overlaps its
     setup with your steering. It **self-terminates** when the cup stops (its `lickback-wait`
     exits non-zero); you can't and needn't stop it with `TaskStop` (a background Agent is
     not a Task).
- **If you ARE that dispatched handler subagent**: skip this block and run **The loop**
  below.
</HANDLER-ROUTING>

(This mirrors superpowers' own `<SUBAGENT-STOP>`, inverted: a direct invocation
self-corrects into the background path. It is instruction-scoping, not a runtime
lock — so honor it.)

## Setup (handler subagent, once)

```bash
SCRIPTS="<this skill's base dir>/scripts"
# Bring up a DRIVABLE cup (one call). Auto-detects dev vs prod from the repo's git
# branch: a feature branch (not `main`) → loads the LOCAL build via wrangler + cup-dev
# (the unmerged code isn't on production yet); `main` → prod `npm run cup`. Reuses a live
# cup and waits for the BRIDGE (`/api/targets`), not just `/api/status`.
CUP_BASE="$(SLICC_REPO_DIR="${SLICC_REPO_DIR:-$PWD}" node "$SCRIPTS/cup-up.mjs")" || {
  echo "Could not bring up a drivable SLICC cup."; exit 0; }
SLICC_SESSION="$(node -e 'console.log(crypto.randomUUID())')"
```

`cup-up.mjs` reuses a live cup or brings one up the right way for where you are (local
dev build on a feature branch, prod on `main`), **waiting until it's actually drivable**
(`GET /api/targets`, not the premature `/api/status`), then prints its base URL. Dev mode
needs `dist/ui` built (`npm run build -w @slicc/webapp`) and will reuse-or-start a wrangler
on :8787. Override with `SLICC_CUP_MODE=dev|prod` if the branch heuristic is wrong. Use
`cup-discover.mjs` instead to attach ONLY to an already-running cup (no launch).

**Hold `CUP_BASE` and `SLICC_SESSION` in your context and prefix EVERY script
call with them** — Claude Code shells do not persist env between calls:

```bash
CUP_BASE="$CUP_BASE" SLICC_SESSION="$SLICC_SESSION" node "$SCRIPTS/<script>.mjs" …
```

## Bootstrap SLICC's brain (before you answer anything)

You are not SLICC's cone — you do **not** inherit its system prompt or skills. Load
them once per session, before answering the first chat message, so you behave like
SLICC instead of an outsider poking at an API. This is non-optional:

- **One call:** `CUP_BASE="$CUP_BASE" node "$SCRIPTS/cup-bootstrap.mjs"` fetches
  `/shared/CLAUDE.md` + the `playwright-cli` and `mount` skills + the skills catalog
  as ONE sectioned tool result (instead of 3-4 separate fetches). Read and adopt the
  output before answering the first chat message.
- It bundles these, which you can also fetch individually as a fallback:
  - `GET /api/vfs/read?path=/shared/CLAUDE.md` — SLICC's agent system prompt (ice-cream
    vocabulary, shell-first philosophy, runtime conventions). Read it and adopt it.
  - `/workspace/skills/playwright-cli/SKILL.md` and `/workspace/skills/mount/SKILL.md`
    IN FULL — driving the browser is SLICC's whole point and the one surface that
    _wedges_ the instance when misused — plus `POST /api/vfs/list {"path":"/workspace/skills"}`;
    read any others the task implicates.

See the **slicc-cup** skill ("Bootstrap SLICC's brain") for the exact commands. Do
**not** reach for SLICC's `delegation` / `scoop_scoop` / `workflow` skills to
parallelize — those are cone-only and unreachable over the loopback bridge; that's
your job as the brain, so fan out with your own subagents.

## The loop

1. **Claim** the chat channel:

   ```bash
   CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-claim.mjs"
   ```

   - exit `0` → you own it. Continue. (The claim is atomic + cup-owned and **retries
     across the lease tail (~60s)**, so a predecessor that was hard-killed — its
     foreground `lickback-wait` died with it, freeing the channel after the ~45s lease
     — no longer dead-locks a fresh handler. It also clears any stale drain a _legacy_
     poll-loop handler may have left, a no-op in the wait-loop design.)
   - exit `3` → a **live OTHER brain** still owns the channel after the retry budget
     (~60s) lapsed. **Report "already handled, standing down." and STOP.** The retry
     already rode out the lease tail, so re-running won't win.

2. **Wait for + answer messages** — ONE blocking call per message, repeat:

   ```bash
   frame="$(CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-wait.mjs")"; code=$?
   ```

   `lickback-wait` holds the cup's SSE and **BLOCKS until the next message arrives** —
   you burn **no tokens** while it waits (no polling) — then prints one frame and exits.
   It pins the lease while it blocks. Branch on `code` / `frame`:

   - **`code` non-zero → STOP.** `1` = the cup is gone (stopped or crashed); `3` =
     another brain took the channel. Either way stand down — there is **nothing to clean
     up** (no background process; the SSE closed with the call and the lease frees on its
     own).
   - **`code` 0 + EMPTY `frame` → idle timeout** (no message in the ~10-min window). Just
     re-run — this is the normal idle beat, ~one cheap turn per window, not a busy poll.
   - **`code` 0 + a `frame` → answer it**, then re-run. Two shapes: a chat message
     `{kind:"chat", text, msgId}`, or an orphaned lick `{kind, lick}` (the full lick
     object; no `text`/`msgId`):
     - `kind:"chat"` → answer `text` as sliccy — an end-user assistant: plain language,
       no ports / sessions / curl / exit codes / "chat channel" plumbing. For real work
       in the cup's browser / VFS, drive it through the **slicc-cup** API/scripts
       (`/api/shell/exec`, `/api/vfs/*`, `/api/targets`). Send the answer via a **quoted
       heredoc** so apostrophes, quotes, backticks, `$`, and newlines pass through
       verbatim. **Never hand-escape the answer into a shell string** — escaping `'` as
       `'\''` inside a double-quoted `printf` leaks literally into the reply (renders as
       mangled `'\''`/`'''` in the panel):

       ```bash
       CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-reply.mjs" "$msgId" <<'SLICC_REPLY_EOF'
       …your answer here, exactly as written, no escaping…
       SLICC_REPLY_EOF
       ```

       (For a long or heredoc-unsafe answer, write it to a file with the Write tool and
       redirect: `… node "$SCRIPTS/lickback-reply.mjs" "$msgId" < reply.txt`.)

     - `kind:"upgrade" | "sprinkle" | <other>` (the `{kind, lick}` shape) → an orphaned
       cone lick; **surface `event.lick`** to the operator (informational); no reply
       (no `msgId`).

3. **Stop** when `lickback-wait` exits non-zero (cup gone / channel lost) or the operator
   says stop. There is nothing to tear down: `lickback-wait` is a **foreground** call, so
   when the cup stops your in-flight wait drops and exits non-zero, and even a hard kill of
   this handler drops its SSE — the lease frees within ~45s with no orphaned process.

## Rules

- **The reply script always terminates with `done:true`.** The human's composer shows a
  working spinner from send until your reply's `done:true` lands (or they hit stop).
  `lickback-reply.mjs` guarantees the terminator even for an empty / decline answer, so
  the panel never hangs — always use it rather than hand-rolled posts.
- **One blocking wait at a time.** `lickback-wait` is foreground — issue the next one only
  after you've answered (or after an idle timeout). You won't see your own replies (the
  channel is browser→brain only); your reply renders in the panel.
- **On a lost channel (exit 3), stand down.** A 409 means a live OTHER brain owns the
  channel; don't fight an atomic, cup-owned claim.
- **Shutdown is automatic — never spin.** There is no background drain to kill and no
  buffer to poll: when the cup stops (the human runs `cup-stop`, or it crashes) your
  `lickback-wait` exits non-zero and you stop. **The cup itself stays up** unless
  explicitly stopped — if your `cup-up.mjs` reported it **launched** the cup, tell the
  operator it can be stopped with `cup-stop.mjs` (see slicc-cup "Stopping a cup"); don't
  stop a cup you only attached to.

## Notes

- The scripts are unit + integration tested under
  `packages/dev-tools/lickback-scripts/` (a fake cup over node:http).
- `lickback-wait` pins the lease while it blocks; the gap between calls (you answering)
  is normally far under the ~45s lease. Only if a single reply runs long AND another brain
  might claim do you need `lickback-heartbeat.mjs` once before the next wait — with a
  single handler this never matters. (`lickback-drain.mjs` / `lickback-next.mjs` are the
  superseded poll-loop scripts; the wait loop above replaces them.)

## Promotion

Promoted to a thin agent type — `.claude/agents/slicc-lickback-handler.md` (model:
`sonnet`, body points back here). The reason is **model-pinning**: the Agent tool's
inline `model` arg is silently dropped (anthropics/claude-code#31027), so a dispatch
that _said_ `model: sonnet` actually ran the handler on Opus-xhigh; the only honored
surface is the agent-file frontmatter. The agent is intentionally thin — it just reads
this SKILL.md and runs "The loop", so the logic lives in one place. The routing guard
above still keeps a direct (non-dispatched) invocation from running inline.
