---
name: slicc-handoff
description: Create a generic SLICC handoff when the user wants work moved to the SLICC agent, continued in SLICC, or tested in SLICC. Prefer the repo wrapper command and keep the payload concise, browser-aware, and self-contained.
---

# SLICC Handoff

Use this skill when the user wants the SLICC agent to continue the task instead of the current local coding agent.

Typical trigger phrases:

- `handoff to slicc`
- `move this to slicc`
- `continue this in slicc`
- `test this in slicc`

## Workflow

1. Build a compact handoff payload.
2. Run the bundled helper at `scripts/slicc-handoff` from this skill package.
3. Return the resulting handoff URL to the user.

## Payload

Required:

- `instruction`

Optional:

- `title`
- `urls`
- `context`
- `acceptanceCriteria`
- `notes`
- `openUrlsFirst`

Assume SLICC has browser/session context, not repo access, unless the user explicitly says otherwise.

## Guidance

- Keep `instruction` focused on the next thing SLICC should do.
- Include exact URLs when browser work is needed.
- Put concise background in `context`.
- Use `acceptanceCriteria` for pass/fail checks.
- Only set `openUrlsFirst` when the URLs should open before the cone starts work.

For examples and field definitions, read:

- `../../../docs/slicc-handoff.md`
- `../../../docs/schemas/slicc-handoff.schema.json`
