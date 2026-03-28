# SLICC Handoff

Use a SLICC handoff when work should continue in the SLICC agent instead of the current local coding agent.

Trigger phrases in this repo:

- `handoff to slicc`
- `move this to slicc`
- `continue this in slicc`
- `test this in slicc`

## Preferred helper

Use the helper bundled with the `slicc-handoff` skill package:

```bash
.agents/skills/slicc-handoff/scripts/slicc-handoff payload.json
```

Pipe JSON from stdin when that is easier:

```bash
cat payload.json | .agents/skills/slicc-handoff/scripts/slicc-handoff --open
```

Override the relay origin for staging or local worker development:

```bash
SLICC_HANDOFF_BASE_URL=https://your-worker.example .agents/skills/slicc-handoff/scripts/slicc-handoff payload.json
```

## Payload shape

Required:

- `instruction`

Optional:

- `title`
- `urls`
- `context`
- `acceptanceCriteria`
- `notes`
- `openUrlsFirst`

Schema reference:

- `docs/schemas/slicc-handoff.schema.json`

## Example

```json
{
  "title": "Verify signup flow",
  "instruction": "Continue this task in SLICC and verify the signup flow works end to end.",
  "urls": ["http://localhost:3000/signup"],
  "context": "I changed the client-side validation and success redirect.",
  "acceptanceCriteria": [
    "The signup form renders",
    "A valid submission reaches the success screen",
    "No uncaught console errors appear"
  ],
  "notes": "Use the current logged-in browser session if needed.",
  "openUrlsFirst": true
}
```

## Guidance

- Assume SLICC has browser/session context, not repo access, unless the user explicitly says otherwise.
- Keep the handoff self-contained and focused on the next action.
- Prefer exact URLs and concrete validation criteria over long narrative context.
- Put concise background in `context`, not full diffs or log dumps unless they are essential.
