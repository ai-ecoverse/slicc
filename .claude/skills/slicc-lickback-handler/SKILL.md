---
name: slicc-lickback-handler
description: |
  Use this skill to be the external brain for a running SLICC cup — when the
  operator says "be the brain for my SLICC", "drive / handle / answer my SLICC
  chat", or similar. A cup runs no internal cone, so its chat panel has no
  responder; this skill discovers the cup, claims its chat channel, and answers
  the human's messages in a background subagent. All discovery, session, claim,
  drain, lease/409, and reply plumbing is handled by bundled scripts — no ports,
  UUIDs, curl, or HTTP status codes are ever surfaced to the operator. Pairs with
  `slicc-cup` (the steering API reference).
---

# slicc-lickback-handler

A **cup** SLICC instance runs no internal cone, so the browser's chat panel and
the cone's lick inbox have no responder. **You are that responder** — the
external Claude brain that answers the human typing in the cup's chat panel.

**Only available for the standalone CLI cup float** (spec §11) — the extension has
no node-server. If there is no cup running, tell the operator to launch one
(`npm run cup`) and stop.

The scripts referenced below live in the `scripts/` directory next to this
SKILL.md (this skill's base directory, shown to you when the skill loads). Set
`SCRIPTS` to that absolute path once.

## Routing — read this FIRST

<HANDLER-ROUTING>
- **If you are the top-level / interactive session** (the operator is talking to
  you directly): do NOT run the loop here. Dispatch a subagent with this skill and
  the instruction *"be the lick-back handler for the running SLICC cup"*, reply to
  the operator **"Handling your SLICC chat in the background."**, and return. The
  handler must run in a subagent so the operator's session stays free.
- **If you ARE that dispatched handler subagent**: skip this block and run
  **The loop** below.
</HANDLER-ROUTING>

(This mirrors superpowers' own `<SUBAGENT-STOP>`, inverted: a direct invocation
self-corrects into the background path. It is instruction-scoping, not a runtime
lock — so honor it.)

## Setup (handler subagent, once)

```bash
SCRIPTS="<this skill's base dir>/scripts"
CUP_BASE="$(node "$SCRIPTS/cup-discover.mjs")" || {
  echo "No cup running — ask the operator to start one with: npm run cup"; exit 0; }
SLICC_SESSION="$(node -e 'console.log(crypto.randomUUID())')"
```

`cup-discover.mjs` reads `~/.slicc/cup.json`, confirms the cup is alive, and
prints its base URL (or exits non-zero with a "start a cup" message).

**Hold `CUP_BASE` and `SLICC_SESSION` in your context and prefix EVERY script
call with them** — Claude Code shells do not persist env between calls:

```bash
CUP_BASE="$CUP_BASE" SLICC_SESSION="$SLICC_SESSION" node "$SCRIPTS/<script>.mjs" …
```

## The loop

1. **Claim** the chat channel:

   ```bash
   CUP_BASE=… SLICC_SESSION=… node "$SCRIPTS/lickback-claim.mjs"
   ```

   - exit `0` → you own it. Continue.
   - exit `3` → **already handled by another brain. Report "already handled,
     standing down." and STOP.** (Ownership is cup-owned and atomic — retrying
     never wins.)

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
   - `kind:"chat"` → answer `text` as the user's coding assistant. For real work
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
- **On a lost claim (exit 3), stand down.** Don't fight an atomic, cup-owned claim.
- **Hand back cleanly:** kill the drain and stop — the lease lapses (~45s) and the
  channel frees fast.

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
