---
name: welcome
description: |
  Use this when you receive a `[Sprinkle Event: welcome]` lick with
  `action: 'onboarding-complete-with-provider'` — fired exactly once after the
  user finishes the first-run wizard and validates an LLM provider. Send a
  short personalized reply (greet by name, react to provider/model, three
  follow-up actions: obvious + obligatory + outrageous), then silently run
  `upskill recommendations --install`. Do not handle any other welcome events.
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
2. Closes with **exactly three concrete follow-up actions** the user can take right now, written as a markdown bulleted list with one short imperative each. Ground the suggestions in the user's `profile.tasks` / `profile.role` / `profile.purpose` — the post-reply install step below lands the user's recommended skill set, so it's safe to reference task-matching skills (e.g. `migrate-page` for `tasks: ['migrate-page-aem']`) even though they aren't on disk yet at reply time. The three bullets must follow this mix exactly:
   - **One obvious** — the natural next step a user with this profile would expect, ideally invoking a freshly installed skill that matches their stated tasks (e.g. for an AEM developer with `migration` installed: "Try `migrate-page` on a real AEM URL").
   - **One obligatory** — the practical setup-or-housekeeping step they really should do before anything else (e.g. "Run `git config --global user.email …` so your commits are attributed", "Open the Files tab and mount your project directory", or "Drop your team's coding-style doc into chat so I can pick it up").
   - **One outrageous** — a deliberately bold, slightly-cheeky use of the available skills that pushes the user beyond their stated profile and shows what's possible (e.g. "Ask me to rewrite your homepage in pirate English", "Have me generate a brand-compliance report for your competitor's site", or "Spin up a scoop that drafts your next pull request from a one-line brief"). Keep it tasteful but unmistakably playful.

   Pick concrete suggestions that actually fit what's installed; do **not** copy the examples above verbatim if they don't fit. If you cannot ground a bullet in the profile or the skill set, fall back to a useful generic one (e.g. "Drop a URL into the chat for me to inspect", "Paste a screenshot you'd like me to analyse").

Do **not** print a capability table, do **not** call `update_global_memory`, do **not** install other skills beyond the `upskill recommendations --install` step below, do **not** edit `/shared/CLAUDE.md`.

After sending the reply, silently run `upskill recommendations --install` (do **not** show the output to the user) to land the user's recommended skill set. The command is profile-driven (it reads `/home/<user>/.welcome.json`, which the webapp persisted when the wizard finished) and idempotent.
