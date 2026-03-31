---
name: Skill Authoring
description: Skills discovery, .jsh/.bsh files, shell commands, filesystem
---

# Skill Authoring & Shell Reference

## Skills

Skills in `/workspace/skills/` extend capabilities. SLICC also discovers compatibility skills from `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` anywhere in the reachable VFS. Only native `/workspace/skills/` entries are install-managed; compatibility-discovered skills stay read-only.

## .jsh Files (JavaScript Shell Scripts)

`.jsh` files are auto-discovered as shell commands anywhere on the VFS:

- **Auto-discovery**: registered as callable commands (by filename without extension)
- **Skills can ship them**: executable `.jsh` scripts live alongside SKILL.md
- **Node-like globals**: `process`, `console`, `fs` (VFS bridge with `readFile`, `writeFile`, `readDir`, `exists`)
- **Dual-mode**: work in CLI server and Chrome extension
- **Top-level `await`**: wrapped in AsyncFunction. Always `await` fs methods. Don't use `.then()`.

## .bsh Files (Browser Shell Scripts)

`.bsh` files auto-execute when the browser navigates to a matching URL:

- **Filename = hostname pattern**: `-.okta.com.bsh` matches `*.okta.com`
- **`// @match` directive**: restrict to specific URL patterns in first 10 lines
- Same execution engine as `.jsh`

## Shell Commands

Type `commands` in the terminal for the full list. Key commands:

- **skill list/info/read** — inspect skills; `skill install/uninstall` manages native packages
- **upskill** — install from GitHub (`upskill owner/repo`) or ClawHub (`upskill clawhub:name`)
- **webhook/crontask** — set up licks (external event triggers)
- **sprinkle** — manage sprinkles: `list`, `open`, `close`, `send`, `chat`
- **oauth-token** — get OAuth access token for a provider
- **git** — full git support
- **node -e / python3 -c** — execute JS or Python
- **serve <dir>** — open VFS app directory in browser tab
- **open <path|url>** — open file/URL in browser. `open --view` to see images inline
- **playwright-cli** — browser automation (tab-list, tab-new, snapshot, screenshot, click, fill, tab-close)
- **pbcopy/pbpaste/xclip/xsel** — clipboard
- **say** — text-to-speech
- **afplay** — play audio files
- **chime** — notification sound
- **rsync** — sync files between local VFS and remote tray runtime
- **teleport** — transfer browser cookies from remote tray runtime
- **host** — tray status and join URL

## Filesystem

Virtual filesystem stored in IndexedDB, survives tab closes and refreshes. Mount local directories:

```
mount /workspace/myproject
```

## Capabilities

- Read/write files in virtual workspace
- Run bash commands in sandboxed shell
- Automate browser interactions (screenshots, navigation, clicking, JS eval)
- Delegate work to scoops and react when they finish
- Respond to licks (webhooks, scheduled tasks)
