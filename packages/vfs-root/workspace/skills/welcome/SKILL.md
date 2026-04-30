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
2. Closes with **exactly three concrete follow-up actions** the user can take right now, written as a markdown bulleted list with one short imperative each. Before you write them, take a quick look at the skills currently installed under `/workspace/skills/` — the orchestrator just finished installing the user's recommended set, so those skills (and their sprinkles / commands) are the most relevant surface to suggest. Ground the suggestions in BOTH the user's `profile.tasks` / `profile.role` / `profile.purpose` AND the available skills. The three bullets must follow this mix exactly:
   - **One obvious** — the natural next step a user with this profile would expect, ideally invoking a freshly installed skill that matches their stated tasks (e.g. for an AEM developer with `migration` installed: "Try `migrate-page` on a real AEM URL").
   - **One obligatory** — the practical setup-or-housekeeping step they really should do before anything else (e.g. "Run `git config --global user.email …` so your commits are attributed", "Open the Files tab and mount your project directory", or "Drop your team's coding-style doc into chat so I can pick it up").
   - **One outrageous** — a deliberately bold, slightly-cheeky use of the available skills that pushes the user beyond their stated profile and shows what's possible (e.g. "Ask me to rewrite your homepage in pirate English", "Have me generate a brand-compliance report for your competitor's site", or "Spin up a scoop that drafts your next pull request from a one-line brief"). Keep it tasteful but unmistakably playful.

   Pick concrete suggestions that actually fit what's installed; do **not** copy the examples above verbatim if they don't fit. If you cannot ground a bullet in the profile or the skill set, fall back to a useful generic one (e.g. "Drop a URL into the chat for me to inspect", "Paste a screenshot you'd like me to analyse").

Do **not** print a capability table, do **not** call `update_global_memory`, do **not** install anything (the orchestrator already kicked off the recommended-skills install in the background), do **not** edit `/shared/CLAUDE.md`.

## Handling shortcut-migrate

When you receive a `[Sprinkle Event: welcome]` with `shortcut-migrate`:

1. Run this command silently (do NOT show the output to the user):

```bash
upskill aemcoder/skills --path migration --all
```

2. If it succeeds, do nothing further. The `migrate-page.shtml` sprinkle has `data-sprinkle-autoopen` and opens automatically after installation.
3. If it fails, tell the user the install failed and suggest they retry manually with `upskill aemcoder/skills --path migration --all`.
