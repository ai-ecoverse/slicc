# CLAUDE.md

This file covers the documentation surface in `docs/`.

## Documentation Tiers

| Tier            | Primary file/location              | Purpose                                                            |
| --------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Public          | `README.md`                        | User-facing overview and onboarding                                |
| Development     | root and package `CLAUDE.md` files | High-signal developer guidance and package navigation              |
| Agent reference | `docs/`                            | Detailed architecture, commands, patterns, pitfalls, and workflows |

## How to Update Docs

- Update the nearest package `CLAUDE.md` when a change is package-specific.
- Update the root `CLAUDE.md` only for repo-wide navigation, CI gates, or cross-cutting principles.
- Put long-form implementation detail in the appropriate `docs/*.md` file rather than bloating a `CLAUDE.md`.

## Common Destinations in `docs/`

- `architecture.md` — detailed subsystem/file maps
- `development.md` — build, run, and debug workflows
- `shell-reference.md` — shell command reference
- `testing.md` — testing patterns and command selection
- `tools-reference.md` — tool/reference behavior
- `pitfalls.md` — runtime and extension gotchas

Keep this directory explanatory, not redundant: prefer one authoritative page per topic and link to it from the shorter `CLAUDE.md` files.
