---
name: cdp-smoke-test
description: |
  Launch a local SLICC dev instance in a controllable browser (CDP) and run
  smoke tests against the latest build. Three tiers: Tier 1 needs no AI
  provider (boot, panels, terminal, accounts dialog); Tier 2 exercises the
  agent loop through a connected provider (chat, shell tool, browser
  control, scoops, sprinkles, transcript export); Tier 3 pairs a leader with
  a real follower runtime for tray features (teleport, delegated OAuth,
  federated CDP, follower rails). Use when asked to start a SLICC dev
  instance in a browser you control, smoke-test a build, test a
  leader/follower or tray feature end to end, run an autonomous debugging
  session against the UI, or send a prompt to a running SLICC and read its
  assistant reply.
---

# CDP Smoke Test

Boot the standalone harness with the latest local build, attach over CDP,
and work through the two test tiers. Manual local-harness driving goes through
`scripts/slicc-cdp` (zero-dependency, Node 22+).

## Setup

**Production safety boundary:** `:5710` (bridge) and `:9222` (Chrome CDP)
belong to the developer's production SLICC. Never bind, reap, or kill either
port. The smoke-test lane uses bridge `:5715`; its Chrome CDP port is
auto-resolved.

### Default mode — hosted origin (recommended)

Chrome opens `https://www.sliccy.ai` with a `?bridge=ws://localhost:5715/cdp`
parameter that routes it back to the local node-server. No wrangler needed.
OAuth, IMS (Adobe), and all provider relays work out of the box because they
are hosted on the production origin.

> **Important:** in this mode the browser loads the **deployed production
> webapp** from `sliccy.ai`, not your local checkout. Changes to
> `packages/webapp/` are not exercised. Use this mode for:
> smoke-testing the node-server bridge, provider login flows, tray and
> scoops features, and CDP automation. Use the local-wrangler mode below
> when you need to verify a webapp change end-to-end before deploying.

```bash
# 1. Record production listeners before doing anything else.
PROD_BRIDGE_PIDS=$(lsof -nP -tiTCP:5710 -sTCP:LISTEN 2>/dev/null | sort -n | paste -sd, -)
PROD_CDP_PIDS=$(lsof -nP -tiTCP:9222 -sTCP:LISTEN 2>/dev/null | sort -n | paste -sd, -)
printf 'production preflight: :5710=%s :9222=%s\n' "${PROD_BRIDGE_PIDS:-none}" "${PROD_CDP_PIDS:-none}"

# 2. Build only node-server (no webapp build required — UI loads from sliccy.ai).
npm install
npm run build -w @slicc/node-server

# 3. Launch — hosted origin, isolated bridge :5715, ephemeral profile.
#    CHROME_PATH is optional; default is a labeled Chrome for Testing clone.
export SLICC_HARNESS_LOG=/tmp/slicc-dev-harness-5715.log
CHROME_PATH="/Applications/Google Chrome Canary.app" \
  PORT=5715 \
  nohup npm run dev:standalone:fresh > "$SLICC_HARNESS_LOG" 2>&1 &

# 4. Wait for boot and export the auto-resolved CDP port from this lane's log.
sleep 20 && grep "Chrome CDP listening" "$SLICC_HARNESS_LOG"
export SLICC_CDP_PORT=$(sed -nE 's/.*Chrome CDP listening on port ([0-9]+).*/\1/p' "$SLICC_HARNESS_LOG" | tail -1)
test -n "$SLICC_CDP_PORT"
.agents/skills/cdp-smoke-test/scripts/slicc-cdp targets

# 5. Pass criterion: production listeners are exactly the preflight PIDs.
POST_BRIDGE_PIDS=$(lsof -nP -tiTCP:5710 -sTCP:LISTEN 2>/dev/null | sort -n | paste -sd, -)
POST_CDP_PIDS=$(lsof -nP -tiTCP:9222 -sTCP:LISTEN 2>/dev/null | sort -n | paste -sd, -)
test "$POST_BRIDGE_PIDS" = "$PROD_BRIDGE_PIDS" && test "$POST_CDP_PIDS" = "$PROD_CDP_PIDS"
```

The browser URL will be:

```text
https://www.sliccy.ai/?bridge=ws%3A%2F%2Flocalhost%3A5715%2Fcdp&bridgeToken=<token>…
```

`bridge=` connects the hosted UI back to the local node-server; `bridgeToken=`
gates the bridge WebSocket. The UI is always served from `sliccy.ai` — the
local process is only the CDP/API relay.

### Alternate mode — local wrangler dev server

Use when you need to test a local **webapp** or **worker** change before
deploying. Set `WORKER_BASE_URL` to a loopback URL; the port is derived from
the URL automatically. **OAuth and IMS (Adobe) will not work from `localhost`
origins** — use the hosted-origin mode for any provider login testing.

For explicit non-loopback staging/alternate origins (e.g.
`WORKER_BASE_URL=https://slicc-staging.example.workers.dev`), the script uses
that URL directly without starting wrangler.

```bash
export SLICC_HARNESS_LOG=/tmp/slicc-dev-harness-5715.log
CHROME_PATH="/Applications/Google Chrome Canary.app" \
  PORT=5715 WORKER_BASE_URL=http://localhost:8787 \
  nohup npm run dev:standalone:fresh > "$SLICC_HARNESS_LOG" 2>&1 &
```

This also starts wrangler on `:8787` (or reuses an existing one). A full
build (`npm run build -w @ai-ecoverse/cherry -w @slicc/webapp -w
@slicc/node-server`) is required beforehand so wrangler has `dist/ui/` to
serve.

Attach the console watcher before testing — a clean log at the end is part
of the pass criteria. Reset the log first (it appends, so a stale error
from a previous run would fail a clean run) and verify the watcher
actually attached before starting checks:

```bash
rm -f /tmp/slicc-console.log
nohup .agents/skills/cdp-smoke-test/scripts/slicc-cdp watch /tmp/slicc-console.log >/dev/null 2>&1 &
sleep 2 && grep -q 'watcher attached' /tmp/slicc-console.log || echo 'WATCHER FAILED'
```

## Tier 1 — no AI provider required

Validates infrastructure: build, harness, bridge, UI shell, kernel.
Checks and tier-specific pitfalls:
[tier1-infrastructure.md](tier1-infrastructure.md).

## Tier 2 — AI provider required (chat interaction)

Validates the agent loop: provider connect (with user credential handoff),
streaming, tool use, scoops, sprinkles, and transcript export (cone + scoop
bundle via `session export`). Checks and tier-specific pitfalls:
[tier2-agent-loop.md](tier2-agent-loop.md).

## Tier 3 — leader + follower (tray features)

Needed for anything crossing the tray: teleport, delegated OAuth, federated
CDP, follower rails. Two SLICC runtimes, not two browser windows — and the
follower must both _advertise the capability under test_ and _run your build_.
Follower selection, the origin rule, the port map, and the terminal-driving
pitfalls: [tier3-multi-harness.md](tier3-multi-harness.md).

## Report

Summarize pass/fail per tier, console-watcher findings, harness-log
anomalies, and the total session cost from the header counter. For Tier 3 also
state which build each runtime ran and which capabilities each follower
advertised — a result from a follower running released code, or one that never
advertised the capability, is not evidence.

## Pitfalls

- Never use `pkill` or `killall` on Chrome, node, or wrangler. Never `kill` a
  PID resolved from `:5710` or `:9222`. If any chosen harness port is
  occupied, select another isolated port instead of clearing it.
- The standalone guard fails fast, exits non-zero, and reports the PID and
  command holding the selected bridge port. `SLICC_FRESH_REAP=1` opts into
  reaping only a stale harness on a non-production bridge port that you have
  verified you own. Forced reaping of `:5710` is refused; choose another port
  or stop your own `:5710` process manually. Chrome CDP is never reaped.
- **Closed the leader tab?** The harness survives. **Diagnostic-only, do
  not automate**: the harness log redacts `bridgeToken` deliberately — the
  token is a capability. As a manual last resort during an interactive
  debugging session, it can be recovered from the ephemeral profile's
  history (`sqlite3 <profile>/Default/History "select url from urls where
url like '%bridgeToken%'"`) and the tab reopened via CDP `Page.navigate`
  (see below). **Do not use `/json/new?URL`** — Chrome parses everything
  after the first `&` as a separate query parameter on the outer
  `/json/new` request, silently dropping `&bridgeToken=...` from the
  loaded URL; `parseBridgeLaunchParams` requires the token and returns
  `null` without it, so `setLocalApiBaseUrl` is never set and every
  `/api/fetch-proxy` call lands on wrangler (404). Use `Page.navigate`
  instead:

  ```bash
  node --input-type=module << 'EOF'
  const ws = new WebSocket('ws://localhost:<CDP_PORT>/devtools/page/<PAGE_ID>');
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Page.navigate',
      params: { url: '<FULL_SLICC_URL_WITH_BRIDGE_TOKEN>' } }));
  });
  ws.addEventListener('message', (e) => { console.log(e.data); ws.close(); });
  EOF
  ```

  Prefer restarting the harness when nothing valuable would be lost.
  Never print the token into transcripts or scripts.

- Additional instance alongside: choose another unused bridge port, for
  example `PORT=5716 WRANGLER_PORT=8787 npm run dev:standalone:fresh`.
  Profiles and Chrome CDP ports auto-isolate; an occupied bridge fails fast.
