---
name: cdp-smoke-test
description: |
  Launch a local SLICC dev instance in a controllable browser (CDP) and run
  smoke tests against the latest build. Two tiers: Tier 1 needs no AI
  provider (boot, panels, terminal, accounts dialog); Tier 2 exercises the
  agent loop through a connected provider (chat, shell tool, browser
  control, scoops, sprinkles). Use when asked to start a SLICC dev instance
  in a browser you control, smoke-test a build, or run
  an autonomous debugging session against the UI.
---

# CDP Smoke Test

Boot the standalone harness with the latest local build, attach over CDP,
and work through the two test tiers. All driving goes through
`scripts/slicc-cdp` (zero-dependency, Node 22+).

## Setup

```bash
# 1. Build the latest code (cherry regenerates worker bridge assets)
npm install
npm run build -w @ai-ecoverse/cherry -w @slicc/webapp -w @slicc/node-server

# 2. Launch — local wrangler UI on :8787, bridge on :5710, ephemeral profile.
#    CHROME_PATH is optional; default is a labeled Chrome for Testing clone.
CHROME_PATH="/Applications/Google Chrome Canary.app" \
  nohup npm run dev:standalone:fresh > /tmp/slicc-dev-harness.log 2>&1 &

# 3. Wait for boot, then confirm CDP is reachable (port is auto-resolved,
#    NOT 9222 — slicc-cdp greps it from the harness log automatically)
sleep 20 && grep "Chrome CDP listening" /tmp/slicc-dev-harness.log
.agents/skills/cdp-smoke-test/scripts/slicc-cdp targets
```

Attach the console watcher before testing — a clean log at the end is part
of the pass criteria:

```bash
nohup .agents/skills/cdp-smoke-test/scripts/slicc-cdp watch /tmp/slicc-console.log >/dev/null 2>&1 &
```

## Tier 1 — no AI provider required

Validates infrastructure: build, harness, bridge, UI shell, kernel.
Checks and tier-specific pitfalls:
[tier1-infrastructure.md](tier1-infrastructure.md).

## Tier 2 — AI provider required (chat interaction)

Validates the agent loop. First connect a provider — Adobe shown here:

```bash
.agents/skills/cdp-smoke-test/scripts/slicc-cdp click "Add AI"
.agents/skills/cdp-smoke-test/scripts/slicc-cdp select adobe
.agents/skills/cdp-smoke-test/scripts/slicc-cdp click "Login with Adobe"
# IMS popup appears as a new page target titled "Sign in".
# HAND OFF to the user for credentials — never enter them yourself.
```

Verify login landed:

```bash
.agents/skills/cdp-smoke-test/scripts/slicc-cdp eval \
  "JSON.parse(localStorage.getItem('slicc_accounts')||'[]').map(a=>({p:a.providerId,ok:!!a.accessToken}))"
```

Then run the chat-driven checks with `slicc-cdp prompt` (poll the transcript
with `slicc-cdp eval "document.body.innerText.slice(-600)"` between steps):

| Check           | Prompt                                                                                      | Pass                                                                 |
| --------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Stream          | `Reply with exactly one word: pong`                                                         | `pong` streams, header cost ticks                                    |
| Shell tool      | `Run: ls /workspace && echo hi > /workspace/t.txt && cat /workspace/t.txt`                  | raw output in transcript, file in Files · VFS tree                   |
| Browser control | `Open https://example.com and tell me the h1, then close the tab`                           | `Example Domain` (agent sets up playwright-cli itself)               |
| Scoops + licks  | `Spawn a scoop named smoke that writes /shared/note.txt with 'scoop-ok', wait, then cat it` | scoop-wait lick fires, cone verifies content, scoop tab chip appears |
| Sprinkles       | `Create a sprinkle called clock showing the time, updating every second, and open it`       | cone delegates to an owning scoop, widget renders live in sidebar    |

## Report

Summarize pass/fail per tier, console-watcher findings, harness-log
anomalies, and the total session cost from the header counter.

## Pitfalls

- **Closed the leader tab?** The harness survives. The log **redacts**
  `bridgeToken`, so recover it from the ephemeral profile's history:
  `sqlite3 <profile>/Default/History "select url from urls where url like
'%bridgeToken%'"`, then reopen that URL via `location.href` or
  `/json/new`. Profile path is in the harness log (`Fresh profile: …`).
- Pre-provider `lick · discovery` events leave permanent "No API key
  configured" error cards in the transcript — expected before Tier 2, not
  a live failure.
- Adobe `userName` may be undefined after login (IMS userinfo fetch can
  fail silently) — token validity is what matters.
- Second instance alongside: `PORT=5720 npm run dev:standalone:fresh`
  (ports and profile auto-isolate).
