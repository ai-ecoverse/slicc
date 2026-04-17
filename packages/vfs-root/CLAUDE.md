# CLAUDE.md

This file covers the default virtual filesystem payload in `packages/vfs-root/`.

## What This Package Contains

`packages/vfs-root/` is copied into the app's virtual filesystem on init/reset. It is content, not runtime code.

## Directory Structure

| Path                                  | Purpose                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `packages/vfs-root/shared/`           | Shared content that becomes `/shared/` in the VFS                  |
| `packages/vfs-root/workspace/`        | Default workspace content that becomes `/workspace/` in the VFS    |
| `packages/vfs-root/shared/CLAUDE.md`  | Agent-facing runtime instructions bundled into `/shared/CLAUDE.md` |
| `packages/vfs-root/shared/sprinkles/` | Built-in sprinkle UIs                                              |
| `packages/vfs-root/shared/sounds/`    | Shared notification sounds                                         |
| `packages/vfs-root/workspace/skills/` | Default installable workspace skills                               |

## Adding Default Content

### Skills

- Add new built-in workspace skills under `packages/vfs-root/workspace/skills/<skill-name>/`.
- Include `SKILL.md` and any companion assets or `.jsh` scripts the skill needs.

### Sprinkles

- Add built-in sprinkles under `packages/vfs-root/shared/sprinkles/<name>/`.
- Keep the main file named `<name>.shtml` to match discovery and sprinkle naming conventions.

### Sounds

- Add shared sounds under `packages/vfs-root/shared/sounds/`.
- Prefer stable filenames because shell commands and docs may reference them directly.

## External Handoffs

- Mechanism: `x-slicc` response header on main-frame document responses → `navigate` lick → cone approval card.
- Agent-facing flow: `packages/vfs-root/workspace/skills/handoff/SKILL.md` (bundled to `/workspace/skills/handoff/SKILL.md`) and the trigger line in `shared/CLAUDE.md` (bundled to `/shared/CLAUDE.md`).
- Protocol reference: `docs/slicc-handoff.md`.
- When handoff behavior changes, keep the skill, `shared/CLAUDE.md`, and `docs/slicc-handoff.md` aligned — do not duplicate their content here.

## Important Distinction

`packages/vfs-root/shared/CLAUDE.md` is **agent-facing runtime content** bundled into the virtual filesystem.

It is different from the developer-facing `CLAUDE.md` files in the repository. Do not merge those roles together.
