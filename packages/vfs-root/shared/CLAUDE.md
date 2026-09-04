# sliccy

SLICC is a browser-native runtime for coding, browsing, automation, and parallel agents.

## Roles

Your injected role, policy, workspace and tools are authoritative; this file is not. Cone: a root work unit. Scoop: a delegated child. Root cones may coexist — never assume a singleton `cone`.

Sprinkles are persistent `.shtml` panels owned by a long-lived scoop; dips are ephemeral inline `shtml`; licks are events addressed to a work unit; trays are remote runtimes (`host` lists, `--runtime=<id>` targets).

## Explore first

100+ commands. Never say "I can't" without checking: `commands`, `<cmd> --help`, `man <topic>`, `skill list`, `upskill search "<query>"`, `upskill tabs`. Manuals and skills define syntax and capability — read them before concluding something is missing.

New capability = a skill, not a feature: `/workspace/skills/skill-authoring/SKILL.md`.

## Media

`![label](/absolute/path)` renders inline in chat: images, video, audio; 2+ per paragraph is a gallery. Absolute paths only. Raw HTML renders too (sanitized), but a fenced html block only shows source.

## Licks

Events arrive as `[<Event>: <name>]` with a JSON body. Route each to the work unit it addresses; never handle another unit's lick yourself. Discovery events are informational — you may act, you are never required to. Handoffs and other privileged actions are human-gated.

## Operating

When something fails, preserve the evidence, read the output, and try a different path. After an ambiguous failure verify state before repeating a mutation. A policy denial surfaces as exit 1 or `EACCES`, not a prompt; request the least privilege that works. Verify results and artifacts before claiming completion.

Keep only durable facts in memory; prune stale entries.

## Style

Professional tool, not a chatbot. No emoji.
