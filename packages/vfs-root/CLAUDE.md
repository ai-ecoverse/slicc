# CLAUDE.md

This file covers the default virtual filesystem payload in `packages/vfs-root/`.

## What This Package Contains

`packages/vfs-root/` is copied into the app's virtual filesystem on init/reset. It is content, not runtime code.

## Directory Structure

| Path                                  | Purpose                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/vfs-root/shared/`           | Shared content that becomes `/shared/` in the VFS                                          |
| `packages/vfs-root/workspace/`        | Default workspace content that becomes `/workspace/` in the VFS                            |
| `packages/vfs-root/shared/CLAUDE.md`  | Agent-facing runtime instructions bundled into `/shared/CLAUDE.md`                         |
| `packages/vfs-root/shared/MEMORY.md`  | User-editable memory curator config bundled as `/shared/MEMORY.md`                         |
| `packages/vfs-root/shared/sprinkles/` | Built-in sprinkle UIs                                                                      |
| `packages/vfs-root/shared/sounds/`    | Shared notification sounds                                                                 |
| `packages/vfs-root/workspace/skills/` | Default installable workspace skills                                                       |
| `packages/vfs-root/etc/`              | System config seeded into `/etc/` (`models`, `sudoers`, `APPROVALS.md`, `slicc/keys.json`) |

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
- The curator may rewrite the entire memory file, and the hard character budget
  applies to the entire file with no protected region.
- **The curator edits a staged draft, never the live file.** `{{MEMORY_PATH}}` resolves to
  `/sessions/.curation/<archive>/draft.md`, seeded (with a `base.md` snapshot) from the live
  memory when the pass spawns; the agent bridge three-way-merges base→draft onto the live file
  on exit 0, before the success receipt (`mergeOnSuccess`). Concurrent live edits survive;
  conflicting regions resolve to the curator. A killed or failed run leaves the live memory
  untouched. The bridge also writes `/sessions/.curation/<archive>/status.json` on both exit
  paths (`outcomeReceiptPath`) — the durable ledger of which sessions completed vs failed
  curation; the index entry mirrors it as `memoryCuratedAt` / `memoryFailed`. Per-archive
  keying means parallel per-cone curators (#1666) never share staging state.
- Every `##`/`###` memory section ends with a `YYYY-MM-DD` last-verified date, in UTC to match
  archive timestamps. Each pass re-verifies the oldest sections first; undated sections are
  maximally stale.
- The curator's write grant is `/workspace/CLAUDE.md` alone, not `/workspace/`. It can run `upskill`
  to look up a skill for a pitfall it found, and a directory-wide grant would also let it install
  into `/workspace/skills/`. Reads still cover `/workspace/`. Single-file entries in
  `writablePaths` work because `generateScoopSudoers` emits both the bare path and the `/**` form.
- The pass is detached, so it spawns with `notifyOnComplete`. Its closing message reaches the cone
  on the `scoop-notify` channel; that is where a skill suggestion lands. Without it the report is
  discarded and the cone never learns the pass ran.
- Turn count is what a pass costs, because every turn re-reads the whole context as a cache read.
  Two things keep it down, and both belong to the prompt rather than the runtime: `thinkingLevel`
  (default `medium`; spawned agents otherwise resolve to `off`) so the curator plans the cut
  instead of converging by trial and error, and the archive reading recipes so it never `cat`s a
  multi-megabyte archive whose `slicc:session-data` block is a single line holding half the file.

### Approver agent

- `etc/APPROVALS.md` is the single source for the runner's build-time fallback and
  the seeded `/etc/APPROVALS.md`, exactly like `shared/MEMORY.md` is for the curator.
  `SudoManager.ensureDefaults()` does the seeding, when absent, on the ungated
  handle — the same place `/etc/sudoers` is seeded, and for the same reason: the
  file is self-protected, so anything else that had to create it (the `upgrade
apply` merge) would prompt the owner to approve the default already in force (#2686).
- It lives in `/etc/` because it is POLICY, next to `sudoers` — not in `/shared/`,
  which is agent-visible content. Writes to it are self-protected in
  `base/sudoers.ts` (`isSelfProtectedWrite`) for the same reason writes to
  `/etc/sudoers` are: it decides what a GUEST may do, and a cone acting on a
  guest's message must not rewrite the rules gating that guest without the owner
  seeing a prompt.
- Re-read on EVERY decision, not cached: an owner who tightens it after a bad
  call expects the next decision to use it. Missing or unreadable falls back to
  the bundled default rather than wedging approvals shut.
- The optional ```yaml block tunes `timeoutSeconds` (clamped — a guest, and for
  a tool gate the cone's turn, is blocked on the decision), `model`, and
  `thinkingLevel`. Unreadable values fall back rather than becoming real.
- The approver never reads this file itself; the runtime reads it and puts it in
  the prompt. The agent holds no write grant at all.

### Skills

- Add new built-in workspace skills under `packages/vfs-root/workspace/skills/<skill-name>/`.
- Include `SKILL.md` and any companion assets or `.jsh` scripts the skill needs.

### Keyboard shortcuts

- `etc/slicc/keys.json` is the user's OVERRIDE file for keyboard mode, seeded on first boot by
  `ui/wc/wc-shortcut-config.ts`. It ships with `"bindings": {}` — the keymap itself is
  `DEFAULT_KEYMAP` in `ui/wc/wc-shortcuts.ts`, and a test asserts the file binds nothing.
- **Never list a binding here again.** v1 wrote its whole keymap into the seed, and because the
  file is applied OVER the defaults that pinned every install to v1 forever: no later map, and no
  key for any command added since, could reach anyone who had booted once. An empty file is what
  makes the shipped map — and every future change to it — inheritable.
- The one write beyond seeding is that migration: a file still holding the v1 map exactly
  (`isUntouchedV1Document`) is replaced once. Anything else, including v1 with one line changed,
  is the user's and is left alone — an edited config must survive every later boot.
- The `//` comment must name every `CommandId` (a test asserts it) and carries the v1 keymap as a
  paste-back block for anyone who wants the old keys. `s` maps to `sprinkles` there, not to a
  cycle command: `p`/`s` opens the first and the step keys walk the rest.

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
