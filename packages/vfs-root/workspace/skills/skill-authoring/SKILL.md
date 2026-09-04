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

SLICC discovers five kinds of skill roots:

| Root                                                         | Source                                       | Mutability                          |
| ------------------------------------------------------------ | -------------------------------------------- | ----------------------------------- |
| `/workspace/skills/<name>/SKILL.md`                          | Bundled or installed via `upskill`           | Install-managed; you can edit them  |
| `.agents/skills/<name>/SKILL.md` (anywhere)                  | Compatibility (Cursor / SuperClaude)         | Read-only (discovered, not managed) |
| `.claude/skills/<name>/SKILL.md` (anywhere)                  | Compatibility (Claude Code)                  | Read-only (discovered, not managed) |
| `<mount>/.claude-plugin/marketplace.json` → plugin `skills/` | Claude Code marketplace (mounted repos)      | Read-only (discovered, not managed) |
| `<plugin-root>/skills/<name>/SKILL.md`                       | Agent Plugins installed via `plugin install` | Read-only (discovered, not managed) |

Skills under `/workspace/skills/` installed with `upskill` carry a `.upskill` provenance record (source, ref, commit, file list) that `upskill update [--dry-run]` uses to refresh them. `upskill` never modifies or deletes a **dotfile** in a skill directory, so that is where a skill should keep its credentials and local state (`scripts/.config`) — everything else is replaced on update.

The marketplace root is auto-discovered: when a mounted directory contains `.claude-plugin/marketplace.json`, SLICC reads the manifest, resolves each plugin's `source` path, and discovers skills at `<plugin-source>/skills/<name>/SKILL.md`. No install step needed — mount the repo and the skills are live immediately. Agent Plugins (agent-plugins.org packages with a `plugin.json` manifest) require an explicit `plugin install <path|repo>` — `<repo>` may be a local directory or a GitHub reference (`owner/repo`, `owner/repo@branch`, or a `https://github.com/owner/repo[/tree/branch[/dir]]` URL, downloaded into `/workspace/.plugins/sources/`); their skills then surface automatically. Precedence: native > agents > claude > marketplace > plugin.

When you create a new skill **for SLICC**, put it in `/workspace/skills/<name>/`. The `.agents/`, `.claude/`, and marketplace paths exist so SLICC can pick up skills authored for other agents without modification — don't create new skills there.

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

`.jsh` files on the shell's `$PATH` search roots are auto-discovered as shell commands. **Full reference: `./jsh-runtime-extensions.md`.**

- **Auto-discovery**: registered as callable commands by filename (without the extension), from the `$PATH` roots — `/workspace/skills`, `/workspace/.mcp/aliases`, `/workspace/bin`, `/shared/bin` by default. A skill can ship its own commands by including a `.jsh` next to `SKILL.md`. Earlier roots win basename collisions, so `/workspace/skills/` wins. For commands elsewhere, add their dir to the PATH: `echo 'export PATH="$PATH:/my/tools"' >> ~/.profile`.
- **Dual-mode**: works in both the CLI server and the Chrome extension (sandbox iframe). Don't rely on CLI-only Node modules.
- **Top-level `await`**: scripts are wrapped in `AsyncFunction`, so `await` at the top level works. Prefer it — errors surface instead of becoming unhandled rejections. Fire-and-forget `.then()`, unawaited `main()`, and `setTimeout` also keep the realm alive: like Node, the process stays up while I/O (fs/exec/fetch) or timers are outstanding, and `process.exit()` skips the rest. A Promise with no handle (`new Promise(() => {})`) does **not** keep it alive.

#### Runtime surface (use these — don't reinvent)

Node-standard bare globals:

| Global                     | Use for                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process`                  | `argv`, `env`, `cwd()`, `exit(code)`, `stdout.write`, `stderr.write`; `stdin` is one-shot buffered (no streaming) — `read()`, events, or async iterator, drain once |
| `console`                  | `log`/`info` → stdout, `warn`/`error` → stderr                                                                                                                      |
| `fetch`                    | Standard `fetch` routed through SLICC's proxied transport (cookies + CORS handled).                                                                                 |
| `require(p)`               | Synchronous CJS `require`. Use `require('sliccy:<name>')` for capability bridges and `require('fs')` for the VFS bridge (see below).                                |
| `__dirname` / `__filename` | CJS scope vars — the script's own directory and absolute path.                                                                                                      |

Capability bridges via `require('sliccy:<name>')` (full reference: `./jsh-runtime-extensions.md`):

| `require('sliccy:<name>')`                    | Use for                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sliccy:exec`                                 | Callable `exec(cmd)` + `.spawn(argv[])`. Composes with any supplemental command or `.jsh` script.                                                                                                                   |
| `sliccy:agent`                                | Callable `agent(prompt, opts?)` → sub-scoop final text (parsed when `schema` set) + `.spawn(...)` → `{ finalText, exitCode, stderr }`. `opts`: `model`, `thinking`, `cwd`, `allowedCommands`, `readOnly`, `schema`. |
| `sliccy:skill`                                | `dir` / `root` / `refs` / `assets` / `config()` / `token(providerId)` — skill-root `references/` and `assets/`, script-dir `.config`, provider tokens.                                                              |
| `sliccy:http`                                 | `http.client({ baseUrl, token, headers, retry, timeoutMs })` — standard API-client builder.                                                                                                                         |
| `sliccy:browser`                              | `findTab`, `ensureTab`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`, `websocket.on(...)`.                                                                                                                |
| `sliccy:usb` / `sliccy:serial` / `sliccy:hid` | `list()` / `request()` + device methods. Chromium-only.                                                                                                                                                             |
| `sliccy:cli`                                  | `die(msg, opts?)`, `out(value)`, `warn(msg, opts?)`, `help(text)`.                                                                                                                                                  |
| `sliccy:color`                                | ANSI helpers (`green`, `red`, `bold`, `dim`, …) auto-disabled on non-TTY / `NO_COLOR`.                                                                                                                              |
| `sliccy:time`                                 | `parseDuration`, `ago`, `range`, `future`, `gmailDate`.                                                                                                                                                             |
| `sliccy:fmt`                                  | `trunc`, `col`, `table`, `date`.                                                                                                                                                                                    |
| `sliccy:pool`                                 | `pool(n, items, fn)` — bounded concurrency runner.                                                                                                                                                                  |

VFS bridge:

| `require('fs')` / `require('node:fs')` | `readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile` — all paths are VFS, async. There is no bare `fs` global. |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

#### Runtime extensions (live — prefer these over hand-rolled equivalents)

Reach these via `require('sliccy:<name>')`. Full reference: `./jsh-runtime-extensions.md`. Use them instead of reimplementing the cross-skill patterns they replace.

- **`process.argv.parseFlags()`** — returns `{ positional, flags, subcommand }`. Replaces the per-skill `--flag=val` / `--flag val` parsing loop.
- **`require('sliccy:browser')`** — `findTab({ domain | urlMatch })`, `ensureTab(url)`, `eval(tab, fn)`, `evalAsync(tab, fn)`, `cookie(tab, name)`, `localStorage(tab, key)`. Replaces shelling out to `playwright-cli tab-list` and regex-parsing its output.
- **`browser.fetch(tab, url, opts)`** — page-context fetch (runs inside the tab's origin, so cookies + same-origin headers are automatic). Replaces the `eval-file` temp-file + double-JSON-unwrap dance.
- **`browser.websocket.on(tab, …).filter({…}).forward({ sink })`** — declarative WebSocket observer with a closed sink set (`webhook` / `scoop` / `vfs` / `log`). **Required** for any new WS-watch use case; do not author page-context `WebSocket.prototype` patches in skill code.
- **`require('sliccy:http').client({ baseUrl, token, headers, retry })`** — `get`/`post`/`put`/`delete` with merged headers, lazy token resolution, and Retry-After-aware backoff for `retry.on` statuses.
- **`require('sliccy:skill')`** — `dir` / `root` / `refs` / `assets` / `config()` / `token(providerId)`: replace the per-skill `process.argv[1]` dirname math, ad-hoc `.config` JSON readers, and bespoke `oauth-token` shell-outs. `refs`/`assets` resolve from the skill root (parent of `scripts/` when the script lives there).

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
