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
| `packages/vfs-root/shared/MEMORY.md`  | User-editable memory curator config bundled as `/shared/MEMORY.md` |
| `packages/vfs-root/shared/sprinkles/` | Built-in sprinkle UIs                                              |
| `packages/vfs-root/shared/sounds/`    | Shared notification sounds                                         |
| `packages/vfs-root/workspace/skills/` | Default installable workspace skills                               |

## Adding Default Content

### Memory curator

- `shared/MEMORY.md` is the single source for the runner's build-time fallback and the seeded
  `/shared/MEMORY.md` file.
- The file is seeded only when absent, so user and skill customizations survive later boots.
- `MEMORY.md` is user-edited only; the curator intentionally cannot rewrite its own instructions.
- Frontmatter uses a strict YAML subset: block-array items may have `#` comment tails; inline
  entries containing commas must be quoted. A bare `/` is rejected from `writablePaths`.
- Frontmatter `allowedCommands` entries extend the curator's built-in base set; they do not
  replace or remove base commands.

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

- Mechanism: RFC 8288 `Link` response header carrying `https://www.sliccy.ai/rel/handoff` or `https://www.sliccy.ai/rel/upskill` on a main-frame document response → `navigate` lick → cone approval card.
- Agent-facing flow: `packages/vfs-root/workspace/skills/handoff/SKILL.md` (bundled to `/workspace/skills/handoff/SKILL.md`) and the trigger line in `shared/CLAUDE.md` (bundled to `/shared/CLAUDE.md`).
- Protocol reference: `docs/slicc-handoff.md`.
- When handoff behavior changes, keep the skill, `shared/CLAUDE.md`, and `docs/slicc-handoff.md` aligned — do not duplicate their content here.

## Important Distinction

`packages/vfs-root/shared/CLAUDE.md` is **agent-facing runtime content** bundled into the virtual filesystem.

It is different from the developer-facing `CLAUDE.md` files in the repository. Do not merge those roles together.
