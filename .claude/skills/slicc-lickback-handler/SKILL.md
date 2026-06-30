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
  2. For the chat-answer loop, **dispatch a background subagent on Sonnet**
     (`model: sonnet`) with this skill and the instruction *"be the lick-back handler for
     the running SLICC cup"*, tell the operator **"Answering your SLICC chat in the
     background."**, and continue (don't block — you stay free to steer). The handler
     runs in a subagent so the operator's session stays free.
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

- `GET /api/vfs/read?path=/shared/CLAUDE.md` — SLICC's agent system prompt (ice-cream
  vocabulary, shell-first philosophy, runtime conventions). Read it and adopt it.
- Read `/workspace/skills/playwright-cli/SKILL.md` and `/workspace/skills/mount/SKILL.md`
  IN FULL — driving the browser is SLICC's whole point and the one surface that
  _wedges_ the instance when misused — then `POST /api/vfs/list {"path":"/workspace/skills"}`
  and read any others the task implicates.

See the **slicc-cup** skill ("Bootstrap SLICC's brain") for the exact commands. Do
**not** reach for SLICC's `delegation` / `scoop_scoop` / `workflow` skills to
parallelize — those are cone-only and unreachable over the loopback bridge; that's
your job as the brain, so fan out with your own subagents.

## The loop

1. **Claim** the chat channel:

   ```bash
   CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-claim.mjs"
   ```

   - exit `0` → you own it. Continue. (Before claiming, the script **reaps any
     orphaned drain a prior session left holding THIS cup's channel** — the stale
     receiver that would otherwise pin the claim — then rides out the freed lease's
     ~tail, so a fresh handler no longer dead-locks on a phantom "already claimed".
     It's port-scoped, so a parallel cup's live drain is never touched.)
   - exit `3` → a **live OTHER brain** still owns the channel after the claim's
     retry budget (~60s) lapsed. **Report "already handled, standing down." and
     STOP.** The script already absorbed the lease-tail retry, so re-running won't
     win.

2. **Start the drain** in the background (it holds the SSE open, which pins your
   lease, and buffers every browser message for `lickback-next`):

   ```bash
   CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-drain.mjs" &
   ```

   Run **one** drain only. Never start a second on the same channel.

3. **Answer messages** — repeat:

   ```bash
   SLICC_SESSION=… node "$SCRIPTS/lickback-next.mjs" --wait 30
   ```

   - Prints one frame as JSON `{kind, text, msgId, …}`, or nothing on timeout.
   - `kind:"chat"` → answer `text` as sliccy — an end-user assistant: plain language,
     no ports / sessions / curl / exit codes / "chat channel" plumbing. For real work
     in the cup's browser / VFS, drive it through the **slicc-cup** API/scripts
     (`/api/shell/exec`, `/api/vfs/*`, `/api/targets`). Then send the answer via a
     **quoted heredoc** so apostrophes, quotes, backticks, `$`, and newlines pass
     through verbatim. **Never hand-escape the answer into a shell string** — e.g.
     escaping `'` as `'\''` inside a double-quoted `printf` leaks literally into the
     reply (renders as mangled `'\''`/`'''` in the panel):

     ```bash
     CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-reply.mjs" "$msgId" <<'SLICC_REPLY_EOF'
     …your answer here, exactly as written, no escaping…
     SLICC_REPLY_EOF
     ```

     (For a long or heredoc-unsafe answer, write it to a file with the Write tool
     and redirect: `… node "$SCRIPTS/lickback-reply.mjs" "$msgId" < reply.txt`.)

   - `kind:"upgrade" | "sprinkle" | <other>` → an orphaned cone lick. **Surface it
     to the operator** (informational); do not send a chat reply (no `msgId`).
   - empty (timeout) → re-run `cup-discover.mjs` to confirm the cup is still up,
     then continue.

4. **Stop** when the operator says stop or the cup is gone (drain exits non-zero
   / discovery fails). Kill the background drain — the lease lapses and the
   channel frees for the next claimant.

## Rules

- **One handler, one drain, per channel.** A second drain on a channel you hold
  replaces yours as the live subscriber and orphans it.
- **The reply script always terminates with `done:true`.** The human's composer
  shows a working spinner from send until your reply's `done:true` lands (or they
  hit stop). `lickback-reply.mjs` guarantees the terminator even for an empty /
  decline answer, so the panel never hangs — always use it rather than hand-rolled
  posts.
- **You won't see your own replies on the drain.** The drain is browser→brain
  only; your reply renders in the panel. Don't wait on the drain for your output.
- **On a lost claim (exit 3), stand down.** A persistent 409 means a live OTHER
  brain genuinely owns the channel — the claim already reaped any stale drain and
  retried across the lease tail. Don't fight an atomic, cup-owned claim.
- **Hand back cleanly:** kill the drain and stop — the lease lapses (~45s) and the
  channel frees fast. Even a drain left orphaned (hard kill / crashed session) is
  harmless now: it advertises a pidfile, and the **next** brain's claim reaps it
  (port-scoped) before claiming. **The cup itself stays up** (it's long-lived by
  design). If your setup's `cup-up.mjs` reported it **launched** a new cup (not
  reused one), surface that to the operator on hand-back — a SLICC is still
  running; it can be stopped with `cup-stop.mjs` (see slicc-cup "Stopping a cup").
  Don't stop a cup you only attached to.

## Notes

- The scripts are unit + integration tested under
  `packages/dev-tools/lickback-scripts/` (a fake cup over node:http).
- `lickback-heartbeat.mjs` renews the lease only if you ever drop the drain
  between long replies; while the drain holds the SSE you don't need it.

## Promotion

Authored as a skill, not a dedicated agent type — Claude Code already spawns
subagents, the repo is all-skills, and the routing guard above keeps it from
running inline. Promote to an agent type only if it later needs distinct tools or
permissions; today the loop plus `slicc-cup` is the whole job.
