---
name: welcome
description: Handle onboarding lick from the welcome sprinkle
allowed-tools: bash
---

# Welcome Onboarding

When you receive a `[Sprinkle Event: welcome]` with `onboarding-complete`, follow these steps in order. Do NOT skip any step.

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

- **Do NOT close the welcome panel.** Never run `sprinkle close welcome`. The user will close it themselves.
- **Do NOT use `update_global_memory`.** Use `edit_file` to update `/shared/CLAUDE.md`.
- **You MUST include the shtml table below.** Do not skip it, do not replace it with cards.

## Steps

**Step 1.** Install relevant skills based on the user's profile. Run these `bash` commands silently (do NOT show the output to the user — just execute them). Pick the skills that match:

| Profile signal | Skill to install |
|---|---|
| `apps` contains `"aem"` | `upskill anthropics/skills --skill aem` |
| `apps` contains `"imessage"` | `upskill anthropics/skills --skill bluebubbles` |
| Any developer, founder, or side-project user | `upskill anthropics/skills --skill skill-creator` |
| `tasks` contains `"build-websites"` or `"browser-automation"` | `upskill anthropics/skills --skill web-artifacts-builder` |
| `tasks` contains `"write-content"` | `upskill anthropics/skills --skill doc-coauthoring` |
| `tasks` contains `"extract-data"` or `"research"` | `upskill anthropics/skills --skill xlsx` |

Always install `skill-creator` unless the user skipped everything. Run matching installs in sequence (not parallel — each is a bash call). Ignore failures silently; the user can install later.

**Step 2.** Use `edit_file` on `/shared/CLAUDE.md` to add a `## User Profile` section right after the `# sliccy` heading with the user's name, purpose, role, and interests from the profile data.

**Step 3.** Write a one-sentence greeting using their name, matching tone to purpose (professional for work, playful for exploring, encouraging for school).

**Step 4.** Immediately after the greeting, include a ` ```shtml ` code block with a capability table. Copy this template exactly, changing only the task names and descriptions to match the user's profile. Use 3-4 rows:

```shtml
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:10px 8px;font-weight:700">Scaffold a site</td><td style="padding:10px 8px;color:#707070">Generate a starter HTML/CSS/JS project</td><td style="padding:10px 8px;text-align:right"><a href="#" onclick="event.preventDefault();slicc.lick({action:'start-task',task:'scaffold-site'})" style="color:#3B63FB;font-weight:600;text-decoration:none">Try it →</a></td></tr>
<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:10px 8px;font-weight:700">Automate a workflow</td><td style="padding:10px 8px;color:#707070">Set up a cron task or browser macro</td><td style="padding:10px 8px;text-align:right"><a href="#" onclick="event.preventDefault();slicc.lick({action:'start-task',task:'automate'})" style="color:#3B63FB;font-weight:600;text-decoration:none">Try it →</a></td></tr>
<tr><td style="padding:10px 8px;font-weight:700">Research a topic</td><td style="padding:10px 8px;color:#707070">Scrape sites and summarize findings</td><td style="padding:10px 8px;text-align:right"><a href="#" onclick="event.preventDefault();slicc.lick({action:'start-task',task:'research'})" style="color:#3B63FB;font-weight:600;text-decoration:none">Try it →</a></td></tr>
</table>
```

**Step 5.** End with one natural line inviting them to pick a task or type their own request.

## Handling follow-up licks

- **`start-task` lick** — treat as the user's first request, begin the task immediately.
- **Sparse profiles** (user skipped most steps) — keep greeting brief, ask what they need.
