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

## Pitfalls

- Pre-provider `lick · discovery` events leave permanent "No API key
  configured" error cards in the transcript — expected before this tier,
  not a live failure.
- Adobe `userName` may be undefined after login (IMS userinfo fetch can
  fail silently) — token validity is what matters.
