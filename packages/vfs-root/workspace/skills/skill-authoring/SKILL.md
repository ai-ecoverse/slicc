---
name: skill-authoring
description: |
  Use this when the user wants to write a new skill, edit an existing one, or
  understand SLICC's skill system. Covers SKILL.md frontmatter (name,
  description, allowed-tools), how to write a description that triggers
  reliably, native `/workspace/skills/` vs compatibility `.agents/` /
  `.claude/skills/` discovery, and when to ship companion files like `.jsh`
  scripts or `.bsh` browser hooks.
allowed-tools: bash, read_file, write_file, edit
---

# Skill authoring

A skill is a folder with `SKILL.md` (plus optional companions) loaded when the description matches user intent.

## Discovery

| Root                                                  | Source                      | Mutability                |
| ----------------------------------------------------- | --------------------------- | ------------------------- |
| `/workspace/skills/<name>/SKILL.md`                   | Bundled or `upskill`        | Install-managed; editable |
| `.agents/skills/<name>/SKILL.md`                      | Cursor / SuperClaude compat | Read-only                 |
| `.claude/skills/<name>/SKILL.md`                      | Claude Code compat          | Read-only                 |
| `<mount>/.claude-plugin/marketplace.json` → `skills/` | Marketplace (mounted repos) | Read-only                 |
| `<plugin-root>/skills/<name>/SKILL.md`                | `plugin install`            | Read-only                 |

`upskill` installs carry `.upskill` provenance (source, ref, commit, file list) that `upskill list --outdated` and `upskill update [--dry-run]` use. `upskill` never modifies dotfiles in a skill directory — keep credentials and local state in `scripts/.config`; everything else is replaced on update.

Marketplace root auto-discovered: mounted directory with `.claude-plugin/marketplace.json` → skills at `<plugin-source>/skills/<name>/SKILL.md`, no install step. Agent Plugins (`plugin.json` manifest): `plugin install <path|repo>` — local dir, `owner/repo`, `owner/repo@branch`, or `https://github.com/owner/repo[/tree/branch[/dir]]` → `/workspace/.plugins/sources/`.

Precedence: native > agents > claude > marketplace > plugin.

**Create new skills in `/workspace/skills/<name>/` only.**

## SKILL.md structure

```markdown
---
name: <slug>
description: |
  Use this when ...
allowed-tools: bash, read_file, write_file, edit
---

# Title
```

### Frontmatter

- **`name`** — lowercase kebab-case; must match folder name. Shown by `skill list`.
- **`description`** — the trigger. Too vague → loads when irrelevant; too narrow → misses when needed. Pattern: "Use this when \<trigger\>. Covers \<topics\>. \[For \<adjacent\> use \<sibling\>.\]"
- **`allowed-tools`** — comma-separated tools the skill needs. Without this, the agent may load but can't execute. `bash` almost always; `read_file, write_file, edit` for file authoring; omit only for purely informational skills.

Compare:

- ❌ `Licks, webhooks, cron tasks, viewing pages/images, screencapture`
- ✅ `Use this when setting up event-driven automation — webhooks, cron, fswatch. Read BEFORE wiring schedules, HTTP calls, or VFS changes.`

Multi-line `|` block style is fine for longer descriptions.

## Body conventions

- One-sentence lead. Tables for option matrices. Bash code blocks.
- "Don't" / "Common errors" for failure-prone skills.
- Large skills (>~150 lines): split reference into companion `<topic>.md` (see `sprinkles/style-guide.md`, `dips/patterns.md`).

## Companion files

### `.jsh` — JavaScript shell scripts

**Full reference: `./jsh-runtime-extensions.md`.**

- Auto-discovered by filename (no extension) from `$PATH` roots: `/workspace/skills`, `/workspace/.mcp/aliases`, `/workspace/bin`, `/shared/bin`. Earlier roots win collisions. Among skills in same root: `.upskill` provenance > newer `installed` timestamp > first scan — `skill list` / `which` name the loser. Extend PATH: `echo 'export PATH="$PATH:/my/tools"' >> ~/.profile`.
- Direct: `jsh /tmp/tool.jsh [args…]` — Node shim with `sliccy:` resolution; `process.argv[0]` stays `node` for compatibility.
- Dual-mode: CLI server + Chrome extension (sandbox iframe). Don't rely on CLI-only Node modules.
- Top-level `await` via `AsyncFunction`. Fire-and-forget `.then()`, unawaited `main()`, `setTimeout`, `await fetch().json()` keep realm alive while I/O/timers outstanding. `process.exit()` skips rest. `node --check` / `-c` syntax-checks without executing (top-level `await` and ESM valid).

#### Runtime surface

Node globals: `process` (`argv`, `.parseFlags()`, `env`, `cwd()`, `exit`, `exitCode`, `stdout`/`stderr`; `stdin` one-shot buffered), `console`, `fetch` (proxied), `require(p)`, `__dirname`/`__filename`.

| `require('sliccy:<name>')`  | Use for                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sliccy:exec`               | `exec(cmd)` + `.spawn(argv[])`                                                                                                                       |
| `sliccy:agent`              | `agent(prompt, opts?)` + `.spawn(...)`                                                                                                               |
| `sliccy:skill`              | `dir`/`root`/`refs`/`assets`/`config()`/`token(providerId)`                                                                                          |
| `sliccy:http`               | `http.client({ baseUrl, token, headers, retry, timeoutMs })`                                                                                         |
| `sliccy:browser`            | `findTab`, `ensureTab`, `openWindow`, `windowBounds`, `setWindowBounds`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`, `websocket.on(...)` |
| `sliccy:usb`/`serial`/`hid` | `list()`/`request()` + device methods (Chromium-only)                                                                                                |
| `sliccy:computer`           | `register(handlers)` — jsh computer backend                                                                                                          |
| `sliccy:cli`                | `die`, `out`, `warn`, `help`                                                                                                                         |
| `sliccy:color`              | ANSI helpers (auto-disabled non-TTY / `NO_COLOR`)                                                                                                    |
| `sliccy:time`               | `parseDuration`, `ago`, `range`, `future`, `gmailDate`                                                                                               |
| `sliccy:fmt`                | `trunc`, `col`, `table`, `date`                                                                                                                      |
| `sliccy:pool`               | `pool(n, items, fn)`                                                                                                                                 |

VFS: `require('fs')` / `require('node:fs')` — `readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `appendFile`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile`. No bare `fs` global.

#### Runtime extensions (prefer over hand-rolled)

- `process.argv.parseFlags()` → `{ positional, flags, subcommand, passthrough }`
- `require('sliccy:browser')` — replaces `playwright-cli tab-list` shell-outs
- `browser.fetch(tab, url, opts)` — page-context fetch (cookies automatic)
- `browser.websocket.on(tab, …).filter({…}).forward({ sink })` — **required** for WS-watch; no prototype patches
- `require('sliccy:http').client({…})` — Retry-After-aware API client
- `require('sliccy:skill')` — replaces `argv[1]` dirname math and `oauth-token` shell-outs
- `require('sliccy:computer').register(handlers)` — jsh computer backend

Full reference: `./jsh-runtime-extensions.md`.

Ship `.jsh` for deterministic behavior the agent shouldn't re-derive (handoff helper, diff formatter, domain lint).

### `.bsh` — browser shell scripts

Auto-execute on navigation. Filename = hostname pattern (`-.okta.com.bsh` → `*.okta.com`). `// @match` in first 10 lines. Same engine as `.jsh`.

## Filesystem

VFS in IndexedDB; survives tab closes. `mount` bridges remote storage — see `/workspace/skills/mount/SKILL.md`.

```bash
ln -s /workspace/skills /workspace/skill-link
readlink /workspace/skill-link
ls -la /workspace/    # shows -> target
```

`cat`, `read_file`, `write_file` follow symlinks. **Mount points must be empty** (blocks mounting over built-ins). `ln -s /mnt/… /shared/x` works (link on VFS → mount). A link _on_ a mount is `EINVAL` (no symlink inode).

## Don't

- Don't ship without a description starting "Use this when…" — the trigger field IS the skill from the agent's perspective.
- Don't put `name:` in Title Case. Lowercase kebab-case. Match the folder.
- Don't dump shell-command catalogs into SKILL.md just because they're related — `commands` already lists them. Skills are for **patterns and policy**, not reference material.
- Don't author skills under `.agents/skills/` or `.claude/skills/`. Those roots are for compatibility discovery from other agents.
