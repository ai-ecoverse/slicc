---
name: skill-authoring
description: |
  Use this when the user wants to write a new skill, edit an existing one, or
  understand SLICC's skill system. Covers SKILL.md frontmatter (name,
  description, allowed-tools), how to write a description that triggers
  reliably, native `/workspace/skills/` vs compatibility `.agents/` /
  `.claude/skills/` discovery, and when to ship companion files like `.jsh`
  scripts or `.bsh` browser hooks.
allowed-tools: bash, read_file, write_file, edit_file
---

# Skill authoring

A skill is a folder with a `SKILL.md` (and optional companion files) that loads into the agent's system prompt when the description matches the user's intent. This skill is about authoring those folders well.

## Discovery

SLICC discovers three kinds of skill roots:

| Root                                        | Source                               | Mutability                          |
| ------------------------------------------- | ------------------------------------ | ----------------------------------- |
| `/workspace/skills/<name>/SKILL.md`         | Bundled or installed via `upskill`   | Install-managed; you can edit them  |
| `.agents/skills/<name>/SKILL.md` (anywhere) | Compatibility (Cursor / SuperClaude) | Read-only (discovered, not managed) |
| `.claude/skills/<name>/SKILL.md` (anywhere) | Compatibility (Claude Code)          | Read-only (discovered, not managed) |

When you create a new skill **for SLICC**, put it in `/workspace/skills/<name>/`. The `.agents/` and `.claude/` paths exist so SLICC can pick up skills authored for other agents without modification — don't create new skills there.

## SKILL.md structure

```markdown
---
name: <slug>
description: |
  Use this when ...
  ... (1–3 sentences explaining trigger conditions, what's covered, and what's
  NOT covered if there's a sibling skill that handles related topics.)
allowed-tools: bash, read_file, write_file, edit_file
---

# Title (matches `name`)

... body ...
```

### Frontmatter fields

- **`name`** — lowercase, kebab-case. Must match the folder name. This is what `skill list` shows.
- **`description`** — the trigger string. The agent uses this to decide whether to load the skill. Get this right; everything else is secondary.
- **`allowed-tools`** — comma-separated list of tools the skill needs. Without this, the agent may load the skill but find it can't execute the steps. Common values:
  - `bash` — almost every skill.
  - `read_file, write_file, edit_file` — for skills that author files (sprinkles, config edits, three-way merges).
  - Omit only for purely informational skills.

### Writing a good description

The description is a trigger, not a summary. It runs through the agent at every turn — too vague and the skill loads when irrelevant; too narrow and it doesn't load when needed.

**Pattern that works**: "Use this when \<user-facing trigger\>. Covers \<topics\>. \[For \<adjacent topic\> use \<sibling skill\>.\]"

Compare:

- ❌ `description: Licks, webhooks, cron tasks, viewing pages/images, screencapture, onboarding`
  Keyword soup. The agent has to guess what "licks" or "screencapture" mean for this user.
- ✅ `description: Use this when setting up event-driven automation in SLICC — webhooks, cron tasks, or filesystem watchers that route events to scoops. Covers webhook, crontask, and fswatch. Read this BEFORE wiring anything that should fire on a schedule, an HTTP call, or a VFS change.`
  Names the user intent ("setting up event-driven automation"), names the commands the agent will reach for, and tells the agent when to load it.

Rules of thumb:

- Lead with **"Use this when..."** or **"Use this whenever..."**.
- Name the **user-facing trigger** (what the user said), not just the implementation.
- If there's a closely-named sibling skill (dips vs sprinkles, mount vs other storage), say which is which inside the description so the agent doesn't load both.
- Multi-line YAML scalars are fine for longer descriptions — use the `|` block style.

## Body conventions

- Lead with one sentence stating what the skill is. No preamble.
- Use tables for option matrices (commands × flags, tradeoffs, etc.).
- Code blocks are bash unless otherwise needed.
- Include a "Don't" or "Common errors" section near the end if the skill is failure-prone — the agent will read it before acting.
- If the skill is large (> ~150 lines), split a reference table or example gallery into a companion `<topic>.md` and have the SKILL.md `read_file` it on demand. The `sprinkles/` skill (style-guide.md) and `dips/` skill (patterns.md) follow this pattern.

## Companion files

### `.jsh` — JavaScript shell scripts

`.jsh` files are auto-discovered as shell commands anywhere on the VFS:

- **Auto-discovery**: registered as callable commands by filename (without the extension). A skill can ship its own commands by including a `.jsh` next to `SKILL.md`.
- **Node-like globals**: `process`, `console`, `fs` — a VFS bridge with `readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile`.
- **Dual-mode**: works in both the CLI server and the Chrome extension.
- **Top-level `await`**: scripts are wrapped in `AsyncFunction`. Always `await` fs methods. Don't use `.then()`.

Ship a `.jsh` when the skill needs deterministic, parameterizable behavior the agent shouldn't have to re-derive each time (e.g. a `slicc-handoff` helper, a custom diff formatter, a domain-specific lint).

### `.bsh` — browser shell scripts

`.bsh` files auto-execute when the browser navigates to a matching URL:

- **Filename = hostname pattern**: `-.okta.com.bsh` matches `*.okta.com`.
- **`// @match` directive**: restrict to specific URL patterns in the first 10 lines.
- Same execution engine as `.jsh`.

Use `.bsh` for site-specific automations — auto-fillers, lick-emitters, or page transforms that should run whenever the user lands on a particular host.

## Filesystem at a glance

The VFS is stored in IndexedDB; it survives tab closes and refreshes. The `mount` shell command bridges remote storage (local folders, S3-compatible, Adobe DA) into VFS paths — see `/workspace/skills/mount/SKILL.md`.

The VFS supports symbolic links transparently:

```bash
ln -s /workspace/skills /workspace/skill-link    # Create symlink
readlink /workspace/skill-link                    # Read link target
ls -la /workspace/                                # Shows symlinks with -> target
```

`cat`, `read_file`, `write_file` etc. follow symlinks automatically.

**Mount points must be empty.** Mounting over existing files is blocked so built-in skills and scripts stay discoverable. `ln -s` mounted files into the place where you need them.

## Don't

- Don't ship a skill without a description that starts with "Use this when..." — the trigger field IS the skill from the agent's perspective.
- Don't put `name:` in Title Case. Lowercase kebab-case. Match the folder.
- Don't dump shell-command catalogs into a SKILL.md just because they're related — `commands` already lists them. Skills are for **patterns and policy**, not reference material.
- Don't author skills under `.agents/skills/` or `.claude/skills/`. Those roots are for compatibility discovery from other agents.
