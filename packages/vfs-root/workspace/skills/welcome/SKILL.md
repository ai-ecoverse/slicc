---
name: welcome
description: |
  Use this when you receive a `[Sprinkle Event: welcome]` lick with
  `action: 'onboarding-complete-with-provider'` — fired exactly once after the
  user finishes the first-run wizard and validates an LLM provider. Send a
  short personalized reply (greet by name, react to provider/model, three
  follow-up actions: obvious + obligatory + outrageous), then silently run
  `upskill recommendations --install`. Other welcome-flow actions
  (`first-run`, `onboarding-complete`, `connect-ready`, `connect-attempt`,
  `oauth-attempt`, `shortcut-migrate`, `request-mount`) are intercepted by
  the runtime and do not reach the agent — ignore them if they ever leak.
  After onboarding the same card turns into the gelatiere's suggestion
  stream; its `gelatiere-*` licks belong to the `gelatiere` skill, not this one.
allowed-tools: bash
---

# Welcome Onboarding

Wizard is webapp-driven; you join only after LLM validation. Handle **one** event.

## Trigger: `onboarding-complete-with-provider`

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
    "validation": "ok" // or "skipped" or "oauth"
  }
}
```

Reply ≤6 sentences:

1. Greet by `profile.name` (or warmly if empty). React to `provider` + `modelLabel`/`model`. If `validation` is `"skipped"`, note key saved but probe didn't run.
2. **Exactly three bullets** grounded in `profile.tasks`/`role`/`purpose`:
   - **Obvious** — natural next step; may reference a skill `upskill` will install (e.g. `migrate-page` for AEM tasks).
   - **Obligatory** — setup/housekeeping (git email, mount project, share style doc).
   - **Outrageous** — bold playful stretch of available skills (tasteful, not copied verbatim).

No capability table, no `update_global_memory`, no other skill installs, no `/shared/CLAUDE.md` edits.

Then silently: `upskill recommendations --install` (profile from `/home/<user>/.welcome.json`, idempotent).

## After onboarding

`/shared/.welcomed` → card shows gelatiere suggestions from `/shared/.gelatiere/suggestions.json` (Install/Try/Dismiss). Buttons emit `gelatiere-*` licks → `/workspace/skills/gelatiere/SKILL.md`. Re-post: `![Suggestions](/shared/sprinkles/welcome/welcome.shtml)`.
