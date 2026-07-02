---
name: slicc-handoff
description: |
  Use this skill when the user says things like `handoff to slicc`, `move this to slicc`, `move to the browser`, `test in the browser`, `handoff to browser`, `install this skill in slicc`, `upskill slicc with this repo`, `add this skill to slicc`, or otherwise asks you to continue the work in the SLICC browser agent or install a skill into it.
---

# slicc-handoff

Use this skill when the user says things like `handoff to slicc`, `move this to slicc`, `move to the browser`, `test in the browser`, `handoff to browser`, `install this skill in slicc`, `upskill slicc with this repo`, `add this skill to slicc`, or otherwise asks you to continue the work in the SLICC browser agent or install a skill into it.

## What to do

1. Compose a single-line, action-oriented instruction.
2. Pick a verb prefix:
   - `handoff:<instruction>` — continue the task in SLICC.
   - `upskill:<github-url>` — ask SLICC to install a skill from a GitHub repo.
3. Run the script with `--open` to open the handoff URL. Show one of:
   - `.agents/skills/slicc-handoff/scripts/slicc-handoff --open "handoff:<instruction>"`
   - `.agents/skills/slicc-handoff/scripts/slicc-handoff --open "upskill:<github-url>"`
4. Tell the user SLICC will show an approval prompt in the Chat tab.

If the user runs a non-default SLICC instance on another port, prefix the call with `SLICC_PORT=5720` (or whatever port they chose) so the localhost POST hits the right instance.

## How it works

The script builds a URL like `https://www.sliccy.ai/handoff?handoff=<urlencoded>` (or `?upskill=<urlencoded-github-url>`). Two delivery paths fire in parallel:

- **Localhost POST** to `http://localhost:${SLICC_PORT ?? 5710}/api/handoff` with the structured payload `{ verb, target, instruction?, url, title }` — `verb` is `handoff` or `upskill`, `target` is the github URL for upskill or the handoff URL for handoff, and `instruction` carries the prose for handoff. The node-server rebroadcasts it as a `navigate` lick to the connected webapp. Profile-independent: reaches SLICC even when the user's default browser is a different Chrome profile than the one SLICC controls.
- **`--open`** opens the URL in the local browser. If that browser profile has the SLICC extension installed, `chrome.webRequest` parses the response's RFC 8288 `Link` header (rel `https://www.sliccy.ai/rel/handoff` or `https://www.sliccy.ai/rel/upskill`) and emits the navigate lick when one of those rels is present.

Either path results in a `navigate` lick in the cone. A `handoff:` shows a yes/no approval card the user must accept (the card flips to ✓/✗ on their click); an `upskill:` is installed when the cone calls `lick_confirm` (or skipped via `lick_dismiss`). See `/workspace/skills/handoff/SKILL.md`.

## Examples

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "Continue the signup flow in the browser"
```

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "upskill:https://github.com/slicc/skills-extra"
```

Install only a sub-path of a repo (a single skill on a specific branch):

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "upskill:https://github.com/slicc/skills-extra/tree/main/skills/foo"
```
