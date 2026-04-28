---
name: welcome
description: Render the welcome wizard on first run and handle the onboarding lick when the user completes it
allowed-tools: bash
---

# Welcome Onboarding

The welcome wizard is an **inline dip** — it lives directly in chat, not in a side panel. When the user completes it, you receive a lick and respond conversationally in the same thread. You can ask follow-up questions, clarify sparse profiles, and continue the conversation naturally.

## Trigger 1: First-run welcome lick

When you receive a `[Sprinkle Event: welcome]` lick whose body has `action: 'first-run'`, this is the user's very first launch of SLICC. Render the welcome wizard as an inline dip by replying with a one-line greeting and the dip image reference:

```
Welcome to SLICC — let's get you set up.

![](/shared/sprinkles/welcome/welcome.shtml)
```

The chat panel auto-detects `.shtml` image references and mounts them as sandboxed dip iframes — no `read_file`, no fenced code block, no panel commands. Do NOT save a profile, update `/shared/CLAUDE.md`, or run `upskill recommendations` yet. Those happen in Trigger 2 below, after the user actually finishes the wizard.

## Trigger 2: Onboarding-complete sprinkle lick

When you receive a `[Sprinkle Event: welcome]` lick with `action: 'onboarding-complete'` (the wizard fires this from inside the dip), follow these steps in order. Do NOT skip any step.

The lick payload contains the user's profile:

```json
{
  "action": "onboarding-complete",
  "data": {
    "purpose": "work",
    "role": "developer",
    "tasks": ["build-websites", "automate"],
    "apps": ["aem"],
    "name": "Paolo"
  }
}
```

## IMPORTANT RULES

- **Do NOT open or close any panel.** This is inline — never run `sprinkle open welcome` or `sprinkle close welcome`.
- **Do NOT use `update_global_memory`.** Use `edit_file` to update `/shared/CLAUDE.md`.
- **You MUST include the shtml table below.** Do not skip it, do not replace it with cards.

## Steps

**Step 1.** Save the user profile and install recommended skills.

First, save the profile. Use the user's name (lowercased, spaces replaced with hyphens) as the home directory. If no name was provided, use `user`. For example, if the name is "Lars", write to `/home/lars/.welcome.json`. If the name is "Paolo Moz", write to `/home/paolo-moz/.welcome.json`.

```bash
write_file /home/<name>/.welcome.json
```

Write the full profile JSON from the lick payload (purpose, role, tasks, apps, name).

Next, check which skills will be installed by running:

```bash
upskill recommendations
```

This reads the saved profile and the skill catalog, and lists matching skills. Briefly tell the user what's being set up — e.g., _"Setting up 4 recommended skills for your profile…"_ — so they know something is happening.

Then install them:

```bash
upskill recommendations --install
```

This outputs progress lines like `[1/N] Installed "skill-name"…`. Let the output show — do NOT suppress it. Once done, briefly summarize what was installed (e.g., _"All set — installed web-dev, git-workflow, and 2 others."_). Ignore any individual failures — the user can install those later.

**Step 2.** Use `edit_file` on `/shared/CLAUDE.md` to add a `## User Profile` section right after the `# sliccy` heading with the user's name, purpose, role, and interests from the profile data.

**Step 3.** Write a one-sentence greeting using their name, matching tone to purpose (professional for work, playful for exploring, encouraging for school). If the profile is sparse (most fields skipped), keep the greeting brief and ask one follow-up question to learn more.

**Step 4.** Immediately after the greeting, include a ` ```shtml ` code block with a capability table. Copy this template exactly, changing only the task names and descriptions to match the user's profile. Use 3-4 rows:

```shtml
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:10px 8px;font-weight:700">Scaffold a site</td><td style="padding:10px 8px;color:#707070">Generate a starter HTML/CSS/JS project</td><td style="padding:10px 8px;text-align:right"><a href="#" onclick="event.preventDefault();slicc.lick({action:'start-task',task:'scaffold-site'})" style="color:#3B63FB;font-weight:600;text-decoration:none">Try it →</a></td></tr>
<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:10px 8px;font-weight:700">Automate a workflow</td><td style="padding:10px 8px;color:#707070">Set up a cron task or browser macro</td><td style="padding:10px 8px;text-align:right"><a href="#" onclick="event.preventDefault();slicc.lick({action:'start-task',task:'automate'})" style="color:#3B63FB;font-weight:600;text-decoration:none">Try it →</a></td></tr>
<tr><td style="padding:10px 8px;font-weight:700">Research a topic</td><td style="padding:10px 8px;color:#707070">Scrape sites and summarize findings</td><td style="padding:10px 8px;text-align:right"><a href="#" onclick="event.preventDefault();slicc.lick({action:'start-task',task:'research'})" style="color:#3B63FB;font-weight:600;text-decoration:none">Try it →</a></td></tr>
</table>
```

**Step 5.** End with one natural line inviting them to pick a task or just tell you what they need.

## Handling shortcut-migrate

When you receive a `[Sprinkle Event: welcome]` with `shortcut-migrate`:

1. Run this command silently (do NOT show the output to the user):

```bash
upskill aemcoder/skills --path migration --all
```

2. If it succeeds, do nothing further. The `migrate-page.shtml` sprinkle has `data-sprinkle-autoopen` and opens automatically after installation.
3. If it fails, tell the user the install failed and suggest they retry manually with `upskill aemcoder/skills --path migration --all`.

Do NOT save a profile, update `/shared/CLAUDE.md`, or write a greeting.

## Handling follow-up licks

- **`start-task` lick** — treat as the user's first request, begin the task immediately.
- **Sparse profiles** (user skipped most steps) — keep greeting brief, ask what they need.
