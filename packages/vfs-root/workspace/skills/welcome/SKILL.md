---
name: welcome
description: Render the welcome wizard on first run and acknowledge the user once they have wired up an LLM provider.
allowed-tools: bash
---

# Welcome Onboarding

The deterministic onboarding flow now lives entirely in the webapp. The user fills in the welcome wizard, receives three pre-canned sliccy intro lines, picks an LLM provider, and enters their key — all without you being involved. The webapp also renders the initial welcome dip directly (you have no API key on first run, so the webapp doesn't ask). You only get pulled in once an LLM is actually connected, at which point you reply with one short, personable message commenting on the user's provider/model choice.

There is exactly **one** event you handle.

## Trigger: Onboarding complete WITH provider

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

Your one and only job is to send a single short reply (≤ 6 sentences total) that:

1. Greets the user by name (or warmly acknowledges them anonymously if `profile.name` is empty) and reacts genuinely to the chosen `provider` + `modelLabel` (or `model`) — a sentence or two. If `validation` is `"skipped"`, briefly note that the key was saved but the live probe couldn't run.
2. Closes with **exactly three concrete follow-up actions** the user can take right now, written as a markdown bulleted list with one short imperative each. Ground the suggestions in `profile.tasks` / `profile.role` / `profile.purpose` — pick concrete things that actually fit what the user told you. For example, for an AEM developer who wants to migrate pages:
   - "Try `migrate-page` on a real AEM URL"
   - "Open the brand-compliance sprinkle on a draft page"
   - "Ask me to scaffold a content tree for `<site>`"
     Do **not** copy those examples verbatim if they don't fit the profile. If you genuinely cannot ground a suggestion in the profile, fall back to a useful generic one (e.g. "Drop a URL into the chat for me to inspect", "Paste a screenshot you'd like me to analyse", or "Tell me about the project you're working on").

Do **not** print a capability table, do **not** call `update_global_memory`, do **not** install anything (the orchestrator already kicked off the recommended-skills install in the background), do **not** edit `/shared/CLAUDE.md`.

## Handling shortcut-migrate

When you receive a `[Sprinkle Event: welcome]` with `shortcut-migrate`:

1. Run this command silently (do NOT show the output to the user):

```bash
upskill aemcoder/skills --path migration --all
```

2. If it succeeds, do nothing further. The `migrate-page.shtml` sprinkle has `data-sprinkle-autoopen` and opens automatically after installation.
3. If it fails, tell the user the install failed and suggest they retry manually with `upskill aemcoder/skills --path migration --all`.
