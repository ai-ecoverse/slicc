# Tier 2 — Agent loop (AI provider required)

Validates the agent loop end-to-end through chat interaction: streaming,
tool use, scoops, and sprinkles.

Prerequisite: Tier 1 passed
([tier1-infrastructure.md](tier1-infrastructure.md)).

## Connect a provider

Adobe shown here:

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

## Checks

Run with `slicc-cdp prompt` (poll the transcript with
`slicc-cdp eval "document.body.innerText.slice(-600)"` between steps):

| Check           | Prompt                                                                                      | Pass                                                                 |
| --------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Stream          | `Reply with exactly one word: pong`                                                         | `pong` streams, header cost ticks                                    |
| Shell tool      | `Run: ls /workspace && echo hi > /workspace/t.txt && cat /workspace/t.txt`                  | raw output in transcript, file in Files · VFS tree                   |
| Browser control | `Open https://example.com and tell me the h1, then close the tab`                           | `Example Domain` (agent sets up playwright-cli itself)               |
| Scoops + licks  | `Spawn a scoop named smoke that writes /shared/note.txt with 'scoop-ok', wait, then cat it` | scoop-wait lick fires, cone verifies content, scoop tab chip appears |
| Sprinkles       | `Create a sprinkle called clock showing the time, updating every second, and open it`       | cone delegates to an owning scoop, widget renders live in sidebar    |

## Interrupt / stop mid-stream

1. Send a long generation (`Count from 1 to 2000, one number per line, no
other text.`) — use a genuinely long task; short ones finish before the
   click lands.
2. ~2 s in, `slicc-cdp click "Stop"` (the Send button swaps to Stop while
   streaming).
3. Assert: the count never completes, output stops growing (re-check a few
   seconds later), Stop reverts to Send, and the console watcher stays
   clean — the abort must not surface errors.

## Cron lick (scheduled prompt)

1. Prompt: `Schedule a one-shot cron task that fires in 1 minute and writes
the file /workspace/cron-fired.txt containing 'cron-ok'. Confirm the task
is registered, then just wait.`
2. Monitor → Cron Tasks shows the registered task (name + cron expression).
3. Wait ~90 s. Assert: the process list gains a `prompt cron:…` entry (the
   lick fired a prompt into the cone), `cat /workspace/cron-fired.txt` →
   `cron-ok`, and Cron Tasks is back to `0` (one-shot cleanup).
4. Clean up: `rm /workspace/cron-fired.txt`.

## Feed scoop (live sprinkle edit)

Requires the resident clock-scoop from the Sprinkles check:

1. Prompt: `Feed the clock scoop this task: change the clock sprinkle so the
time text is rendered in green (#00c853). Wait for it to finish and
confirm.`
2. Assert pixel-level, not just transcript claims:
   `slicc-cdp eval` a shadow-piercing lookup of `#clock-time` →
   `getComputedStyle(el).color` = `rgb(0, 200, 83)`.

## Transcript export (cone + scoop bundle)

Validates the `session export` shell command end-to-end against a live
session: normalized bundle, cone + scoop conversations, fail-closed
credential redaction, and the reasoning-excluded invariant. Runs entirely
in-browser (shell + VFS) — no host-side download plumbing.

Prereq: a completed turn that spawned at least one scoop (the Scoops check
above leaves the resident `clock` scoop; any turn with a scoop works). The
export waits for all scoops to reach idle before packaging.

1. Write the bundle to the VFS (avoids browser-download interception):
   ```bash
   slicc-cdp term "session export --output /workspace/transcript.zip"
   # term-text → "exported /workspace/transcript.zip"
   slicc-cdp term "unzip /workspace/transcript.zip -d /workspace/tx"
   ```
2. Validate with an in-browser `node -e` script that emits a single
   marker-bracketed line. The terminal hard-wraps at ~28 cols, so bracket
   the output with `@@B@@`/`@@E@@` and strip newlines between the markers
   to reconstruct — a one-line payload has no meaningful newlines, unlike
   the pretty-printed `transcript.json` itself (`JSON.stringify(_, null, 2)`,
   so never de-wrap the file directly). Keep the script quote-safe: single
   quotes around `-e`, only double quotes inside.
   ```bash
   slicc-cdp term 'node -e '\''const fs=require("fs");const d=JSON.parse(fs.readFileSync("/workspace/tx/transcript.json","utf8"));const c=d.conversations||[];const has=k=>c.some(x=>x.kind===k);const t=JSON.stringify(d);console.log("@@B@@sv="+d.schemaVersion+";cone="+(has("cone")?1:0)+";scoop="+(has("scoop")?1:0)+";cred="+(t.includes("sk-proj-1234")?0:1)+";reason="+(d.privacy&&d.privacy.reasoningExcluded?1:0)+";convs="+c.length+"@@E@@")'\'''
   ```
3. Extract and assert the de-wrapped payload. The terminal echoes the
   command (whose source literally contains the marker strings), so match
   the value payload — markers followed by `sv=<digit>` — not the echo:
   ```bash
   slicc-cdp term-text | tr -d '\n' | grep -oE '@@B@@sv=[0-9][^@]*@@E@@' | tail -1
   # → @@B@@sv=1;cone=1;scoop=1;cred=1;reason=1;convs=2@@E@@
   ```
   Assert `sv=1`, `cone=1`, `scoop=1`, `cred=1` (the seeded credential is
   absent → redacted), `reason=1` (`reasoningExcluded`), `convs>=2` (cone +
   each scoop). The console watcher must stay clean — redaction failure is
   fail-closed and would surface as an export error, not a silent pass.

Local UI path (optional): the avatar menu's **Export transcript** action
(`slicc-cdp eval` dispatching `slicc-avatar-action` with
`{id:'export-transcript'}`) triggers a real browser download instead of a
VFS write — driving that needs `Page.setDownloadBehavior` over CDP, so the
shell path above is the autonomous default.

## Model switching

Route a prompt through each Adobe model — `claude-opus-4-8` especially,
since it exercises the adaptive-thinking + temperature-strip shims in
`providers/adobe.ts`:

1. `slicc-cdp click "Claude Sonnet 5"` (the composer model selector — it
   TOGGLES, so don't re-click to "reopen") → menu lists the proxy models
   with an `Adobe` badge.
2. `slicc-cdp click "Claude Opus 4.8 Adobe"` (menu rows are
   `<name>\n<provider>`; `click` matches whitespace-normalized text).
3. Send the pong prompt → response streams.
4. Open Monitor → `↻ Refresh` → Cost section lists a per-model row
   (`claude-opus-4-8` alongside `claude-sonnet-5`) — cost attribution is
   per model, not pooled.
5. Switch back to `Claude Sonnet 5 Adobe` for the remaining checks.

## Session lifecycle (run LAST — archives the transcript)

1. `slicc-cdp click "New chat"` (left rail) — the session is summarized and
   archived (a brief spinner replaces the icon while it saves).
2. Assert: transcript empty, cost counter reset, but the clock sprinkle +
   its resident scoop deliberately survive.
3. Open the freezer (`Toggle freezer`, check `aria-expanded`) — the
   archived session appears with an AI-generated title and turn count
   (e.g. `Smoke Tests, Clock Sprinkle, and … — Jul 20 · 70 turns`).

## Pitfalls

- Pre-provider `lick · discovery` events leave permanent "No API key
  configured" error cards in the transcript — expected before this tier,
  not a live failure.
- Adobe `userName` may be undefined after login (IMS userinfo fetch can
  fail silently) — token validity is what matters.
