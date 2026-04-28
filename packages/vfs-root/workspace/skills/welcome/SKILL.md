---
name: welcome
description: Render the welcome wizard on first run and acknowledge the user once they have wired up an LLM provider.
allowed-tools: bash
---

# Welcome Onboarding

The deterministic onboarding flow now lives in the webapp itself. The user fills in the welcome wizard, receives three pre-canned sliccy intro lines, picks an LLM provider, and enters their key — all without you being involved. You only get pulled in once an LLM is actually connected, at which point you reply with one short, personable message commenting on the user's provider/model choice.

There are exactly **two** events you handle.

## Trigger 1: First-run welcome lick

When you receive a `[Sprinkle Event: welcome]` lick whose body has `action: 'first-run'`, this is the user's very first launch of SLICC. Render the welcome wizard as an inline dip by replying with a one-line greeting and the dip image reference:

```
Welcome to SLICC — let's get you set up.

![](/shared/sprinkles/welcome/welcome.shtml)
```

The chat panel auto-detects `.shtml` image references and mounts them as sandboxed dip iframes. Do NOT save a profile, install skills, or write any further explanation — the wizard handles that and the deterministic flow takes over from here.

## Trigger 2: Onboarding complete WITH provider

When you receive a `[Sprinkle Event: welcome]` with `action: 'onboarding-complete-with-provider'`, the user has already finished the wizard, picked a provider, entered an API key, and the webapp validated it. The lick payload looks like:

```json
{
  "action": "onboarding-complete-with-provider",
  "data": {
    "profile": {
      "name": "Paolo",
      "purpose": "work",
      "role": "developer",
      "tasks": ["build-websites"]
    },
    "provider": "openai",
    "model": "gpt-4o",
    "modelLabel": "GPT-4o",
    "validation": "ok"
  }
}
```

Your one and only job is to send a single short message that:

1. Greets the user by name (or warmly acknowledges them anonymously if `profile.name` is empty).
2. Comments specifically on the chosen `provider` and `modelLabel` (or `model`) — a sentence or two of genuine reaction. If `validation` is `"skipped"`, briefly note that the key was saved but the live probe couldn't run.
3. Invites them to tell you what they'd like to work on first.

Keep it under 5 sentences. Do **not** print a capability table, do **not** call `update_global_memory`, do **not** install anything (the orchestrator already kicked off `upskill recommendations --install` in the background), do **not** edit `/shared/CLAUDE.md`.

## Handling shortcut-migrate

When you receive a `[Sprinkle Event: welcome]` with `shortcut-migrate`:

1. Run this command silently (do NOT show the output to the user):

```bash
upskill aemcoder/skills --path migration --all
```

2. If it succeeds, do nothing further. The `migrate-page.shtml` sprinkle has `data-sprinkle-autoopen` and opens automatically after installation.
3. If it fails, tell the user the install failed and suggest they retry manually with `upskill aemcoder/skills --path migration --all`.
