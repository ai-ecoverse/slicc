# slicc-handoff

Use this skill when the user says things like `handoff to slicc`, `move this to slicc`, `move to the browser`, `test in the browser`, `handoff to browser` or asks you to continue the work in the SLICC browser agent.

## What to do

1. Build a compact JSON payload with:
   - `instruction` (required)
   - optional `title`, `urls`, `context`, `acceptanceCriteria`, `notes`
2. Generate the handoff URL with:
   - `.agents/skills/slicc-handoff/scripts/slicc-handoff payload.json`
   - or pipe JSON directly into `.agents/skills/slicc-handoff/scripts/slicc-handoff`
3. Open the generated `https://www.sliccy.ai/handoff#...` URL in the local browser when possible.
4. Tell the user that SLICC should show an `Accept` / `Dismiss` prompt in the Chat tab.

## Payload guidance

- Keep `instruction` direct and action-oriented.
- Use `urls` only when specific pages matter.
- Keep `acceptanceCriteria` short and concrete.
- Put supporting detail in `context` or `notes`; do not dump full logs unless they are necessary.

## Examples

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff payload.json
```

```bash
cat payload.json | .agents/skills/slicc-handoff/scripts/slicc-handoff --open
```
