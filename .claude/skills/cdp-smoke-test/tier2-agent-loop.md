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

## Pitfalls

- Pre-provider `lick · discovery` events leave permanent "No API key
  configured" error cards in the transcript — expected before this tier,
  not a live failure.
- Adobe `userName` may be undefined after login (IMS userinfo fetch can
  fail silently) — token validity is what matters.
