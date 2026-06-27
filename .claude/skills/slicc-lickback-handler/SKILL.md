---
name: slicc-lickback-handler
description: |
  Use this skill when you are the dedicated subagent that owns a SLICC substrate
  lick-back channel — answering the human's chat-panel messages and surfacing the
  browser's orphaned licks (upgrade/sprinkle/…) to the operator. Covers the
  claim → drain (SSE) → reply → heartbeat loop, the event shapes, and how to hand
  back ownership cleanly. Pairs with `slicc-steering` (the protocol reference).
---

# slicc-lickback-handler

A substrate SLICC instance runs no internal cone, so the browser's chat panel and the
cone's lick inbox have no responder. **You are that responder.** This is a persistent,
stateful role: you hold ONE lick-back channel and loop on its events for as long as the
orchestrator wants the human's chat answered.

Protocol details (endpoints, session UUID, reconnect) live in **`slicc-steering` →
"Lick-back: receiving browser events"**. This skill is the _role_, not the wire spec.

**Only available in the standalone CLI substrate float** (spec §11) — the extension has
no node-server.

## When you're spawned

The orchestrator has already decided to claim a channel (today: `chat`) and handed you a
single `X-Slicc-Session` UUID and the base URL (default `http://localhost:5710`). Hold
that UUID for your whole lifetime.

## The loop

```
1. CLAIM   POST /api/lickback/claim  {channel:"chat"}
             ├─ 409 {owner}  → another session owns it; report and STOP (do not fight it).
             └─ 200 {owner, leaseMs} → you own it. Continue.
2. DRAIN   GET /api/lickback?channel=chat   (SSE; hold it open — this also holds your lease)
             for each `data:` frame:
               kind:"chat"      → a human message. REPLY (step 3).
               kind:"upgrade" |
               kind:"sprinkle" |
               kind:<other>     → an orphaned cone lick. SURFACE it to the operator
                                   (it is informational; don't invent a chat reply for it).
3. REPLY   POST /api/lickback/reply  {channel,"replyTo":<msgId>, delta|text, done}
             stream deltas as you generate, then a final frame with done:true.
4. If you ever drop the SSE, HEARTBEAT POST /api/lickback/heartbeat {channel} within the
   lease (~45s) or you lose the channel.
```

A reply renders in the human's panel as a normal streamed assistant turn (tool rows,
copy, spoken-reply all work because the events arrive in order), so prefer **streaming
deltas** over one-shot `text`.

## Rules

- **One handler per claimed channel.** Don't claim a second channel from the same handler.
- **Reply only to `kind:"chat"` frames.** Other kinds (`upgrade`, `sprinkle`, …) are the
  cone's orphaned inbox — surface them to the operator; they have no `replyTo`.
- **`replyTo` is the chat frame's `msgId`** — echo it exactly so the panel threads the
  reply onto the right turn.
- **Hold the SSE to keep the lease.** Only heartbeat when you must drop the stream
  (e.g. between long replies). A dead owner is GC'd in ~45s so the human's chat frees fast.
- **On a lost claim (409), stand down.** Ownership is substrate-owned and atomic; a second
  claimant never wins by retrying.
- **Hand back cleanly:** when the orchestrator is done, just stop holding the SSE and stop
  heartbeating — the lease lapses and the channel frees for the next claimant.

## Promotion

This role is authored as a skill, not a framework — Claude Code already spawns subagents.
Promote it to a dedicated agent-type only if it later needs distinct tools or permissions;
today the loop above plus `slicc-steering` is the whole job.
