# slicc-handoff

Use this skill when the user says things like `handoff to slicc`, `move this to slicc`, `move to the browser`, `test in the browser`, `handoff to browser` or asks you to continue the work in the SLICC browser agent.

## What to do

1. Compose a single-line, action-oriented instruction.
2. Pick a verb prefix:
   - `handoff:<instruction>` — continue the task in SLICC.
   - `upskill:<github-url>` — ask SLICC to install a skill from a GitHub repo.
3. Run the script with `--open` to open the handoff URL:
   - `.agents/skills/slicc-handoff/scripts/slicc-handoff --open "handoff:<instruction>"`
4. Tell the user SLICC will show an approval prompt in the Chat tab.

## How it works

The script builds a URL like `https://www.sliccy.ai/handoff?msg=<urlencoded>`. Two delivery paths fire in parallel:

- **Localhost POST** to `http://localhost:${SLICC_PORT ?? 5710}/api/handoff` with `{sliccHeader, url, title}`. The node-server rebroadcasts it as a navigate lick to the connected webapp. This is the profile-independent path — it reaches SLICC even when the user's default browser is a different Chrome profile than the one SLICC controls.
- **`--open`** opens the URL in the local browser. If that browser profile has the SLICC extension installed, `chrome.webRequest` observes the `x-slicc` response header and emits the navigate lick.

Either path results in a yes/no approval card in the cone; accept dispatches by verb prefix.

## Examples

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "Continue the signup flow in the browser"
```

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff --open "upskill:https://github.com/slicc/skills-extra"
```
